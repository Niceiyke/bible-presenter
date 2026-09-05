//! Program audio feed (Phase 7).
//!
//! The recorder (`RecordingSession`) and the streaming hub (`BroadcastSession`)
//! are both video-only today. This module adds the shared "program audio bus":
//! an external mic / line-in / mixer feed captured and AAC-encoded by the
//! frontend is fed to the backend over IPC and re-fed to ffmpeg as a second
//! ADTS input over a loopback TCP socket, so audio is muxed (`-c:a copy`) into
//! recordings and streams without re-encoding.
//!
//! `AudioFeed` owns one loopback `TcpListener` and a writer thread that accepts
//! ffmpeg's `-f aac -i tcp://127.0.0.1:PORT` (demuxer `aac` for ADTS) connection
//! (non-blocking, buffering anything that arrives before the handshake) and
//! drains the bounded channel into the socket. This is the same transport the
//! legacy `rtmp.rs` path used; here it is factored into a reusable feed so the
//! native recorder and the multi-destination broadcaster share one
//! implementation. `close()` drops the sender and joins the writer so the socket
//! is closed (EOF) deterministically BEFORE the caller waits on ffmpeg.

use base64::Engine as _;
use std::io::Write;
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// Max packets buffered per feed before the newest is dropped. ADTS AAC frames
/// are small (~50-300 B/frame at 44.1 kHz); 512 frames is ample to absorb a
/// jitter spike without an unbounded memory cascade.
const MAX_QUEUED_PACKETS: usize = 512;
/// Largest single encoded packet accepted over IPC (guards runaway input).
const MAX_PACKET_BYTES: usize = 8 * 1024 * 1024;

/// A single program-audio loopback feed. Holds a clone of the channel sender so
/// the writer thread stays alive; `close()` (or dropping the feed) closes the
/// channel, which makes the writer close the socket (EOF) and ffmpeg finalize
/// the AAC stream.
pub struct AudioFeed {
    /// Loopback TCP port ffmpeg should read `-f aac` (ADTS) from.
    port: u16,
    _tx: Option<mpsc::Sender<Vec<u8>>>,
    writer: Option<std::thread::JoinHandle<()>>,
    queued: Arc<AtomicUsize>,
}

impl AudioFeed {
    /// Bind a loopback listener and spawn the accept+writer thread. Returns
    /// `None` if the listener cannot be bound (rare on 127.0.0.1:0).
    pub fn spawn() -> Result<AudioFeed, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to open the audio input socket: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(AtomicUsize::new(0));
        let counter = queued.clone();
        let _ = listener.set_nonblocking(true);
        let writer = std::thread::Builder::new()
            .name("program-audio-writer".to_string())
            .spawn(move || {
                let mut pending: Vec<Vec<u8>> = Vec::new();
                // Accept ffmpeg's incoming TCP connection, buffering anything
                // that arrives before the handshake. Poll both the (non-blocking)
                // listener and the channel so data is queued even if ffmpeg
                // connects late; the loop only ends when ffmpeg connects or this
                // feed is closed (channel disconnect).
                let mut stream = loop {
                    if let Ok((s, _)) = listener.accept() {
                        break s;
                    }
                    match rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(data) => pending.push(data),
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                };
                for data in pending {
                    counter.fetch_sub(1, Ordering::SeqCst);
                    if stream.write_all(&data).is_err() {
                        return;
                    }
                }
                while let Ok(data) = rx.recv() {
                    counter.fetch_sub(1, Ordering::SeqCst);
                    if stream.write_all(&data).is_err() {
                        break; // ffmpeg closed the socket
                    }
                    let _ = stream.flush();
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(AudioFeed { port, _tx: Some(tx), writer: Some(writer), queued })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Close the feed deterministically: drop the sender so the writer sees the
    /// channel disconnect, closes the socket (EOF), and exits — then wait for it.
    /// Call this BEFORE waiting on ffmpeg so both inputs hit EOF and the muxer
    /// finalizes (otherwise `child.wait()` blocks forever and files are lost).
    pub fn close(&mut self) {
        let _ = self._tx.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }

    /// Enqueue an ADTS AAC packet with bounded drop-newest backpressure.
    /// `Ok(true)` = queued, `Ok(false)` = dropped (full), `Err` = writer closed.
    pub fn send(&self, data: Vec<u8>) -> Result<bool, String> {
        if self.queued.load(Ordering::SeqCst) >= MAX_QUEUED_PACKETS {
            return Ok(false);
        }
        self.queued.fetch_add(1, Ordering::SeqCst);
        let Some(tx) = self._tx.as_ref() else {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err("Program-audio feed is closed.".to_string());
        };
        match tx.send(data) {
            Ok(()) => Ok(true),
            Err(_) => {
                self.queued.fetch_sub(1, Ordering::SeqCst);
                Err("Program-audio writer closed (ffmpeg exited).".to_string())
            }
        }
    }
}

/// Decode + validate an ADTS packet from an IPC base64 payload.
pub(crate) fn decode_packet(data_base64: &str) -> Result<Vec<u8>, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("Invalid program-audio packet: {e}"))?;
    if data.len() > MAX_PACKET_BYTES {
        return Err("Program-audio packet exceeds the size limit.".into());
    }
    Ok(data)
}

/// Fan one ADTS AAC frame (base64 over IPC) out to EVERY active audio consumer:
/// the recording's feed and every audio-enabled streaming destination. This is
/// the single dispatch the frontend calls per encoded frame — the recording and
/// streaming commands remain for legacy/callers that target one surface.
#[tauri::command]
pub fn program_audio_send(state: tauri::State<'_, crate::state::AppState>, data_base64: String) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Premium)?;
    let packet = decode_packet(&data_base64)?;
    send_to_recording(&state, &packet)?;
    send_to_streaming(&state, &packet)?;
    Ok(())
}

/// Number of active audio consumers (a recording with an attached feed + the
/// broadcast with its shared feed). The frontend gates its encoder on this so
/// the AAC encode + IPC churn stop when the bus is armed but nothing is
/// actually consuming.
#[tauri::command]
pub fn program_audio_consumers(state: tauri::State<'_, crate::state::AppState>) -> u32 {
    if crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Premium).is_err() {
        return 0;
    }
    let mut n = 0u32;
    if state
        .recording
        .lock()
        .as_ref()
        .and_then(|s| s.audio.as_ref())
        .is_some()
    {
        n += 1;
    }
    if let Some(b) = state.streaming.lock().as_ref() {
        if b.audio.is_some() {
            n += 1;
        }
    }
    n
}

fn send_to_recording(state: &crate::state::AppState, packet: &[u8]) -> Result<(), String> {
    let guard = state.recording.lock();
    match guard.as_ref().and_then(|s| s.audio.as_ref()) {
        Some(feed) => {
            let _ = feed.send(packet.to_vec())?;
            Ok(())
        }
        None => Ok(()), // recording without audio — ignore
    }
}

fn send_to_streaming(state: &crate::state::AppState, packet: &[u8]) -> Result<(), String> {
    let guard = state.streaming.lock();
    match guard.as_ref().and_then(|b| b.audio.as_ref()) {
        // The broadcast owns ONE feed muxed into every tee target.
        Some(feed) => {
            let _ = feed.send(packet.to_vec())?;
            Ok(())
        }
        None => Ok(()), // broadcast without audio — ignore
    }
}

/// Feed one ADTS AAC frame (base64 over IPC) to the active recording's audio
/// input. No-op when the recording has no audio feed (recording started video-only).
#[tauri::command]
pub fn recording_send_audio(state: tauri::State<'_, crate::state::AppState>, data_base64: String) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Premium)?;
    let packet = decode_packet(&data_base64)?;
    send_to_recording(&state, &packet)?;
    Ok(())
}

/// Feed one ADTS AAC frame (base64 over IPC) to every audio-enabled destination
/// of the live broadcast. No-op when no destination has an audio feed.
#[tauri::command]
pub fn stream_rtmp_send_audio(state: tauri::State<'_, crate::state::AppState>, data_base64: String) -> Result<(), String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Premium)?;
    let packet = decode_packet(&data_base64)?;
    send_to_streaming(&state, &packet)?;
    Ok(())
}
