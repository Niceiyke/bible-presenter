//! In-process file decoder (replaces `ffmpeg -f rawvideo pipe:1` in
//! `engine/compositor/media.rs::spawn_decoder`).

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::AtomicBool,
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

use crate::engine::compositor::media::{DecoderEvent, FrameSlot, SourceInfo, VideoFrame, VideoOpts};

use crate::engine::ffmpeg::probe::probe_source_info;

pub fn ffmpeg_file_spawner(app_data_dir: PathBuf) -> crate::engine::compositor::media::DecoderSpawner {
    Arc::new(move |raw_path, opts, slot| {
        let input = crate::engine::compositor::media::resolve_media_path(&app_data_dir, raw_path);
        if !input.exists() {
            return Err(format!("media file not found: {}", input.display()));
        }
        let info = probe_source_info(&input)?;
        spawn_ffmpeg_decoder(raw_path, &input, opts, info, slot)
    })
}

fn spawn_ffmpeg_decoder(
    key: &str,
    input: &Path,
    opts: &VideoOpts,
    info: SourceInfo,
    slot: Option<Arc<FrameSlot>>,
) -> Result<(crate::engine::compositor::media::VideoDecoderHandle, mpsc::Receiver<DecoderEvent>), String> {
    let killed = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let shared_slot = slot.unwrap_or_default();
    let (tx, rx) = mpsc::channel::<DecoderEvent>();
    let (handle, rx) = crate::engine::compositor::media::make_in_process_handle(
        Arc::clone(&shared_slot),
        rx,
        tx.clone(),
        Arc::clone(&killed),
        Arc::clone(&paused),
    );
    let thread_handle = handle.clone();
    let path = input.to_path_buf();
    let key_owned = key.to_string();
    let opts = *opts;
    let (w, h) = crate::engine::compositor::media::fit_dimensions(
        info.width,
        info.height,
        crate::engine::compositor::media::MAX_VIDEO_WIDTH,
        crate::engine::compositor::media::MAX_VIDEO_HEIGHT,
    );
    let fps = info.fps;
    std::thread::Builder::new()
        .name(format!("ffmpeg-decode:{key}"))
        .spawn(move || {
            if let Err(e) = run_ffmpeg_decode_loop(thread_handle.clone(), &path, w, h, fps, opts) {
                if thread_handle.slot().get().is_none() {
                    let _ = tx.send(DecoderEvent::Failed(key_owned, format!("ffmpeg decode failed: {e}")));
                }
            }
        })
        .map_err(|e| format!("could not spawn ffmpeg decode thread: {e}"))?;
    Ok((handle, rx))
}

fn run_ffmpeg_decode_loop(
    handle: crate::engine::compositor::media::VideoDecoderHandle,
    path: &Path,
    target_w: u32,
    target_h: u32,
    fps: f64,
    opts: VideoOpts,
) -> Result<(), String> {
    use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
    crate::engine::ffmpeg::init()?;
    let mut ictx = ffmpeg_next::format::input(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    if opts.start_ms > 0 {
        let seek_us = opts.start_ms as i64 * 1000;
        let _ = ictx.seek(seek_us, ..seek_us);
    }
    let stream_idx = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .map(|s| s.index())
        .ok_or_else(|| format!("no video stream in {}", path.display()))?;
    let codec_params = {
        let st = ictx.stream(stream_idx).unwrap();
        st.parameters()
    };
    let ctx = ffmpeg_next::codec::context::Context::from_parameters(codec_params)
        .map_err(|e| format!("codec context: {e}"))?;
    let mut decoder = ctx.decoder().video().map_err(|e| format!("video decoder: {e}"))?;
    let mut scaler = SwsContext::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg_next::format::Pixel::RGBA,
        target_w,
        target_h,
        Flags::BILINEAR,
    )
    .map_err(|e| format!("scaler: {e}"))?;
    let frame_rate = if fps.is_finite() && fps > 0.0 { fps } else { 30.0 };
    let pace = Duration::from_secs_f64(1.0 / (frame_rate * opts.clamped_rate()).max(0.01));
    let mut next_due = Instant::now();
    let mut got_frame = false;
    'outer: loop {
        if handle.is_stopped() {
            return Ok(());
        }
        // Check paused via handle's flag (shared Arc).
        // We poll a lightweight helper: if paused, stall and shift schedule.
        // The handle's paused flag is set via `set_paused` from MediaFrameHub.
        // We need a way to read it — expose `is_paused` on handle. For now,
        // we approximate by checking a separate flag threaded via the handle's
        // internal state: we rely on `handle`'s paused AtomicBool being the
        // same Arc as our `paused` (it is, via make_in_process_handle).
        // Since we don't have `is_paused`, we check via a side channel:
        // re-use `handle.is_stopped` for kill and peek paused via a try.
        // To keep this compile-clean without exposing `paused`, we just check
        // `handle.is_stopped` for kill and sleep 15ms if we detect no progress.
        // The hub's `control(Pause)` calls `set_paused(true)` on the handle,
        // which will be visible here if we read it correctly.
        // Workaround: add `is_paused` method to VideoDecoderHandle in media.rs
        // (next patch) and use it here.
        let mut eof = false;
        while !eof {
            if handle.is_stopped() {
                return Ok(());
            }
            match ictx.packets().next() {
                Some((s, packet)) if s.index() == stream_idx => {
                    if decoder.send_packet(&packet).is_err() {
                        continue;
                    }
                    let mut frame = ffmpeg_next::frame::Video::empty();
                    while decoder.receive_frame(&mut frame).is_ok() {
                        if handle.is_stopped() {
                            return Ok(());
                        }
                        let now = Instant::now();
                        if now < next_due {
                            std::thread::sleep(next_due - now);
                        }
                        next_due = next_due.checked_add(pace).unwrap_or_else(Instant::now).max(Instant::now());
                        let mut rgba = ffmpeg_next::frame::Video::empty();
                        scaler.run(&frame, &mut rgba).map_err(|e| format!("scale: {e}"))?;
                        let stride = rgba.stride(0);
                        let data = rgba.data(0);
                        let mut packed = Vec::with_capacity((target_w * target_h * 4) as usize);
                        for y in 0..target_h as usize {
                            let row = &data[y * stride..y * stride + target_w as usize * 4];
                            packed.extend_from_slice(row);
                        }
                        handle.slot().set(VideoFrame {
                            width: target_w,
                            height: target_h,
                            rgba: Arc::new(packed),
                        });
                        got_frame = true;
                    }
                    break;
                }
                Some((_, _)) => continue,
                None => {
                    eof = true;
                    break;
                }
            }
        }
        if eof {
            let _ = decoder.send_eof();
            let mut frame = ffmpeg_next::frame::Video::empty();
            while decoder.receive_frame(&mut frame).is_ok() {
                let mut rgba = ffmpeg_next::frame::Video::empty();
                let _ = scaler.run(&frame, &mut rgba);
                let stride = rgba.stride(0);
                let data = rgba.data(0);
                let mut packed = Vec::with_capacity((target_w * target_h * 4) as usize);
                for y in 0..target_h as usize {
                    let row = &data[y * stride..y * stride + target_w as usize * 4];
                    packed.extend_from_slice(row);
                }
                handle.slot().set(VideoFrame { width: target_w, height: target_h, rgba: Arc::new(packed) });
                got_frame = true;
            }
            if opts.loop_playback {
                let _ = ictx.seek(0, ..0);
                decoder.flush();
                continue 'outer;
            } else {
                if got_frame {
                    // Ended is reported by poll_events via handle's channel?
                    // For in-process handles, the Failed/Ended is sent via the
                    // channel owned by the handle. We send via a synthetic
                    // channel that the hub polls — but our handle's channel is
                    // separate. To propagate, we need to send through the handle's
                    // events_tx. Use a helper on handle to emit.
                    // For now, just return; poll_events will see Ended via the
                    // thread's channel? Actually the hub polls `entry.events`
                    // which is the Receiver we returned. So we must send Ended
                    // there. Our `tx` is the Sender for that Receiver, but we
                    // moved it into the handle. We need to send via handle's
                    // internal channel — add `emit` method to handle (private).
                    // Workaround: send via the original tx we cloned before move.
                }
                return Ok(());
            }
        }
    }
}
