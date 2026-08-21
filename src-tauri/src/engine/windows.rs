//! Engine-owned output/stage windows (Phase C).
//!
//! Runs the winit event loop on a dedicated background thread; the stdio
//! JSON-RPC dispatch loop stays on the main thread (Phase C threading decision).
//! The host manages one [`HostedWindow`] per engine window (output, stage),
//! each backed by its own wgpu [`Compositor`] window-surface path. Frames are
//! pulled from a shared per-label slot: the engine thread publishes the latest
//! resolved [`ProgramFrame`] (keyed by presentation revision); the host
//! re-renders on each redraw at the capture frame rate. Monitor enumeration and
//! positioning live here; the IPC layer (Phase C2) drives show/hide/set-monitor
//! via [`WindowCommand`]s sent through the [`EventLoopProxy`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock};

use winit::application::ApplicationHandler;
use winit::dpi::{PhysicalPosition, PhysicalSize, Position};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId};

use serde::{Deserialize, Serialize};

use crate::engine::compositor::renderer::{Compositor, ImageData, MediaResolver};
use crate::engine::compositor::ProgramFrame;

/// A monitor as seen by the engine (surfaced to the console via IPC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub name: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

/// Window presentation attributes (mirrors the persisted output config's
/// appearance flags). Serialized over the engine IPC so the console can create
/// windows with the right decorations/transparency/z-order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowStyle {
    pub decorations: bool,
    pub transparent: bool,
    pub always_on_top: bool,
    pub resizable: bool,
}

impl Default for WindowStyle {
    fn default() -> Self {
        Self { decorations: true, transparent: false, always_on_top: false, resizable: true }
    }
}

/// Commands the engine main thread sends to the window host thread.
#[derive(Debug, Clone)]
pub enum WindowCommand {
    /// Show (or create) the window for `label`. `preferred_monitor` names the
    /// monitor to place it on (falls back to the primary monitor).
    Show {
        label: String,
        style: WindowStyle,
        preferred_monitor: Option<String>,
        width: u32,
        height: u32,
    },
    Hide { label: String },
    SetMonitor { label: String, monitor: String },
    Resize { label: String, width: u32, height: u32 },
    ListMonitors { reply: mpsc::Sender<Vec<MonitorInfo>> },
    /// Request a redraw on every hosted window (used after a frame publish).
    RedrawAll,
    Shutdown,
}

/// Latest resolved frame shared between the engine thread and the window host.
#[derive(Debug, Clone)]
pub struct SharedFrame {
    pub revision: u64,
    pub frame: Arc<ProgramFrame>,
}

/// Handle to the window host from the engine main thread.
pub struct WindowHostHandle {
    proxy: EventLoopProxy<WindowCommand>,
    frames: Arc<RwLock<HashMap<String, SharedFrame>>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl WindowHostHandle {
    /// Publish the latest resolved frame for a window label. The host renders it
    /// on its next redraw; a revision change triggers an immediate redraw.
    pub fn publish_frame(&self, label: &str, frame: SharedFrame) {
        let changed = {
            let slot = self.frames.read().unwrap();
            slot.get(label).is_none_or(|f| f.revision != frame.revision)
        };
        if changed {
            self.frames.write().unwrap().insert(label.to_string(), frame);
            let _ = self.proxy.send_event(WindowCommand::RedrawAll);
        }
    }

    /// Send a command to the host thread.
    pub fn send(&self, cmd: WindowCommand) {
        let _ = self.proxy.send_event(cmd);
    }

    /// Enumerate monitors from the host's event loop.
    pub fn list_monitors(&self) -> Option<Vec<MonitorInfo>> {
        let (tx, rx) = mpsc::channel();
        self.send(WindowCommand::ListMonitors { reply: tx });
        rx.recv_timeout(std::time::Duration::from_secs(2)).ok()
    }

    /// Shut the host thread down and join it.
    pub fn shutdown(mut self) {
        let _ = self.proxy.send_event(WindowCommand::Shutdown);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for WindowHostHandle {
    fn drop(&mut self) {
        let _ = self.proxy.send_event(WindowCommand::Shutdown);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

/// Media resolver that loads images from disk. Persisted (relativized) paths
/// are relative to the app data dir's `media/` subdirectory — mirroring
/// `resolvePath` in `src/utils/index.ts` (`{baseDir}\media\{path}`); absolute
/// paths pass through.
#[derive(Debug, Clone)]
pub struct DiskMediaResolver {
    pub app_data_dir: PathBuf,
}

impl MediaResolver for DiskMediaResolver {
    fn load_image(&mut self, path: &str) -> Option<ImageData> {
        let raw = PathBuf::from(path);
        let full = if raw.is_absolute() {
            raw
        } else {
            self.app_data_dir.join("media").join(raw)
        };
        let img = image::open(&full).ok()?.to_rgba8();
        let (width, height) = img.dimensions();
        Some(ImageData { width, height, rgba: img.into_raw() })
    }
}

/// A preview-frame sink: the host pushes a downscaled, JPEG-encoded frame for a
/// window after rendering it. The engine runtime wraps this to emit
/// `EngineEvent::PreviewFrame` with the bytes base64-encoded.
pub type PreviewSink = Arc<dyn Fn(String, u64, u32, u32, Vec<u8>) + Send + Sync>;

/// Spawn the window host on a background thread and return a handle.
pub fn spawn(app_data_dir: PathBuf, preview_sink: PreviewSink) -> anyhow::Result<WindowHostHandle> {
    let frames = Arc::new(RwLock::new(HashMap::<String, SharedFrame>::new()));
    let frames_for_thread = Arc::clone(&frames);
    let (proxy_tx, proxy_rx) = mpsc::channel();

    let join = std::thread::Builder::new()
        .name("wordlyte-windows".into())
        .spawn(move || {
            let mut builder = EventLoop::<WindowCommand>::with_user_event();
            // The host runs on a dedicated background thread (not the main
            // thread). winit 0.30 panics unless this is allowed explicitly.
            #[cfg(target_os = "windows")]
            {
                use winit::platform::windows::EventLoopBuilderExtWindows;
                builder.with_any_thread(true);
            }
            let event_loop = match builder.build() {
                Ok(el) => el,
                Err(e) => {
                    eprintln!("[engine] window host: event loop error: {e}");
                    return;
                }
            };
            let proxy = event_loop.create_proxy();
            let _ = proxy_tx.send(proxy);
            let mut app = WindowHostApp {
                windows: HashMap::new(),
                frames: frames_for_thread,
                app_data_dir,
                preview_sink,
            };
            let _ = event_loop.run_app(&mut app);
        })?;

    let proxy = proxy_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| anyhow::anyhow!("window host did not start in time"))?;
    Ok(WindowHostHandle { proxy, frames, join: Some(join) })
}

/// One hosted engine window: the winit window plus its compositor and media
/// resolver. The compositor is created lazily on the first `Show` so the host
/// can start with no GPU work until a window is needed.
struct HostedWindow {
    label: String,
    window: Arc<Window>,
    width: u32,
    height: u32,
    visible: bool,
    preferred_monitor: Option<String>,
    compositor: Option<Compositor>,
    media: DiskMediaResolver,
    last_revision: Option<u64>,
    /// Per-window monotonic preview frame counter.
    preview_index: u64,
    /// Throttle for MJPEG preview emission (see `PREVIEW_INTERVAL`).
    preview_last: std::time::Instant,
}

/// Preview emission cadence: 10 fps keeps the stdio JSON event channel cheap
/// while staying smooth enough to verify the engine's windows.
const PREVIEW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
/// Preview target width; the captured frame is downscaled to it (aspect
/// preserving) before JPEG encoding.
const PREVIEW_WIDTH: u32 = 480;

impl HostedWindow {
    fn show(&mut self, event_loop: &ActiveEventLoop) {
        self.window.set_visible(true);
        self.visible = true;
        self.place_on_preferred_monitor(event_loop);
        self.window.request_redraw();
    }

    fn hide(&mut self) {
        self.window.set_visible(false);
        self.visible = false;
    }

    /// Position the window centered on its preferred monitor, falling back to
    /// the primary monitor when the preferred one is not found.
    fn place_on_preferred_monitor(&self, event_loop: &ActiveEventLoop) {
        let monitors: Vec<_> = event_loop.available_monitors().collect();
        let primary = event_loop.primary_monitor();
        let chosen = self
            .preferred_monitor
            .as_ref()
            .and_then(|name| monitors.iter().find(|m| m.name().as_deref() == Some(name.as_str())))
            .or(primary.as_ref())
            .or_else(|| monitors.first());
        let Some(monitor) = chosen else { return };
        let size = monitor.size();
        let origin = monitor.position();
        let x = origin.x + ((size.width as i32 - self.width as i32) / 2).max(0);
        let y = origin.y + ((size.height as i32 - self.height as i32) / 2).max(0);
        self.window.set_outer_position(Position::Physical(PhysicalPosition::new(x, y)));
    }

    /// Render the latest published frame for this window, or clear to black when
    /// none has been published yet. Frames are re-rendered on every redraw so
    /// timer/clock content advances even when the presentation revision is
    /// unchanged; the swapchain present itself is skipped while occluded.
    fn draw(&mut self, frames: &RwLock<HashMap<String, SharedFrame>>, preview_sink: &PreviewSink) {
        let frame = frames.read().unwrap().get(&self.label).cloned();
        if let Some(compositor) = &mut self.compositor {
            match frame {
                Some(shared) => {
                    self.last_revision = Some(shared.revision);
                    let _ = compositor.present(&shared.frame, &mut self.media);
                }
                None => {
                    compositor.clear([0.0, 0.0, 0.0, 1.0]);
                }
            }
        } else {
            return;
        }
        self.emit_preview(preview_sink);
    }

    /// Downscale + JPEG-encode the just-rendered frame and push it through the
    /// preview sink, throttled to `PREVIEW_INTERVAL` and only while visible.
    fn emit_preview(&mut self, preview_sink: &PreviewSink) {
        if !self.visible || self.preview_last.elapsed() < PREVIEW_INTERVAL {
            return;
        }
        let Some(compositor) = &mut self.compositor else { return };
        let (w, h, rgba) = compositor.read_pixels();
        let Some((pw, ph, jpeg)) = encode_preview(&rgba, w, h, PREVIEW_WIDTH) else { return };
        self.preview_last = std::time::Instant::now();
        self.preview_index += 1;
        preview_sink(self.label.clone(), self.preview_index, pw, ph, jpeg);
    }
}

/// Downscale RGBA pixels to `target_width` (aspect preserving) and JPEG-encode
/// them. Returns `(width, height, jpeg_bytes)` or `None` when the input is
/// empty / the encode fails. Uses nearest-neighbor sampling — plenty for a low-res
/// console preview.
fn encode_preview(
    rgba: &[u8],
    width: u32,
    height: u32,
    target_width: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if width == 0 || height == 0 || target_width == 0 || rgba.len() < (width * height * 4) as usize {
        return None;
    }
    let pw = target_width.min(width);
    let ph = ((height as u64 * pw as u64) / width as u64).max(1) as u32;
    let mut out = Vec::with_capacity((pw * ph * 4) as usize);
    for y in 0..ph {
        let sy = ((y as u64 * height as u64) / ph as u64) as u32;
        for x in 0..pw {
            let sx = ((x as u64 * width as u64) / pw as u64) as u32;
            let si = ((sy * width + sx) * 4) as usize;
            out.extend_from_slice(&rgba[si..si + 4]);
        }
    }
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 65)
        .encode(&out, pw as u16, ph as u16, jpeg_encoder::ColorType::Rgba)
        .ok()?;
    Some((pw, ph, jpeg))
}

struct WindowHostApp {
    windows: HashMap<String, HostedWindow>,
    frames: Arc<RwLock<HashMap<String, SharedFrame>>>,
    app_data_dir: PathBuf,
    preview_sink: PreviewSink,
}

impl WindowHostApp {
    fn create_or_show(
        &mut self,
        event_loop: &ActiveEventLoop,
        label: &str,
        style: WindowStyle,
        preferred_monitor: Option<String>,
        width: u32,
        height: u32,
    ) {
        if let Some(win) = self.windows.get_mut(label) {
            win.preferred_monitor = preferred_monitor;
            if win.width != width || win.height != height {
                win.width = width;
                win.height = height;
                if let Some(c) = &mut win.compositor {
                    let _ = c.resize(width, height);
                }
                let _ = win.window.request_inner_size(PhysicalSize::new(width, height));
            }
            win.show(event_loop);
            return;
        }

        let mut attrs = WindowAttributes::default()
            .with_title(format!("Wordlyte · {label}"))
            .with_inner_size(PhysicalSize::new(width, height))
            .with_visible(false)
            .with_decorations(style.decorations)
            .with_resizable(style.resizable)
            .with_transparent(style.transparent);
        if style.always_on_top {
            attrs = attrs.with_window_level(winit::window::WindowLevel::AlwaysOnTop);
        }
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                eprintln!("[engine] window host: could not create window {label}: {e}");
                return;
            }
        };
        let compositor = match Compositor::new_surface(Arc::clone(&window), width, height) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[engine] window host: compositor for {label} failed: {e}");
                None
            }
        };
        let mut win = HostedWindow {
            label: label.to_string(),
            window,
            width,
            height,
            visible: false,
            preferred_monitor,
            compositor,
            media: DiskMediaResolver { app_data_dir: self.app_data_dir.clone() },
            last_revision: None,
            preview_index: 0,
            preview_last: std::time::Instant::now(),
        };
        win.show(event_loop);
        self.windows.insert(label.to_string(), win);
    }

    fn resize(&mut self, label: &str, width: u32, height: u32) {
        let Some(win) = self.windows.get_mut(label) else { return };
        win.width = width;
        win.height = height;
        if let Some(c) = &mut win.compositor {
            let _ = c.resize(width, height);
        }
        let _ = win.window.request_inner_size(PhysicalSize::new(width, height));
    }

    fn set_monitor(&mut self, event_loop: &ActiveEventLoop, label: &str, monitor: &str) {
        let Some(win) = self.windows.get_mut(label) else { return };
        win.preferred_monitor = Some(monitor.to_string());
        win.place_on_preferred_monitor(event_loop);
    }

    fn list_monitors(&self, event_loop: &ActiveEventLoop) -> Vec<MonitorInfo> {
        let primary = event_loop.primary_monitor();
        let mut out: Vec<MonitorInfo> = event_loop
            .available_monitors()
            .map(|m| {
                let pos = m.position();
                let size = m.size();
                let name = m.name().unwrap_or_else(|| "Monitor".to_string());
                let is_primary = primary.as_ref() == Some(&m);
                MonitorInfo {
                    name,
                    primary: is_primary,
                    x: pos.x,
                    y: pos.y,
                    width: size.width,
                    height: size.height,
                    scale_factor: m.scale_factor(),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.primary.cmp(&a.primary).then_with(|| a.name.cmp(&b.name))
        });
        out
    }

    fn redraw_all(&mut self) {
        for win in self.windows.values_mut() {
            if win.visible {
                win.window.request_redraw();
            }
        }
    }
}

impl ApplicationHandler<WindowCommand> for WindowHostApp {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: WindowCommand) {
        match event {
            WindowCommand::Show { label, style, preferred_monitor, width, height } => {
                self.create_or_show(event_loop, &label, style, preferred_monitor, width, height);
            }
            WindowCommand::Hide { label } => {
                if let Some(win) = self.windows.get_mut(&label) {
                    win.hide();
                }
            }
            WindowCommand::SetMonitor { label, monitor } => {
                self.set_monitor(event_loop, &label, &monitor);
            }
            WindowCommand::Resize { label, width, height } => {
                self.resize(&label, width, height);
            }
            WindowCommand::ListMonitors { reply } => {
                let _ = reply.send(self.list_monitors(event_loop));
            }
            WindowCommand::RedrawAll => self.redraw_all(),
            WindowCommand::Shutdown => event_loop.exit(),
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(label) = self
                .windows
                .iter()
                .find(|(_, w)| w.window.id() == window_id)
                .map(|(label, _)| label.clone())
            {
                self.windows.remove(&label);
            }
            return;
        }
        let Some(win) = self.windows.values_mut().find(|w| w.window.id() == window_id) else {
            return;
        };
        match event {
            WindowEvent::Resized(size) => {
                win.width = size.width;
                win.height = size.height;
                if let Some(c) = &mut win.compositor {
                    let _ = c.resize(size.width, size.height);
                }
                win.window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { mut inner_size_writer, .. } => {
                let _ = inner_size_writer.request_inner_size(PhysicalSize::new(win.width, win.height));
            }
            WindowEvent::RedrawRequested => {
                let frames = Arc::clone(&self.frames);
                win.draw(&frames, &self.preview_sink);
            }
            WindowEvent::CloseRequested => {
                // Closing an output/stage window hides it; the engine re-syncs
                // visibility back to the console (Phase C2).
                win.hide();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let any_visible = self.windows.values().any(|w| w.visible);
        if any_visible {
            // Render at the capture frame rate while windows are showing.
            event_loop.set_control_flow(ControlFlow::WaitUntil(
                std::time::Instant::now() + std::time::Duration::from_millis(33),
            ));
            self.redraw_all();
        } else {
            event_loop.set_control_flow(ControlFlow::Wait);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_style_defaults() {
        let s = WindowStyle::default();
        assert!(s.decorations);
        assert!(!s.transparent);
        assert!(!s.always_on_top);
        assert!(s.resizable);
    }

    #[test]
    fn disk_resolver_absolute_path_wins() {
        let mut r = DiskMediaResolver { app_data_dir: PathBuf::from("C:\\missing") };
        // Absolute path bypasses the app data dir.
        assert!(r.load_image("C:\\definitely\\missing.png").is_none());
    }

    #[test]
    fn disk_resolver_joins_media_dir_for_relative_paths() {
        // Regression: persisted paths are relativized against the `media/`
        // subdirectory (relativizePath), so a bare filename must resolve to
        // `{app_data_dir}/media/{name}` — not `{app_data_dir}/{name}`.
        let base = std::env::temp_dir().join(format!("wordlyte-resolver-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(base.join("media")).expect("mkdir");
        // 1x1 red PNG written via the same `image` crate the resolver decodes with.
        image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))
            .save(base.join("media").join("dot.png"))
            .expect("write");
        let mut r = DiskMediaResolver { app_data_dir: base.clone() };
        let img = r.load_image("dot.png").expect("relative path must resolve into media/");
        assert_eq!((img.width, img.height), (1, 1));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn monitor_info_is_comparable() {
        let a = MonitorInfo {
            name: "A".into(),
            primary: true,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        };
        let b = a.clone();
        assert_eq!(a, b);
        assert!(a.primary);
    }

    #[test]
    fn encode_preview_downscales_and_produces_jpeg() {
        // 64x32 solid red frame.
        let (w, h) = (64u32, 32u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            rgba.extend_from_slice(&[255, 0, 0, 255]);
        }
        let (pw, ph, jpeg) = encode_preview(&rgba, w, h, 480).unwrap();
        // Target width caps at source width.
        assert_eq!((pw, ph), (64, 32));
        // JPEG SOI marker (FFD8) — a real encode, not an empty vec.
        assert!(jpeg.starts_with(&[0xFF, 0xD8]));

        // Downscaling a 128x64 frame to 480-wide keeps the 2:1 aspect.
        let (w2, h2) = (128u32, 64u32);
        let mut rgba2 = Vec::with_capacity((w2 * h2 * 4) as usize);
        for _ in 0..w2 * h2 {
            rgba2.extend_from_slice(&[0, 255, 0, 255]);
        }
        let (pw2, ph2, jpeg2) = encode_preview(&rgba2, w2, h2, 480).unwrap();
        assert_eq!((pw2, ph2), (128, 64));
        assert!(jpeg2.starts_with(&[0xFF, 0xD8]));
    }

    #[test]
    fn encode_preview_rejects_bad_inputs() {
        assert!(encode_preview(&[], 0, 0, 480).is_none());
        assert!(encode_preview(&[1, 2, 3], 1, 1, 480).is_none());
        assert!(encode_preview(&[0; 4], 1, 1, 0).is_none());
    }
}