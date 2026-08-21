//! In-process camera capture via `libavdevice/dshow`.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

use crate::engine::compositor::media::{DecoderEvent, FrameSlot, VideoFrame};

pub fn ffmpeg_camera_spawner() -> crate::engine::compositor::media::DecoderSpawner {
    Arc::new(move |key, _opts, slot| {
        let Some((device, w, h, fps)) = crate::engine::compositor::media::parse_camera_key(key) else {
            return Err(format!("not a camera key: {key}"));
        };
        spawn_ffmpeg_camera(key, &device, w, h, fps, slot)
    })
}

pub fn ffmpeg_source_spawner(app_data_dir: PathBuf) -> crate::engine::compositor::media::DecoderSpawner {
    let files = crate::engine::ffmpeg::decode::ffmpeg_file_spawner(app_data_dir);
    let cams = ffmpeg_camera_spawner();
    Arc::new(move |key, opts, slot| {
        if key.starts_with("cam:") {
            cams(key, opts, slot)
        } else {
            files(key, opts, slot)
        }
    })
}

fn spawn_ffmpeg_camera(
    key: &str,
    device: &str,
    w: u32,
    h: u32,
    fps: f64,
    slot: Option<Arc<FrameSlot>>,
) -> Result<(crate::engine::compositor::media::VideoDecoderHandle, mpsc::Receiver<DecoderEvent>), String> {
    crate::engine::ffmpeg::init()?;
    let shared_slot = slot.unwrap_or_default();
    let killed = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<DecoderEvent>();
    let (handle, rx) = crate::engine::compositor::media::make_in_process_handle(
        Arc::clone(&shared_slot),
        rx,
        tx.clone(),
        Arc::clone(&killed),
        Arc::clone(&paused),
    );
    let thread_handle = handle.clone();
    let device_owned = device.to_string();
    let key_owned = key.to_string();
    std::thread::Builder::new()
        .name(format!("ffmpeg-cam:{device}"))
        .spawn(move || {
            if let Err(e) = run_camera_loop(&device_owned, w, h, fps, thread_handle.clone()) {
                let _ = tx.send(DecoderEvent::Failed(key_owned, e));
            }
        })
        .map_err(|e| format!("could not spawn camera thread: {e}"))?;
    Ok((handle, rx))
}

fn run_camera_loop(
    device: &str,
    target_w: u32,
    target_h: u32,
    fps: f64,
    handle: crate::engine::compositor::media::VideoDecoderHandle,
) -> Result<(), String> {
    use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
    let input_name = format!("video={device}");
    let mut ictx = ffmpeg_next::format::input(&input_name)
        .map_err(|e| format!("could not open camera {device}: {e}"))?;
    let stream_idx = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .map(|s| s.index())
        .ok_or_else(|| format!("no video stream for camera {device}"))?;
    let codec_params = ictx.stream(stream_idx).unwrap().parameters();
    let mut ctx = ffmpeg_next::codec::context::Context::from_parameters(codec_params)
        .map_err(|e| format!("camera codec context: {e}"))?;
    let mut decoder = ctx.decoder().video().map_err(|e| format!("camera decoder: {e}"))?;
    let mut scaler = SwsContext::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg_next::format::Pixel::RGBA,
        target_w,
        target_h,
        Flags::BILINEAR,
    )
    .map_err(|e| format!("camera scaler: {e}"))?;
    for (s, packet) in ictx.packets() {
        if handle.is_stopped() {
            return Ok(());
        }
        if s.index() != stream_idx {
            continue;
        }
        if decoder.send_packet(&packet).is_err() {
            continue;
        }
        let mut frame = ffmpeg_next::frame::Video::empty();
        while decoder.receive_frame(&mut frame).is_ok() {
            if handle.is_stopped() {
                return Ok(());
            }
            let mut rgba = ffmpeg_next::frame::Video::empty();
            scaler.run(&frame, &mut rgba).map_err(|e| format!("scale: {e}"))?;
            let stride = rgba.stride(0);
            let data = rgba.data(0);
            let mut packed = Vec::with_capacity((target_w * target_h * 4) as usize);
            for y in 0..target_h as usize {
                let row = &data[y * stride..y * stride + target_w as usize * 4];
                packed.extend_from_slice(row);
            }
            handle.slot().set(VideoFrame { width: target_w, height: target_h, rgba: Arc::new(packed) });
        }
    }
    Err(format!("camera {device} stream ended"))
}
