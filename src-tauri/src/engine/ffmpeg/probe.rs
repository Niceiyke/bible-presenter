//! Probe helpers — `ffmpeg_next` replacements for `ffprobe` CLI parses.
//!
//! Used by `store/media_schedule.rs::probe_video` and
//! `engine/compositor/media.rs::probe_source` / `parse_probe_output` when the
//! `ffmpeg-next` feature is enabled. One `avformat_open_input` returns width,
//! height, fps and duration atomically — no subprocess, no stdout parse.

use std::path::Path;

use crate::engine::compositor::media::SourceInfo;

/// Probe one file via libavformat. Returns `None` if the file cannot be opened
/// or has no video stream. Mirrors `parse_probe_output` clamping (fps 1..60).
pub fn probe_source_info(path: &Path) -> Result<SourceInfo, String> {
    crate::engine::ffmpeg::init()?;
    let ictx = ffmpeg_next::format::input(path).map_err(|e| format!("ffmpeg open failed for {}: {e}", path.display()))?;
    let stream = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .ok_or_else(|| format!("no video stream in {}", path.display()))?;
    let codec_params = stream.parameters();
    // Parameters in ffmpeg-next 9.0 does not expose width/height directly; go via decoder context.
    let ctx = ffmpeg_next::codec::context::Context::from_parameters(codec_params)
        .map_err(|e| format!("codec context failed: {e}"))?;
    let dec = ctx.decoder().video().map_err(|e| format!("video decoder failed: {e}"))?;
    let (w, h) = (dec.width(), dec.height());
    if w == 0 || h == 0 {
        return Err(format!("could not determine dimensions for {}", path.display()));
    }
    Ok(SourceInfo { width: w, height: h, fps: fps_from_stream(&stream) })
}

fn fps_from_stream(stream: &ffmpeg_next::format::stream::Stream) -> f64 {
    // Prefer avg_frame_rate, then r_frame_rate, then codec framerate.
    let fps = stream.avg_frame_rate();
    let mut v = rational_to_f64(fps);
    if !v.is_finite() || v <= 0.0 {
        v = rational_to_f64(stream.rate());
    }
    if !v.is_finite() || v <= 0.0 {
        // Last resort: 30.
        v = 30.0;
    }
    v.clamp(1.0, 60.0)
}

fn rational_to_f64(r: ffmpeg_next::Rational) -> f64 {
    let d = r.denominator() as f64;
    if d == 0.0 {
        return f64::NAN;
    }
    r.numerator() as f64 / d
}

/// Duration in seconds via libavformat, if present.
pub fn probe_duration_secs(path: &Path) -> Option<f64> {
    let _ = crate::engine::ffmpeg::init();
    let ictx = ffmpeg_next::format::input(path).ok()?;
    let dur = ictx.duration(); // microseconds, AV_NOPTS_VALUE if unknown
    if dur == ffmpeg_next::ffi::AV_NOPTS_VALUE || dur <= 0 {
        return None;
    }
    Some(dur as f64 / 1_000_000.0)
}

/// Thumbnail extraction in-process: seek to `seek_secs`, decode first video
/// frame, scale to 320w, and write as JPEG to `out_jpg`. Returns `true` on
/// success. Replaces the `ffmpeg -ss 1 -frames:v 1 -vf scale=320:-1` spawn.
pub fn probe_thumbnail(path: &Path, out_jpg: &Path, seek_secs: f64) -> bool {
    use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
    use std::fs;

    let Ok(()) = crate::engine::ffmpeg::init() else { return false };
    let mut ictx = match ffmpeg_next::format::input(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let video_idx = match ictx.streams().best(ffmpeg_next::media::Type::Video) {
        Some(s) => s.index(),
        None => return false,
    };
    // Seek to requested position if seekable.
    let seek_ts = (seek_secs * 1_000_000.0) as i64;
    let _ = ictx.seek(seek_ts, ..seek_ts);
    let stream = ictx.stream(video_idx).unwrap();
    let time_base = stream.time_base();
    let codec_params = stream.parameters();
    let ctx = match ffmpeg_next::codec::context::Context::from_parameters(codec_params) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut decoder = match ctx.decoder().video() {
        Ok(d) => d,
        Err(_) => return false,
    };
    // Target thumb width 320, height aspect-preserved.
    let src_w = decoder.width();
    let src_h = decoder.height();
    if src_w == 0 || src_h == 0 {
        return false;
    }
    let thumb_w: u32 = 320;
    let thumb_h: u32 = ((src_h as f64 * thumb_w as f64 / src_w as f64).round() as u32).max(1);
    let mut scaler = match SwsContext::get(
        decoder.format(),
        src_w,
        src_h,
        ffmpeg_next::format::Pixel::RGB24,
        thumb_w,
        thumb_h,
        Flags::BILINEAR,
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut decoded: Option<ffmpeg_next::frame::Video> = None;
    for (stream, packet) in ictx.packets() {
        if stream.index() != video_idx {
            continue;
        }
        if decoder.send_packet(&packet).is_err() {
            continue;
        }
        let mut frame = ffmpeg_next::frame::Video::empty();
        while decoder.receive_frame(&mut frame).is_ok() {
            // Correct pts after seek — skip frames before seek target.
            if seek_secs > 0.0 {
                let pts_secs = frame
                    .timestamp()
                    .map(|pts| pts as f64 * f64::from(time_base))
                    .unwrap_or(0.0);
                if pts_secs + 0.05 < seek_secs {
                    continue;
                }
            }
            decoded = Some(frame);
            break;
        }
        if decoded.is_some() {
            break;
        }
    }
    // Flush if nothing decoded yet.
    if decoded.is_none() {
        let _ = decoder.send_eof();
        let mut frame = ffmpeg_next::frame::Video::empty();
        if decoder.receive_frame(&mut frame).is_ok() {
            decoded = Some(frame);
        }
    }
    let frame = match decoded {
        Some(f) => f,
        None => return false,
    };
    let mut rgb = ffmpeg_next::frame::Video::empty();
    if scaler.run(&frame, &mut rgb).is_err() {
        return false;
    }
    // Encode RGB24 thumb via `image` crate as JPEG (avoids libavcodec jpeg encoder).
    let data = rgb.data(0);
    let stride = rgb.stride(0);
    // Pack tightly (ffmpeg may pad stride).
    let mut packed = Vec::with_capacity((thumb_w * thumb_h * 3) as usize);
    for y in 0..thumb_h as usize {
        let row = &data[y * stride..y * stride + thumb_w as usize * 3];
        packed.extend_from_slice(row);
    }
    let img = match image::RgbImage::from_raw(thumb_w, thumb_h, packed) {
        Some(i) => i,
        None => return false,
    };
    let mut out = match fs::File::create(out_jpg) {
        Ok(f) => f,
        Err(_) => return false,
    };
    use std::io::BufWriter;
    let mut w = BufWriter::new(&mut out);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 80);
    enc.encode_image(&img).is_ok()
}
