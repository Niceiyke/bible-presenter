//! wgpu compositor (Phase B2) — renders a resolved `ProgramFrame` into an
//! offscreen RGBA texture.
//!
//! The compositor is a pure consumer of the resolver's output: it takes a
//! `ProgramFrame` plus a `MediaResolver` (image bytes by path) and paints
//! layers in z-order into a GPU texture. Pixel readback (`read_pixels`) powers
//! the fixture-parity harness (Phase B3) and the engine's capture path later.
//!
//! The DOM renderers (`OutputWindow`/`StageWindow`) stay the parity oracle
//! until B3 proves the wgpu output matches them.

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use glyphon::{
    Attrs, Buffer, Cache, Color as GlyphColor, Family, FontSystem, Metrics, Resolution, Shaping,
    SwashCache, TextArea, TextAtlas, TextRenderer, Viewport,
};
use wgpu::util::DeviceExt;

use super::frame::{ProgramFrame, ProgramLayer};
use super::lower_third::resolve_lower_third;
use crate::store::{
    BackgroundSetting, DisplayItem, ImageBackground, PropItem, SceneZone,
};

/// Decoded RGBA image for the compositor.
#[derive(Debug, Clone)]
pub struct ImageData {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Supplies media bytes to the compositor by path. The engine host resolves
/// persisted (relativized) paths against its app data dir; tests use an
/// in-memory map.
pub trait MediaResolver {
    fn load_image(&mut self, path: &str) -> Option<ImageData>;
    /// Latest decoded frame for a playing video asset (Phase H). `None` means
    /// no decoder is running or the last attempt failed — callers paint the
    /// safe missing-media fallback instead.
    fn load_video_frame(&mut self, _path: &str) -> Option<super::media::VideoFrame> {
        None
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct QuadVertex {
    pos: [f32; 2],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SolidUniform {
    rect: [f32; 4],
    color: [f32; 4],
    screen: [f32; 2],
    radius: f32,
    // WGSL uniform structs pad to 16-byte alignment: the shader's Uniforms
    // block is 48 bytes, so match it here.
    _pad: [f32; 1],
}

const SOLID_VERTICES: &[QuadVertex] = &[
    QuadVertex { pos: [0.0, 0.0], uv: [0.0, 0.0] },
    QuadVertex { pos: [1.0, 0.0], uv: [1.0, 0.0] },
    QuadVertex { pos: [0.0, 1.0], uv: [0.0, 1.0] },
    QuadVertex { pos: [1.0, 1.0], uv: [1.0, 1.0] },
];

const SOLID_INDICES: &[u16] = &[0, 1, 2, 1, 3, 2];

const SOLID_SHADER: &str = r#"
struct Uniforms {
    rect: vec4<f32>,
    color: vec4<f32>,
    screen: vec2<f32>,
    radius: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
    let p = vec2f(u.rect.x + pos.x * u.rect.z, u.rect.y + pos.y * u.rect.w);
    let ndc = vec2f(p.x / u.screen.x * 2.0 - 1.0, 1.0 - p.y / u.screen.y * 2.0);
    return VSOut(vec4f(ndc, 0.0, 1.0), uv);
}

fn rounded_alpha(uv: vec2f, size: vec2f, radius: f32) -> f32 {
    let half = size * 0.5;
    let q = abs(uv * size - half) - half + vec2f(radius, radius);
    let d = length(max(q, vec2f(0.0))) - radius;
    return 1.0 - smoothstep(0.0, 1.0, d);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let a = rounded_alpha(uv, u.rect.zw, u.radius) * u.color.a;
    return vec4f(u.color.rgb, a);
}
"#;

const TEX_SHADER: &str = r#"
struct Uniforms {
    rect: vec4<f32>,
    color: vec4<f32>,
    screen: vec2<f32>,
    radius: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
    let p = vec2f(u.rect.x + pos.x * u.rect.z, u.rect.y + pos.y * u.rect.w);
    let ndc = vec2f(p.x / u.screen.x * 2.0 - 1.0, 1.0 - p.y / u.screen.y * 2.0);
    return VSOut(vec4f(ndc, 0.0, 1.0), uv);
}

fn rounded_alpha(uv: vec2f, size: vec2f, radius: f32) -> f32 {
    let half = size * 0.5;
    let q = abs(uv * size - half) - half + vec2f(radius, radius);
    let d = length(max(q, vec2f(0.0))) - radius;
    return 1.0 - smoothstep(0.0, 1.0, d);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let texel = textureSample(tex, samp, uv);
    let a = rounded_alpha(uv, u.rect.zw, u.radius) * texel.a * u.color.a;
    return vec4f(texel.rgb * u.color.rgb, a);
}
"#;

/// The wgpu compositor. Owns the GPU device, target texture, glyph renderer,
/// and image cache for one render surface (the output canvas).
pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    target: wgpu::Texture,
    target_view: wgpu::TextureView,
    solid_pipeline: wgpu::RenderPipeline,
    tex_pipeline: wgpu::RenderPipeline,
    solid_bind_group: wgpu::BindGroup,
    uniform_buf: wgpu::Buffer,
    quad_verts: wgpu::Buffer,
    quad_indices: wgpu::Buffer,
    sampler: wgpu::Sampler,
    readback_buf: wgpu::Buffer,
    // Glyph rendering (cosmic-text + swash + glyphon atlas).
    font_system: FontSystem,
    swash_cache: SwashCache,
    atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    // Loaded textures keyed by path (rendered only; lifecycle owned here).
    image_cache: HashMap<String, std::rc::Rc<wgpu::Texture>>,
    /// Decoded video frames + their GPU textures keyed by path (Phase H). The
    /// texture re-uploads only when the hub publishes a new frame (detected by
    /// comparing the shared pixel buffer's pointer).
    video_cache: HashMap<String, (super::media::VideoFrame, std::rc::Rc<wgpu::Texture>)>,
    /// Text queued during the layer pass and prepared in ONE glyphon
    /// `prepare()` call at the end of the frame — `prepare()` clears its
    /// vertex batch on every invocation, so per-call preparation would keep
    /// only the last draw's glyphs.
    pending_text: Vec<QueuedText>,
    // Window-surface present path (Phase C). Present for a compositor created
    // via [`Compositor::new_surface`]: the instance keeps the display/backend
    // connection alive for the surface's lifetime, and the blit pipeline copies
    // the offscreen target into the swapchain texture.
    // Retained for the window-surface path: the instance keeps the display
    // connection and backend alive for the surface's lifetime.
    #[allow(dead_code)]
    instance: Option<wgpu::Instance>,
    surface: Option<wgpu::Surface<'static>>,
    surface_config: Option<wgpu::SurfaceConfiguration>,
    blit_pipeline: Option<wgpu::RenderPipeline>,
    blit_sampler: Option<wgpu::Sampler>,
}

/// Convenience `MediaResolver` backed by an in-memory path → image map (tests).
pub struct MemoryMedia(pub HashMap<String, ImageData>);

/// A shaped text run queued for the frame's single batched glyphon prepare.
struct QueuedText {
    buffer: Buffer,
    left: f32,
    top: f32,
    color: [u8; 4],
}

impl MediaResolver for MemoryMedia {
    fn load_image(&mut self, path: &str) -> Option<ImageData> {
        self.0.get(path).cloned()
    }
}

fn make_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRIBUTES: [wgpu::VertexAttribute; 2] =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2];
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<QuadVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &ATTRIBUTES,
    }
}

fn solid_bind_group(device: &wgpu::Device, uniform: &wgpu::Buffer) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("solid uniforms"),
        layout: &device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("solid uniform layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        }),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }],
    })
}

fn tex_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    texture: &wgpu::Texture,
    sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("tex bind group"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}

/// Parse a `#rrggbb` / `#rrggbbaa` / `rgba(...)`/`rgb(...)` CSS color to RGBA bytes.
pub fn parse_color(hex: &str) -> Option<[u8; 4]> {
    let s = hex.trim();
    if let Some(rest) = s.strip_prefix('#') {
        let len = rest.len();
        if len == 6 || len == 8 {
            let raw = u32::from_str_radix(rest, 16).ok()?;
            return Some(if len == 6 {
                [((raw >> 16) & 0xff) as u8, ((raw >> 8) & 0xff) as u8, (raw & 0xff) as u8, 255]
            } else {
                [
                    ((raw >> 24) & 0xff) as u8,
                    ((raw >> 16) & 0xff) as u8,
                    ((raw >> 8) & 0xff) as u8,
                    (raw & 0xff) as u8,
                ]
            });
        }
        return None;
    }
    if let Some(rest) = s.strip_prefix("rgb(").and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<&str> = rest.split(',').collect();
        if parts.len() == 3 {
            let mut out = [0u8; 4];
            for (i, p) in parts.iter().enumerate() {
                out[i] = p.trim().parse().ok()?;
            }
            out[3] = 255;
            return Some(out);
        }
    }
    if let Some(rest) = s.strip_prefix("rgba(").and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<&str> = rest.split(',').collect();
        if parts.len() == 4 {
            let mut out = [0u8; 4];
            for (i, p) in parts.iter().enumerate().take(3) {
                out[i] = p.trim().parse().ok()?;
            }
            out[3] = (parts[3].trim().parse::<f32>().ok()? * 255.0) as u8;
            return Some(out);
        }
    }
    None
}

fn rgba_to_uniform(c: [u8; 4]) -> [f32; 4] {
    [
        c[0] as f32 / 255.0,
        c[1] as f32 / 255.0,
        c[2] as f32 / 255.0,
        c[3] as f32 / 255.0,
    ]
}

const BLIT_SHADER: &str = r#"
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
    let ndc = vec2f(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0);
    return VSOut(vec4f(ndc, 0.0, 1.0), uv);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(tex, samp, uv);
}
"#;

/// Shared device/pipeline/glyph setup for both the offscreen and window-surface
/// compositors. `surface` is optional: the window path additionally builds a
/// blit pipeline targeting the surface format (see [`Compositor::new_surface`]).
#[allow(clippy::type_complexity)]
fn build_common(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    width: u32,
    height: u32,
    surface: Option<(&wgpu::Surface<'_>, wgpu::TextureFormat)>,
) -> anyhow::Result<(
    wgpu::Texture,
    wgpu::TextureView,
    wgpu::RenderPipeline,
    wgpu::RenderPipeline,
    wgpu::BindGroup,
    wgpu::Buffer,
    wgpu::Buffer,
    wgpu::Buffer,
    wgpu::Sampler,
    wgpu::Buffer,
    FontSystem,
    SwashCache,
    TextAtlas,
    TextRenderer,
    Viewport,
    Option<wgpu::RenderPipeline>,
    Option<wgpu::Sampler>,
)> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("compositor target"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let quad_verts = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("quad verts"),
        contents: bytemuck::cast_slice(SOLID_VERTICES),
        usage: wgpu::BufferUsages::VERTEX,
    });
    let quad_indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("quad indices"),
        contents: bytemuck::cast_slice(SOLID_INDICES),
        usage: wgpu::BufferUsages::INDEX,
    });
    let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("solid uniform"),
        size: std::mem::size_of::<SolidUniform>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let solid_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("solid uniform layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let solid_pipeline = {
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("solid pipeline layout"),
            bind_group_layouts: &[Some(&solid_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("solid shader"),
            source: wgpu::ShaderSource::Wgsl(SOLID_SHADER.into()),
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("solid pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[Some(make_vertex_layout())],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    };
    let solid_bind_group = solid_bind_group(device, &uniform_buf);

    let tex_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("tex bind layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let tex_pipeline = {
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("tex pipeline layout"),
            bind_group_layouts: &[Some(&solid_layout), Some(&tex_bind_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tex shader"),
            source: wgpu::ShaderSource::Wgsl(TEX_SHADER.into()),
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("tex pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[Some(make_vertex_layout())],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    };

    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("compositor sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Nearest,
        ..Default::default()
    });

    let readback_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("compositor readback"),
        size: (width as u64) * (height as u64) * 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let font_system = FontSystem::new();
    let swash_cache = SwashCache::new();
    let cache = Cache::new(device);
    let mut atlas = TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8UnormSrgb);
    let text_renderer = TextRenderer::new(&mut atlas, device, wgpu::MultisampleState::default(), None);
    let mut viewport = Viewport::new(device, &cache);
    viewport.update(queue, Resolution { width, height });

    // Window-surface path: a blit pipeline that copies the offscreen target
    // into the swapchain texture. It samples the offscreen texture with its own
    // bind group layout (texture + sampler) and targets the surface format.
    let (blit_pipeline, blit_sampler) = match surface {
        Some((surface, surface_format)) => {
            let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("blit bind layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
            let blit_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("blit sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                ..Default::default()
            });
            let pipeline = {
                let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("blit pipeline layout"),
                    bind_group_layouts: &[Some(&blit_layout)],
                    immediate_size: 0,
                });
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("blit shader"),
                    source: wgpu::ShaderSource::Wgsl(BLIT_SHADER.into()),
                });
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("blit pipeline"),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs_main"),
                        compilation_options: Default::default(),
                        buffers: &[Some(make_vertex_layout())],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("fs_main"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: surface_format,
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
            let _ = surface;
            (Some(pipeline), Some(blit_sampler))
        }
        None => (None, None),
    };

    Ok((
        target,
        target_view,
        solid_pipeline,
        tex_pipeline,
        solid_bind_group,
        uniform_buf,
        quad_verts,
        quad_indices,
        sampler,
        readback_buf,
        font_system,
        swash_cache,
        atlas,
        text_renderer,
        viewport,
        blit_pipeline,
        blit_sampler,
    ))
}

impl Compositor {
    /// Create a headless compositor rendering into an offscreen texture of the
    /// given size. Falls back to a software adapter if no GPU is available.
    pub fn new(width: u32, height: u32) -> anyhow::Result<Self> {
        // Restrict to DX12 on Windows: wgpu 30's Vulkan backend crashes in
        // `request_device` on some Intel iGPU drivers (observed UHD 620), while
        // DX12 is stable across the Intel/AMD/NVIDIA range. macOS keeps Metal,
        // other platforms default to Vulkan/GL.
        #[cfg(target_os = "windows")]
        let backends = wgpu::Backends::DX12;
        #[cfg(not(target_os = "windows"))]
        let backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .or_else(|_| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::None,
                compatible_surface: None,
                force_fallback_adapter: true,
                apply_limit_buckets: false,
            }))
        })?;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("wordlyte compositor"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(wgpu::Limits::default()),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            },
        ))?;

        let (
            target,
            target_view,
            solid_pipeline,
            tex_pipeline,
            solid_bind_group,
            uniform_buf,
            quad_verts,
            quad_indices,
            sampler,
            readback_buf,
            font_system,
            swash_cache,
            atlas,
            text_renderer,
            viewport,
            blit_pipeline,
            blit_sampler,
        ) = build_common(&device, &queue, width, height, None)?;

        let mut this = Self {
            device,
            queue,
            width,
            height,
            target,
            target_view,
            solid_pipeline,
            tex_pipeline,
            solid_bind_group,
            uniform_buf,
            quad_verts,
            quad_indices,
            sampler,
            readback_buf,
            font_system,
            swash_cache,
            atlas,
            text_renderer,
            viewport,
            image_cache: HashMap::new(),
            video_cache: HashMap::new(),
            pending_text: Vec::new(),
            instance: Some(instance),
            surface: None,
            surface_config: None,
            blit_pipeline,
            blit_sampler,
        };
        this.render_clear([0.0, 0.0, 0.0, 1.0]);
        Ok(this)
    }

    /// Create a compositor that renders into a winit window's surface (Phase C).
    ///
    /// The program is still drawn into the offscreen target first (so all
    /// drawing code and the pixel readback stay identical), then copied into
    /// the window's swapchain texture by a blit pass in [`Compositor::present`].
    ///
    /// The adapter is requested against the window surface so the GPU/compositor
    /// pair can present (falling back to the software adapter if the hardware
    /// adapter cannot present to it).
    pub fn new_surface(window: std::sync::Arc<winit::window::Window>, width: u32, height: u32) -> anyhow::Result<Self> {
        // Same DX12-on-Windows restriction as [`Compositor::new`].
        #[cfg(target_os = "windows")]
        let backends = wgpu::Backends::DX12;
        #[cfg(not(target_os = "windows"))]
        let backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        // The surface takes ownership of the window handle source, keeping the
        // window alive and yielding a `'static` surface.
        let surface = instance.create_surface(window)?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .or_else(|_| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::None,
                compatible_surface: None,
                force_fallback_adapter: true,
                apply_limit_buckets: false,
            }))
        })?;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("wordlyte compositor"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(wgpu::Limits::default()),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            },
        ))?;

        // Pick a surface format: prefer sRGB when available (matches the
        // offscreen target's encoding), otherwise take the first capability.
        let caps = surface.get_capabilities(&adapter);
        let surface_format = caps
            .formats
            .iter()
            .copied()
            .find(|f| matches!(f, wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb))
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);

        let (
            target,
            target_view,
            solid_pipeline,
            tex_pipeline,
            solid_bind_group,
            uniform_buf,
            quad_verts,
            quad_indices,
            sampler,
            readback_buf,
            font_system,
            swash_cache,
            atlas,
            text_renderer,
            viewport,
            blit_pipeline,
            blit_sampler,
        ) = build_common(&device, &queue, width, height, Some((&surface, surface_format)))?;

        let mut this = Self {
            device,
            queue,
            width,
            height,
            target,
            target_view,
            solid_pipeline,
            tex_pipeline,
            solid_bind_group,
            uniform_buf,
            quad_verts,
            quad_indices,
            sampler,
            readback_buf,
            font_system,
            swash_cache,
            atlas,
            text_renderer,
            viewport,
            image_cache: HashMap::new(),
            video_cache: HashMap::new(),
            pending_text: Vec::new(),
            instance: Some(instance),
            surface: Some(surface),
            surface_config: Some(config),
            blit_pipeline,
            blit_sampler,
        };
        this.render_clear([0.0, 0.0, 0.0, 1.0]);
        Ok(this)
    }

    /// Present the current frame to the window surface: renders `frame` into the
    /// offscreen target, copies it into the swapchain texture, and presents.
    /// Returns `true` when a frame was presented, `false` when the surface was
    /// temporarily unavailable (hidden/minimized) and the frame was skipped.
    pub fn present(
        &mut self,
        frame: &ProgramFrame,
        media: &mut dyn MediaResolver,
    ) -> anyhow::Result<bool> {
        self.render(frame, media)?;
        let Some(surface) = &self.surface else {
            return Err(anyhow::anyhow!("compositor has no window surface"));
        };
        let Some(blit_pipeline) = &self.blit_pipeline else {
            return Err(anyhow::anyhow!("compositor has no blit pipeline"));
        };
        let Some(blit_sampler) = &self.blit_sampler else {
            return Err(anyhow::anyhow!("compositor has no blit sampler"));
        };
        let current = surface.get_current_texture();
        let frame = match current {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Outdated
            | wgpu::CurrentSurfaceTexture::Lost
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Validation => {
                // Surface not ready this frame — skip the present.
                return Ok(false);
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let blit_bind_group = tex_bind_group(&self.device, &blit_pipeline.get_bind_group_layout(0), &self.target, blit_sampler);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("compositor present") });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blit pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(blit_pipeline);
        pass.set_bind_group(0, &blit_bind_group, &[]);
        pass.set_vertex_buffer(0, self.quad_verts.slice(..));
        pass.set_index_buffer(self.quad_indices.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..SOLID_INDICES.len() as u32, 0, 0..1);
        drop(pass);
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Ok(true)
    }

    /// Resize the render target (and the window surface when present) to the
    /// given size. Recreates the offscreen target, readback buffer, and glyph
    /// viewport, and reconfigures the swapchain so `width`/`height` match the
    /// window. No-op when the size is unchanged.
    pub fn resize(&mut self, width: u32, height: u32) -> anyhow::Result<()> {
        if width == self.width && height == self.height {
            return Ok(());
        }
        self.width = width;
        self.height = height;
        self.rebuild_target();
        if let (Some(surface), Some(config)) = (&self.surface, &mut self.surface_config) {
            config.width = width;
            config.height = height;
            surface.configure(&self.device, config);
        }
        self.render_clear([0.0, 0.0, 0.0, 1.0]);
        Ok(())
    }

    fn rebuild_target(&mut self) {
        self.target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("compositor target"),
            size: wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.target_view = self.target.create_view(&wgpu::TextureViewDescriptor::default());
        self.readback_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("compositor readback"),
            size: (self.width as u64) * (self.height as u64) * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        self.viewport
            .update(&self.queue, Resolution { width: self.width, height: self.height });
    }

    /// Clear the offscreen target to a solid color (used before the first frame
    /// or when no frame has been published yet).
    pub fn clear(&mut self, color: [f32; 4]) {
        self.render_clear(color);
    }

    fn render_clear(&mut self, color: [f32; 4]) {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clear") });
        let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: color[0] as f64, g: color[1] as f64, b: color[2] as f64, a: color[3] as f64 }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        drop(pass);
        self.queue.submit([encoder.finish()]);
    }

    /// Fill a solid rectangle (pixel coords, top-left origin, y down).
    fn fill_rect(&mut self, pass: &mut wgpu::RenderPass<'_>, rect: [f32; 4], color: [f32; 4], radius: f32) {
        self.queue.write_buffer(
            &self.uniform_buf,
            0,
            bytemuck::bytes_of(&SolidUniform {
                rect,
                color,
                screen: [self.width as f32, self.height as f32],
                radius,
                _pad: [0.0],
            }),
        );
        pass.set_pipeline(&self.solid_pipeline);
        pass.set_bind_group(0, &self.solid_bind_group, &[]);
        pass.set_vertex_buffer(0, self.quad_verts.slice(..));
        pass.set_index_buffer(self.quad_indices.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..SOLID_INDICES.len() as u32, 0, 0..1);
    }

    /// Draw a textured quad (pixel rect) with the given source UV rect and tint.
    fn draw_textured(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        texture: &wgpu::Texture,
        rect: [f32; 4],
        _uv: [f32; 4],
        tint: [f32; 4],
        radius: f32,
    ) {
        self.queue.write_buffer(
            &self.uniform_buf,
            0,
            bytemuck::bytes_of(&SolidUniform {
                rect,
                color: tint,
                screen: [self.width as f32, self.height as f32],
                radius,
                _pad: [0.0],
            }),
        );
        let layout = &self.tex_pipeline.get_bind_group_layout(1);
        let bg = tex_bind_group(&self.device, layout, texture, &self.sampler);
        pass.set_pipeline(&self.tex_pipeline);
        pass.set_bind_group(0, &solid_bind_group(&self.device, &self.uniform_buf), &[]);
        pass.set_bind_group(1, &bg, &[]);
        pass.set_vertex_buffer(0, self.quad_verts.slice(..));
        pass.set_index_buffer(self.quad_indices.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..SOLID_INDICES.len() as u32, 0, 0..1);
    }

    /// Render a full `ProgramFrame` into the target texture.
    pub fn render(&mut self, frame: &ProgramFrame, media: &mut dyn MediaResolver) -> anyhow::Result<()> {
        self.pending_text.clear();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("compositor frame") });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("compositor pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });

        let theme_bg = parse_color(&frame.colors.background).unwrap_or([0, 0, 0, 255]);

        for layer in &frame.layers {
            match layer {
                ProgramLayer::Blank => {}
                ProgramLayer::Background { setting } => {
                    self.draw_background(&mut pass, setting, theme_bg, media);
                }
                ProgramLayer::Item { item } => {
                    self.draw_item(&mut pass, item, media);
                }
                ProgramLayer::Zone { zone } => {
                    self.draw_zone(&mut pass, zone, media);
                }
                ProgramLayer::Props { .. } => {
                    for prop in &frame.overlays.props {
                        self.draw_prop(&mut pass, prop, media);
                    }
                }
                ProgramLayer::LowerThird { payload } => {
                    self.draw_lower_third(&mut pass, payload.as_ref(), media);
                }
                ProgramLayer::Logo => {
                    if let Some(logo) = &frame.overlays.logo {
                        self.draw_logo(&mut pass, logo, media);
                    }
                }
                ProgramLayer::Waiting => {
                    let w = self.width as f32;
                    let h = self.height as f32;
                    let color = parse_color(&frame.colors.waiting_text).unwrap_or([120, 120, 120, 255]);
                    let size = (h * 0.04).max(18.0);
                    let text = "WAITING".to_string();
                    let bh = size * 1.4;
                    self.draw_text_centered( &text, h / 2.0 - bh / 2.0, size, color, false, w * 0.86);
                }
            }
        }

        self.flush_text();
        self.text_renderer
            .render(&self.atlas, &self.viewport, &mut pass)
            .map_err(|e| anyhow::anyhow!("text render: {e:?}"))?;
        drop(pass);
        self.queue.submit([encoder.finish()]);
        Ok(())
    }

    fn draw_background(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        setting: &BackgroundSetting,
        theme_bg: [u8; 4],
        media: &mut dyn MediaResolver,
    ) {
        let w = self.width as f32;
        let h = self.height as f32;
        match setting {
            BackgroundSetting::None => {
                self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(theme_bg), 0.0);
            }
            BackgroundSetting::Color(c) => {
                let col = parse_color(c).unwrap_or(theme_bg);
                self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(col), 0.0);
            }
            BackgroundSetting::Image(img) => {
                if let Some(tex) = self.load_texture(&img.path, media) {
                    let r = image_fit_rect(img, w, h);
                    self.draw_textured(pass, &tex, r, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, img.opacity.clamp(0.0, 1.0)], 0.0);
                } else {
                    self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(theme_bg), 0.0);
                }
            }
            BackgroundSetting::Video(v) => {
                match self.load_video_texture(&v.path, media) {
                    Some((tex, vw, vh)) => {
                        let r = image_fit_rect_for(&v.object_fit, w, h, Some(vw as i64), Some(vh as i64));
                        let opacity = v.opacity.clamp(0.0, 1.0);
                        self.draw_textured(pass, &tex, r, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, opacity], 0.0);
                    }
                    None => self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(theme_bg), 0.0),
                }
            }
            BackgroundSetting::Camera(cb) => {
                // Phase I1: live capture fills the background; theme fill only
                // when no capture is running for the device.
                let key = super::media::camera_key_for_device(&cb.device_id);
                match self.load_video_texture(&key, media) {
                    Some((tex, vw, vh)) => {
                        let r = image_fit_rect_for(&cb.object_fit, w, h, Some(vw as i64), Some(vh as i64));
                        let uv = if cb.mirrored { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] };
                        self.draw_textured(pass, &tex, r, uv, [1.0, 1.0, 1.0, cb.opacity.clamp(0.0, 1.0)], 0.0);
                    }
                    None => self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(theme_bg), 0.0),
                }
            }
            BackgroundSetting::Audio(_) => {
                self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(theme_bg), 0.0);
            }
        }
    }

    fn draw_item(&mut self, pass: &mut wgpu::RenderPass<'_>, item: &DisplayItem, media: &mut dyn MediaResolver) {
        let w = self.width as f32;
        let h = self.height as f32;
        match item {
            DisplayItem::Verse(v) => {
                let size = (h * 0.045).max(20.0);
                let ref_size = size * 0.6;
                let ref_color = parse_color("#b45309").unwrap_or([180, 83, 9, 255]);
                let body_color = [255, 255, 255, 255];
                let header = format!("{} {}:{}", v.book, v.chapter, v.verse);
                let max_w = w * 0.86;
                let mut y = h * 0.5 - size * 2.0;
                y += self.draw_text_centered( &header, y, ref_size, ref_color, true, max_w);
                y += size * 0.3;
                self.draw_text_centered( &v.text, y, size, body_color, false, max_w);
            }
            DisplayItem::Media(m) => match m.media_type {
                crate::store::MediaItemType::Image => {
                    if let Some(tex) = self.load_texture(&m.path, media) {
                        let r = image_fit_rect_for(m.fit_mode.as_str(), w, h, m.width, m.height);
                        self.draw_textured(pass, &tex, r, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0);
                    } else {
                        self.draw_missing_media(pass, &m.name, w, h);
                    }
                }
                crate::store::MediaItemType::Video => {
                    match self.load_video_texture(&m.path, media) {
                        Some((tex, vw, vh)) => {
                            let r = image_fit_rect_for(m.fit_mode.as_str(), w, h, Some(vw as i64), Some(vh as i64));
                            self.draw_textured(pass, &tex, r, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0);
                        }
                        None => self.draw_missing_media(pass, &m.name, w, h),
                    }
                }
                crate::store::MediaItemType::Audio => {
                    self.draw_missing_media(pass, &m.name, w, h);
                }
            },
            DisplayItem::Camera(c) => {
                // Phase I1: live frames come from the hub's `cam:` key; the
                // placeholder panel shows only when no capture is running.
                let key = super::media::camera_key_for_device(&c.device_id);
                match self.load_video_texture(&key, media) {
                    Some((tex, vw, vh)) => {
                        let r = image_fit_rect_for("contain", w, h, Some(vw as i64), Some(vh as i64));
                        self.draw_textured(pass, &tex, r, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0);
                    }
                    None => {
                        let name = format!("CAMERA {}", c.device_id);
                        self.draw_missing_media(pass, &name, w, h);
                    }
                }
            }
            DisplayItem::Timer(t) => {
                let size = (h * 0.12).max(40.0);
                let secs = (t.duration_secs.unwrap_or(0) as i64) - (frame_now_secs()) + (t.started_at.unwrap_or(0) as i64);
                let text = format_timer(secs, t.timer_type.as_str());
                self.draw_text_centered( &text, h / 2.0 - size / 2.0, size, [255, 255, 255, 255], false, w * 0.86);
            }
            DisplayItem::Song(s) => {
                let size = (h * 0.05).max(22.0);
                let max_w = w * 0.86;
                let mut y = h * 0.35;
                if !s.section_label.is_empty() {
                    let label = &s.section_label;
                    self.draw_text_centered( label, y, size * 0.7, [245, 158, 11, 255], true, max_w);
                    y += size * 1.3;
                }
                for line in &s.lines {
                    self.draw_text_centered( line, y, size, [255, 255, 255, 255], false, max_w);
                    y += size * 1.4;
                }
            }
            DisplayItem::CustomSlide(cs) => {
                if let Some(bg) = &cs.background {
                    self.draw_slide_background(pass, bg, w, h, media);
                }
                for el in &cs.elements {
                    self.draw_slide_element(pass, el, w, h, media);
                }
            }
            DisplayItem::SceneComposition(_) => {
                self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform([0, 0, 0, 255]), 0.0);
            }
        }
    }

    fn draw_zone(&mut self, pass: &mut wgpu::RenderPass<'_>, zone: &SceneZone, media: &mut dyn MediaResolver) {
        let w = self.width as f32;
        let h = self.height as f32;
        let rect = [
            zone.x as f32 * w,
            zone.y as f32 * h,
            zone.w as f32 * w,
            zone.h as f32 * h,
        ];
        let opacity = zone.opacity.clamp(0.0, 1.0);
        match &zone.item {
            DisplayItem::Media(m) => {
                // Video zones sample the decode hub first; static images fall
                // through to the image cache.
                let video = if matches!(m.media_type, crate::store::MediaItemType::Video) {
                    self.load_video_texture(&m.path, media)
                } else {
                    None
                };
                if let Some((tex, vw, vh)) = video {
                    let r = image_fit_rect_for(zone.fit.as_str(), rect[2], rect[3], Some(vw as i64), Some(vh as i64));
                    let rr = [rect[0] + (rect[2] - r[2]) / 2.0, rect[1] + (rect[3] - r[3]) / 2.0, r[2], r[3]];
                    self.draw_textured(pass, &tex, rr, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, opacity], 0.0);
                } else if let Some(tex) = self.load_texture(&m.path, media) {
                    let r = image_fit_rect_for(zone.fit.as_str(), rect[2], rect[3], m.width, m.height);
                    let rr = [rect[0] + (rect[2] - r[2]) / 2.0, rect[1] + (rect[3] - r[3]) / 2.0, r[2], r[3]];
                    self.draw_textured(pass, &tex, rr, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, opacity], 0.0);
                }
            }
            DisplayItem::Camera(c) => {
                let key = super::media::camera_key_for_device(&c.device_id);
                match self.load_video_texture(&key, media) {
                    Some((tex, vw, vh)) => {
                        let r = image_fit_rect_for(zone.fit.as_str(), rect[2], rect[3], Some(vw as i64), Some(vh as i64));
                        let rr = [rect[0] + (rect[2] - r[2]) / 2.0, rect[1] + (rect[3] - r[3]) / 2.0, r[2], r[3]];
                        self.draw_textured(pass, &tex, rr, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, opacity], 0.0);
                    }
                    None => {
                        let name = format!("CAMERA {}", c.device_id);
                        self.draw_missing_media_in(pass, &name, rect, opacity);
                    }
                }
            }
            DisplayItem::Verse(v) => {
                let size = (rect[3] * 0.05).max(14.0);
                let body = &v.text;
                let bw = body.len() as f32 * size * 0.5;
                self.queue_text( body, rect[0] + (rect[2] - bw) / 2.0, rect[1] + rect[3] / 2.0, size, [255, 255, 255, 255], false);
            }
            _ => {}
        }
    }

    fn draw_prop(&mut self, pass: &mut wgpu::RenderPass<'_>, prop: &PropItem, media: &mut dyn MediaResolver) {
        if !prop.visible {
            return;
        }
        let w = self.width as f32;
        let h = self.height as f32;
        let rect = [prop.x as f32 * w, prop.y as f32 * h, prop.w as f32 * w, prop.h as f32 * h];
        match prop.kind.as_str() {
            "image" => {
                if let Some(path) = &prop.path {
                    if let Some(tex) = self.load_texture(path, media) {
                        self.draw_textured(pass, &tex, rect, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, prop.opacity as f32], 0.0);
                    }
                }
            }
            "text" | "clock" => {
                let text = prop.text.clone().unwrap_or_default();
                let size = (rect[3] * 0.8).max(12.0);
                let color = parse_color(prop.color.as_deref().unwrap_or("#ffffff")).unwrap_or([255, 255, 255, 255]);
                self.queue_text( &text, rect[0], rect[1], size, color, false);
            }
            _ => {}
        }
    }

    fn draw_logo(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        logo: &super::frame::LogoState,
        media: &mut dyn MediaResolver,
    ) {
        let w = self.width as f32;
        let h = self.height as f32;
        let opacity = logo.opacity.clamp(0.0, 1.0) as f32;
        if let Some(path) = &logo.path {
            if let Some(tex) = self.load_texture(path, media) {
                let size = (h * 0.12).max(40.0);
                let rect = [w - size - 40.0, 40.0, size, size];
                self.draw_textured(pass, &tex, rect, [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, opacity], 0.0);
                return;
            }
        }
        if let Some(text) = &logo.text {
            let size = (h * 0.04).max(16.0);
            let color = logo
                .text_color
                .as_deref()
                .and_then(parse_color)
                .unwrap_or([255, 255, 255, 255]);
            let bw = text.len() as f32 * size * 0.6;
            self.queue_text( text, w - bw - 40.0, 40.0, size, [color[0], color[1], color[2], (color[3] as f32 * opacity) as u8], false);
        }
    }

    fn draw_lower_third(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        payload: &super::lower_third::LowerThirdPayload,
        _media: &mut dyn MediaResolver,
    ) {
        let resolved = resolve_lower_third(payload);
        let w = self.width as f32;
        let h = self.height as f32;
        let g = &resolved.geometry;
        let box_w = if g.is_full_width { w } else { w * (g.width_pct as f32 / 100.0) };
        let box_h = (g.padding_y as f32 * 2.0) + g.max_lines.max(1) as f32 * 24.0;
        let x = match g.h_align.as_str() {
            "center" => (w - box_w) / 2.0,
            "right" => w - box_w - g.offset_x as f32,
            _ => g.offset_x as f32,
        };
        let y = match g.v_align.as_str() {
            "center" => (h - box_h) / 2.0,
            "top" => g.offset_y as f32,
            _ => h - box_h - g.offset_y as f32,
        };
        let bg_color = parse_color(&resolved.background.color).unwrap_or([0, 0, 0, 255]);
        let bg_alpha = (resolved.background.opacity.clamp(0.0, 100.0) / 100.0 * 255.0) as u8;
        self.fill_rect(pass, [x, y, box_w, box_h], [bg_color[0] as f32 / 255.0, bg_color[1] as f32 / 255.0, bg_color[2] as f32 / 255.0, bg_alpha as f32 / 255.0], g.border_radius as f32);
        let mut ty = y + g.padding_y as f32;
        let content = &resolved.content;
        let default_color = [255, 255, 255, 255];
        if resolved.slots.show_headline && !content.headline.is_empty() {
            let size = resolved.slots.headline.size as f32;
            let col = parse_color(&resolved.slots.headline.color).unwrap_or(default_color);
            let tx = x + g.padding_x as f32;
            self.queue_text( &content.headline, tx, ty, size, col, resolved.slots.headline.bold);
            ty += size * 1.3;
        }
        if resolved.slots.show_subline && !content.subline.is_empty() {
            let size = resolved.slots.subline.size as f32;
            let col = parse_color(&resolved.slots.subline.color).unwrap_or(default_color);
            let tx = x + g.padding_x as f32;
            self.queue_text( &content.subline, tx, ty, size, col, resolved.slots.subline.bold);
            ty += size * 1.3;
        }
        if resolved.slots.show_kicker && !content.kicker.is_empty() {
            let size = resolved.slots.kicker.size as f32;
            let col = parse_color(&resolved.slots.kicker.color).unwrap_or(default_color);
            let tx = x + g.padding_x as f32;
            self.queue_text( &content.kicker, tx, ty, size, col, resolved.slots.kicker.bold);
        }
        // Accent bar on the configured side.
        if resolved.accent.enabled {
            let accent = parse_color(&resolved.accent.color).unwrap_or([245, 158, 11, 255]);
            match resolved.accent.side.as_str() {
                "right" => self.fill_rect(pass, [x + box_w - resolved.accent.width as f32, y, resolved.accent.width as f32, box_h], rgba_to_uniform(accent), 0.0),
                "top" => self.fill_rect(pass, [x, y, box_w, resolved.accent.width as f32], rgba_to_uniform(accent), 0.0),
                "bottom" => self.fill_rect(pass, [x, y + box_h - resolved.accent.width as f32, box_w, resolved.accent.width as f32], rgba_to_uniform(accent), 0.0),
                _ => self.fill_rect(pass, [x, y, resolved.accent.width as f32, box_h], rgba_to_uniform(accent), 0.0),
            }
        }
    }

    fn draw_slide_background(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        bg: &serde_json::Value,
        w: f32,
        h: f32,
        media: &mut dyn MediaResolver,
    ) {
        let t = bg.get("type").and_then(|v| v.as_str()).unwrap_or("color");
        match t {
            "image" => {
                if let Some(path) = bg.get("path").and_then(|v| v.as_str()) {
                    if let Some(tex) = self.load_texture(path, media) {
                        self.draw_textured(pass, &tex, [0.0, 0.0, w, h], [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0);
                    }
                }
            }
            _ => {
                let color = bg.get("value")
                    .and_then(|v| v.as_str())
                    .and_then(parse_color)
                    .unwrap_or([0, 0, 0, 255]);
                self.fill_rect(pass, [0.0, 0.0, w, h], rgba_to_uniform(color), 0.0);
            }
        }
    }

    fn draw_slide_element(
        &mut self,
        pass: &mut wgpu::RenderPass<'_>,
        el: &crate::store::SlideElement,
        w: f32,
        h: f32,
        media: &mut dyn MediaResolver,
    ) {
        let x = el.x as f32 / 100.0 * w;
        let y = el.y as f32 / 100.0 * h;
        let ew = el.w as f32 / 100.0 * w;
        let eh = el.h as f32 / 100.0 * h;
        match el.kind.as_str() {
            "image" => {
                let path = el.content.as_str().unwrap_or_default();
                if let Some(tex) = self.load_texture(path, media) {
                    self.draw_textured(pass, &tex, [x, y, ew, eh], [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], 0.0);
                }
            }
            "text" | "heading" | "body" => {
                let text = el.content.as_str().unwrap_or_default().to_string();
                let size = el.font_size.unwrap_or(24.0) as f32;
                let color = el.color.as_deref().and_then(parse_color).unwrap_or([255, 255, 255, 255]);
                self.queue_text( &text, x, y, size, color, false);
            }
            _ => {}
        }
    }

    fn draw_missing_media(&mut self, pass: &mut wgpu::RenderPass<'_>, name: &str, w: f32, h: f32) {
        let rect = [w * 0.15, h * 0.15, w * 0.7, h * 0.7];
        self.draw_missing_media_in(pass, name, rect, 1.0);
    }

    fn draw_missing_media_in(&mut self, pass: &mut wgpu::RenderPass<'_>, name: &str, rect: [f32; 4], opacity: f32) {
        self.fill_rect(pass, rect, [0.0, 0.0, 0.0, 0.6 * opacity], 8.0);
        let size = (rect[3] * 0.06).max(12.0);
        self.queue_text( name, rect[0] + 16.0, rect[1] + 16.0, size, [255, 255, 255, 255], false);
    }

    /// Ensure every referenced image is uploaded as a GPU texture.
    fn load_texture(&mut self, path: &str, media: &mut dyn MediaResolver) -> Option<std::rc::Rc<wgpu::Texture>> {
        if let Some(tex) = self.image_cache.get(path) {
            return Some(tex.clone());
        }
        let data = media.load_image(path)?;
        let texture = self.upload_rgba(data.width, data.height, &data.rgba);
        let rc = std::rc::Rc::new(texture);
        self.image_cache.insert(path.to_string(), rc.clone());
        Some(rc)
    }

    /// Ensure the newest decoded frame for a playing video is on the GPU.
    /// Returns the texture plus the frame's dimensions (for object-fit math).
    fn load_video_texture(
        &mut self,
        path: &str,
        media: &mut dyn MediaResolver,
    ) -> Option<(std::rc::Rc<wgpu::Texture>, u32, u32)> {
        let fresh = media.load_video_frame(path)?;
        if let Some((cached, tex)) = self.video_cache.get(path) {
            if cached.width == fresh.width
                && cached.height == fresh.height
                && cached.rgba.as_ptr() == fresh.rgba.as_ptr()
            {
                return Some((tex.clone(), cached.width, cached.height));
            }
        }
        let (fw, fh) = (fresh.width, fresh.height);
        let texture = std::rc::Rc::new(self.upload_rgba(fw, fh, &fresh.rgba));
        self.video_cache.insert(path.to_string(), (fresh, texture.clone()));
        Some((texture, fw, fh))
    }

    /// Upload one RGBA buffer as a sampled GPU texture.
    fn upload_rgba(&self, width: u32, height: u32, rgba: &[u8]) -> wgpu::Texture {
        let size = wgpu::Extent3d {
            width: width.max(1),
            height: height.max(1),
            depth_or_array_layers: 1,
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("media texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width.max(1) * 4),
                rows_per_image: Some(height.max(1)),
            },
            size,
        );
        texture
    }

    #[allow(clippy::too_many_arguments)]
    /// Measure the laid-out width of `text` shaped as a single unconstrained
    /// line (no wrapping).
    fn measure_text(&mut self, text: &str, size: f32, bold: bool) -> f32 {
        let mut buffer = Buffer::new(
            &mut self.font_system,
            Metrics::new(size, (size * 1.3).max(2.0)),
        );
        let mut attrs = Attrs::new().family(Family::SansSerif);
        if bold {
            attrs = attrs.weight(glyphon::Weight::BOLD);
        }
        buffer.set_size(None, None);
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);
        buffer.layout_runs().map(|run| run.line_w).fold(0.0_f32, f32::max)
    }

    /// Draw `text` word-wrapped to `max_width` with every line horizontally
    /// centered on the canvas. Returns the total block height so callers can
    /// stack content below. This mirrors the DOM renderers, which wrap and
    /// center via CSS — the old character-count estimate produced negative x
    /// origins for any real verse, clipping the left edge.
    fn draw_text_centered(
        &mut self,
        text: &str,
        y: f32,
        size: f32,
        color: [u8; 4],
        bold: bool,
        max_width: f32,
    ) -> f32 {
        let w = self.width as f32;
        let line_h = (size * 1.3).max(2.0);
        let mut lines: Vec<String> = Vec::new();
        for paragraph in text.split('\n') {
            let mut current = String::new();
            for word in paragraph.split_whitespace() {
                let candidate =
                    if current.is_empty() { word.to_string() } else { format!("{current} {word}") };
                if !current.is_empty() && self.measure_text(&candidate, size, bold) > max_width {
                    lines.push(std::mem::take(&mut current));
                    current = word.to_string();
                } else {
                    current = candidate;
                }
            }
            lines.push(current);
        }
        let mut yy = y;
        for line in &lines {
            let lw = self.measure_text(line, size, bold);
            let x = ((w - lw) / 2.0).max(0.0);
            self.queue_text(line, x, yy, size, color, bold);
            yy += line_h;
        }
        yy - y
    }

    /// Shape `text` and queue it for the frame's single batched glyphon
    /// prepare (flushed in [`Compositor::render`]).
    fn queue_text(&mut self, text: &str, x: f32, y: f32, size: f32, color: [u8; 4], bold: bool) {
        if text.is_empty() {
            return;
        }
        let mut buffer = Buffer::new(
            &mut self.font_system,
            Metrics::new(size, (size * 1.3).max(2.0)),
        );
        buffer.set_size(Some(self.width as f32), None);
        let mut attrs = Attrs::new().family(Family::SansSerif);
        if bold {
            attrs = attrs.weight(glyphon::Weight::BOLD);
        }
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);
        self.pending_text.push(QueuedText { buffer, left: x, top: y, color });
    }

    /// Prepare every queued text run in ONE glyphon call — `prepare()` clears
    /// its vertex batch each invocation, so batching is what makes all of the
    /// frame's text actually survive to `render()`.
    fn flush_text(&mut self) {
        if self.pending_text.is_empty() {
            return;
        }
        let (width, height) = (self.width as i32, self.height as i32);
        let areas: Vec<TextArea> = self
            .pending_text
            .iter()
            .map(|q| TextArea {
                buffer: &q.buffer,
                left: q.left,
                top: q.top,
                scale: 1.0,
                bounds: glyphon::TextBounds { left: 0, top: 0, right: width, bottom: height },
                default_color: GlyphColor::rgba(q.color[0], q.color[1], q.color[2], q.color[3]),
                custom_glyphs: &[],
            })
            .collect();
        let result = self.text_renderer.prepare(
            &self.device,
            &self.queue,
            &mut self.font_system,
            &mut self.atlas,
            &self.viewport,
            areas,
            &mut self.swash_cache,
        );
        if let Err(e) = result {
            eprintln!("[engine] text prepare failed: {e:?}");
        }
        self.pending_text.clear();
    }

    /// Copy the target texture to CPU memory as RGBA8 (bottom row first due to
    /// texture coordinate origin). Returns width, height, bytes.
    pub fn read_pixels(&mut self) -> (u32, u32, Vec<u8>) {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback_buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.width * 4),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = self.readback_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r.is_ok());
        });
        self.device.poll(wgpu::PollType::wait_indefinitely()).unwrap_or(wgpu::PollStatus::QueueEmpty);
        let _ = rx.recv();
        let data = slice.get_mapped_range().expect("readback buffer map failed");
        let mut out = data.to_vec();
        drop(data);
        self.readback_buf.unmap();
        // Flip rows: texture row 0 is the bottom; expose top-down like the DOM.
        let row = (self.width * 4) as usize;
        for y in 0..(self.height as usize / 2) {
            let top = y * row;
            let bottom = (self.height as usize - 1 - y) * row;
            out.swap_slices(top..top + row, bottom..bottom + row);
        }
        (self.width, self.height, out)
    }
}

/// Swap two non-overlapping slices of a vec (helper for row flipping).
trait SwapSlices {
    fn swap_slices(&mut self, a: std::ops::Range<usize>, b: std::ops::Range<usize>);
}
impl SwapSlices for Vec<u8> {
    fn swap_slices(&mut self, a: std::ops::Range<usize>, b: std::ops::Range<usize>) {
        let len = a.len();
        debug_assert_eq!(len, b.len());
        for i in 0..len {
            self.swap(a.start + i, b.start + i);
        }
    }
}

fn frame_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_timer(secs: i64, ty: &str) -> String {
    let s = secs.max(0);
    match ty {
        "countdown" => {
            let h = s / 3600;
            let m = (s % 3600) / 60;
            let sec = s % 60;
            format!("{h:02}:{m:02}:{sec:02}")
        }
        _ => {
            let h = s / 3600;
            let m = (s % 3600) / 60;
            let sec = s % 60;
            format!("{h:02}:{m:02}:{sec:02}")
        }
    }
}

/// Compute the rect to draw an image background into, honoring object-fit.
fn image_fit_rect(img: &ImageBackground, w: f32, h: f32) -> [f32; 4] {
    image_fit_rect_for(&img.object_fit, w, h, None, None)
}

fn image_fit_rect_for(fit: &str, w: f32, h: f32, img_w: Option<i64>, img_h: Option<i64>) -> [f32; 4] {
    match fit {
        "cover" => [0.0, 0.0, w, h],
        _ => {
            // contain: center image preserving aspect using the known image
            // dims when available; otherwise assume a square-ish 16:9.
            let (iw, ih) = match (img_w, img_h) {
                (Some(iw), Some(ih)) if iw > 0 && ih > 0 => (iw as f32, ih as f32),
                _ => (16.0, 9.0),
            };
            let scale = (w / iw).min(h / ih);
            let dw = iw * scale;
            let dh = ih * scale;
            [(w - dw) / 2.0, (h - dh) / 2.0, dw, dh]
        }
    }
}

/// Create a compositor for the given canvas geometry and render one frame,
/// returning the RGBA pixels. Convenience for the fixture-parity harness.
pub fn render_frame_to_pixels(
    frame: &ProgramFrame,
    media: &mut dyn MediaResolver,
) -> anyhow::Result<(u32, u32, Vec<u8>)> {
    let mut compositor = Compositor::new(frame.canvas.width, frame.canvas.height)?;
    compositor.render(frame, media)?;
    Ok(compositor.read_pixels())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outputs::{OutputGeometry, OutputKind, OutputOverlays, OutputSource, OUTPUT_SCHEMA_VERSION};
    use crate::store::{PresentationSettings, Verse, VideoBackground};

    fn frame_with(item: Option<DisplayItem>, background: BackgroundSetting) -> ProgramFrame {
        let settings = PresentationSettings::default();
        let mut input = super::super::resolver::ProgramFrameInput {
            config: crate::outputs::OutputConfig {
                schema_version: OUTPUT_SCHEMA_VERSION,
                id: "output".to_string(),
                kind: OutputKind::Window,
                label: "Output".to_string(),
                enabled: true,
                visible: true,
                source: OutputSource::Live,
                geometry: OutputGeometry { width: 320, height: 180 },
                capture_fps: None,
                presentation: None,
                overlays: OutputOverlays { props: true, lower_third: true, logo: true },
                window_label: None,
                recording: None,
                streaming: None,
                stream_destinations: None,
            },
            snapshot: super::super::resolver::ResolverSnapshot {
                live: item,
                staged: None,
                settings,
                props: vec![],
                lower_third: None,
                revision: 1,
            },
            scenes: None,
            colors: None,
            timestamp: Some(0),
            fps: Some(30),
        };
        input.snapshot.settings.reference_output_height = 180.0;
        input.snapshot.settings.background = background;
        super::super::resolver::resolve_program_frame(input)
    }

    #[test]
    fn parses_hex_colors() {
        assert_eq!(parse_color("#ff0000"), Some([255, 0, 0, 255]));
        assert_eq!(parse_color("#00ff00ff"), Some([0, 255, 0, 255]));
        assert_eq!(parse_color("rgba(255, 0, 0, 0.5)"), Some([255, 0, 0, 127]));
        assert_eq!(parse_color("rgb(0, 0, 255)"), Some([0, 0, 255, 255]));
        assert_eq!(parse_color("nonsense"), None);
    }

    #[test]
    fn renders_blank_frame_to_black() {
        let frame = frame_with(None, BackgroundSetting::None);
        let mut media = MemoryMedia(HashMap::new());
        let (w, h, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        assert_eq!(w, 320);
        assert_eq!(h, 180);
        // Corner pixel is black (default theme background).
        assert_eq!(&px[0..4], &[0, 0, 0, 255]);
    }

    #[test]
    fn renders_color_background() {
        let frame = frame_with(
            Some(DisplayItem::Verse(Verse {
                book: "JHN".to_string(),
                chapter: 3,
                verse: 16,
                text: "For God so loved the world".to_string(),
                version: "KJV".to_string(),
                split_index: None,
                total_splits: None,
                score: None,
            })),
            BackgroundSetting::Color("#ff0000".to_string()),
        );
        let mut media = MemoryMedia(HashMap::new());
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        // Center pixel: verse text region — check a corner stays red and center has non-red text.
        let corner = &px[0..4];
        assert!(corner[0] > 200 && corner[1] < 40 && corner[2] < 40, "corner should be red, got {corner:?}");
    }

    #[test]
    fn renders_image_background() {
        let frame = frame_with(
            None,
            BackgroundSetting::Image(ImageBackground {
                path: "bg.png".to_string(),
                object_fit: "cover".to_string(),
                opacity: 1.0,
            }),
        );
        // 2x2 red image.
        let mut media = MemoryMedia(HashMap::from_iter([(
            "bg.png".to_string(),
            ImageData { width: 2, height: 2, rgba: vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255] },
        )]));
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        let corner = &px[0..4];
        assert!(corner[0] > 200 && corner[1] < 40 && corner[2] < 40, "corner should be red, got {corner:?}");
    }

    #[test]
    fn renders_verse_text_pixels() {
        let frame = frame_with(
            Some(DisplayItem::Verse(Verse {
                book: "JHN".to_string(),
                chapter: 3,
                verse: 16,
                text: "For God so loved the world".to_string(),
                version: "KJV".to_string(),
                split_index: None,
                total_splits: None,
                score: None,
            })),
            BackgroundSetting::None,
        );
        let mut media = MemoryMedia(HashMap::new());
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        // Some pixels in the center should be non-black (text rendered).
        let mid_row = 90;
        let row = &px[mid_row * 320 * 4..(mid_row + 1) * 320 * 4];
        let non_black = row.chunks_exact(4).filter(|p| p[3] > 0 && (p[0] > 30 || p[1] > 30 || p[2] > 30)).count();
        assert!(non_black > 10, "expected text pixels, found {non_black}");
    }

    #[test]
    fn long_verse_wraps_centered_without_left_clipping() {
        // Regression: the character-count width estimate made `(w - bw) / 2`
        // negative for any real verse, pushing the text off the left edge.
        let long_text = "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life. For God did not send his Son into the world to condemn the world, but to save the world through him.".repeat(2);
        let frame = frame_with(
            Some(DisplayItem::Verse(Verse {
                book: "JHN".to_string(),
                chapter: 3,
                verse: 16,
                text: long_text,
                version: "KJV".to_string(),
                split_index: None,
                total_splits: None,
                score: None,
            })),
            BackgroundSetting::Color("#0000ff".to_string()),
        );
        let mut media = MemoryMedia(HashMap::new());
        let (w, h, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        let mut cols: Vec<u32> = Vec::new();
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                let p = &px[i..i + 4];
                if p[0] > 200 && p[1] > 200 && p[2] > 200 {
                    cols.push(x as u32);
                }
            }
        }
        assert!(!cols.is_empty(), "expected white verse text pixels (near-white={} total={})", cols.len(), w * h);
        let margin = (w * 2 / 100).max(1);
        assert!(
            cols.iter().all(|&x| x >= margin),
            "verse text clipped into the left edge (min x {})",
            cols.iter().min().unwrap()
        );
        assert!(
            cols.iter().all(|&x| x < w - margin),
            "verse text overflows the right edge (max x {})",
            cols.iter().max().unwrap()
        );
    }

    #[test]
    fn renders_waiting_layer() {
        let mut frame = frame_with(None, BackgroundSetting::None);
        frame.layers.clear();
        frame.layers.push(ProgramLayer::Background { setting: BackgroundSetting::None });
        frame.layers.push(ProgramLayer::Waiting);
        let mut media = MemoryMedia(HashMap::new());
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        let mid = &px[90 * 320 * 4..(90 + 1) * 320 * 4];
        let non_black = mid.chunks_exact(4).filter(|p| p[3] > 0 && (p[0] > 30 || p[1] > 30 || p[2] > 30)).count();
        assert!(non_black > 5, "expected waiting text pixels, found {non_black}");
    }

    /// MemoryMedia plus a video-frame map (Phase H): `load_video_frame`
    /// returns mapped frames so the video draw arms can be tested without
    /// ffmpeg (the plan's "fake FrameSource").
    struct VideoMedia {
        images: HashMap<String, ImageData>,
        videos: HashMap<String, crate::engine::compositor::media::VideoFrame>,
    }

    impl MediaResolver for VideoMedia {
        fn load_image(&mut self, path: &str) -> Option<ImageData> {
            self.images.get(path).cloned()
        }
        fn load_video_frame(&mut self, path: &str) -> Option<crate::engine::compositor::media::VideoFrame> {
            self.videos.get(path).cloned()
        }
    }

    fn video_item() -> DisplayItem {
        DisplayItem::Media(crate::store::MediaItem {
            id: "m1".to_string(),
            name: "clip.mp4".to_string(),
            path: "clip.mp4".to_string(),
            media_type: crate::store::MediaItemType::Video,
            thumbnail_path: None,
            fit_mode: "contain".to_string(),
            tags: vec![],
            description: None,
            category: None,
            duration: Some(10.0),
            width: Some(4),
            height: Some(4),
            content_hash: None,
            loop_playback: true,
            playback_rate: 1.0,
            volume: 1.0,
        })
    }

    fn center_pixel_index() -> usize {
        ((180 / 2) * 320 + (320 / 2)) * 4
    }

    #[test]
    fn renders_live_video_item_frame() {
        let frame = frame_with(Some(video_item()), BackgroundSetting::None);
        // A 4x4 solid green decoded frame stands in for the hub's latest.
        let green = [0u8, 255, 0, 255].repeat(16);
        let mut media = VideoMedia {
            images: HashMap::new(),
            videos: HashMap::from_iter([(
                "clip.mp4".to_string(),
                crate::engine::compositor::media::VideoFrame { width: 4, height: 4, rgba: std::sync::Arc::new(green) },
            )]),
        };
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        // "contain" fits the square frame to the canvas height and centers it.
        let c = center_pixel_index();
        assert!(px[c + 1] > 200 && px[c] < 40, "center should be green, got {:?}", &px[c..c + 4]);
    }

    #[test]
    fn renders_missing_video_item_panel_without_a_decoder_frame() {
        let frame = frame_with(Some(video_item()), BackgroundSetting::None);
        let mut media = VideoMedia { images: HashMap::new(), videos: HashMap::new() };
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        // No decoder frame → the missing-media panel dims the canvas center;
        // it is never the bright green a live frame paints.
        let c = center_pixel_index();
        assert!(px[c + 1] < 100, "center should be dimmed panel, got {:?}", &px[c..c + 4]);
    }

    #[test]
    fn renders_video_background_frame() {
        let frame = frame_with(
            None,
            BackgroundSetting::Video(VideoBackground {
                path: "bg.mp4".to_string(),
                object_fit: "cover".to_string(),
                opacity: 1.0,
                loop_video: true,
                muted: true,
                playback_rate: 1.0,
            }),
        );
        let blue = [0u8, 0, 255, 255].repeat(16);
        let mut media = VideoMedia {
            images: HashMap::new(),
            videos: HashMap::from_iter([(
                "bg.mp4".to_string(),
                crate::engine::compositor::media::VideoFrame { width: 4, height: 4, rgba: std::sync::Arc::new(blue) },
            )]),
        };
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        // "cover" fills the whole canvas with the frame.
        let corner = &px[0..4];
        assert!(corner[2] > 200 && corner[0] < 40 && corner[1] < 40, "corner should be blue, got {corner:?}");
    }

    // -- camera arms (Phase I1) ----------------------------------------------

    fn camera_item(device: &str) -> DisplayItem {
        DisplayItem::Camera(crate::store::CameraBackground {
            device_id: device.to_string(),
            opacity: 1.0,
            object_fit: "contain".to_string(),
            mirrored: false,
        })
    }

    #[test]
    fn renders_live_camera_item_frame() {
        let frame = frame_with(Some(camera_item("HD Webcam")), BackgroundSetting::None);
        let key = crate::engine::compositor::media::camera_key_for_device("HD Webcam");
        let red = [255u8, 0, 0, 255].repeat(16);
        let mut media = VideoMedia {
            images: HashMap::new(),
            videos: HashMap::from_iter([(
                key,
                crate::engine::compositor::media::VideoFrame { width: 4, height: 4, rgba: std::sync::Arc::new(red) },
            )]),
        };
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        let c = center_pixel_index();
        assert!(px[c] > 200 && px[c + 1] < 40, "center should be red camera frame, got {:?}", &px[c..c + 4]);
    }

    #[test]
    fn renders_missing_camera_item_panel_without_a_capture() {
        let frame = frame_with(Some(camera_item("Ghost Cam")), BackgroundSetting::None);
        let mut media = VideoMedia { images: HashMap::new(), videos: HashMap::new() };
        let (_, _, px) = render_frame_to_pixels(&frame, &mut media).expect("render");
        let c = center_pixel_index();
        assert!(px[c] < 100, "center should be dimmed panel, got {:?}", &px[c..c + 4]);
    }
}
