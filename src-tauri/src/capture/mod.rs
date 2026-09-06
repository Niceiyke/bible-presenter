//! Native window capture (Phase 4).
//!
//! A platform-neutral capture abstraction over registered windows. The Windows
//! backend uses Windows Graphics Capture (WGC) + D3D11 to grab the exact pixels
//! a window renders, so recording/streaming can be fed by real program pixels
//! (the DOM renderer) instead of a second canvas renderer.
//!
//! By default, the recorder and streamer capture the audience `output` window
//! while it is on screen (the exact pixels being projected); when it is closed
//! they fall back to the dedicated `capture` window, which renders the same
//! `OutputWindow` DOM surface — this decouples recording/streaming from the
//! projection window being open. The capture window is hidden by default and
//! revealed only while a session is sourcing it (`ensure_capture_visible`), since
//! WGC only delivers frames while the window is on-screen and presenting. The
//! `window_label` parameter is caller-controlled so verification surfaces can
//! still target the live `output` window directly.
//!
//! Contract:
//! - `start(window_label, geometry, fps)` -> session id
//! - `stop(session_id)`
//! - `status(session_id)` -> active state, actual FPS, resolution, frame drops,
//!   fatal errors
//!
//! Frame delivery to encoders happens via two complementary paths:
//! - A bounded ring buffer (the latest NV12 frame per session), queried by
//!   preview consumers.
//! - An optional bounded frame **sink** (`start_with_sink`) that streams every
//!   delivered frame to a consumer channel (recording/streaming). When a sink
//!   is attached the channel is the delivery path and frames are never dropped
//!   except under explicit backpressure (bounded, drop-newest).
//!
//! The manager is Arc-managed on `AppState.capture`, mirroring how
//! `OutputManager` and `RemoteControl` are managed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A streamed frame sink: every delivered frame is pushed to `SyncSender`, and
/// the consumer `Receiver` reads them (e.g. ffmpeg stdin). Created with a
/// bounded `sync_channel`, so `send` blocks (natural backpressure) rather than
/// growing memory or losing frames while the consumer keeps up.
pub type FrameSink = SyncSender<Arc<CaptureFrame>>;
pub type FrameSinkRx = Receiver<Arc<CaptureFrame>>;

/// Handle to one attached consumer, used to detach it later. Returned by
/// `attach_consumer`/`start_for_consumer`.
#[derive(Debug, Clone, Copy)]
pub struct ConsumerHandle {
    pub id: u64,
    pub strict: bool,
}

struct SinkSlot {
    id: u64,
    tx: FrameSink,
}

/// The live set of consumers attached to a shared capture session.
///
/// - `best_effort` sinks (live streaming destinations) use `try_send` with
///   drop-newest: a slow destination never stalls the shared capture or the
///   other outputs, and a momentarily dropped frame is acceptable live.
/// - `strict` sinks (a solo recorder) use blocking `send` under backpressure so
///   recording never silently drops a frame.
///
/// Consumers can be attached and detached at any time, which lets ONE capture
/// session serve the recorder and the broadcast hub simultaneously (single WGC
/// readback instead of one per surface). When the last consumer detaches, the
/// manager stops the session.
///
/// A strict sink is only safe while it is the SOLE consumer: if it is attached
/// to a session another consumer later joins (a broadcast going live while a
/// recording runs), the recorder is **downgraded to best-effort** — the shared
/// capture thread must never block on the recorder's backpressure, or a slow
/// disk would also stall the live streams (and stop/detach would deadlock
/// behind the blocked send). Recording stays strict only while it owns the
/// session by itself.
#[derive(Default)]
pub struct FrameConsumers {
    best_effort: Vec<SinkSlot>,
    strict: Vec<SinkSlot>,
    next_id: u64,
}

impl FrameConsumers {
    fn attach(&mut self, tx: FrameSink, strict: bool) -> ConsumerHandle {
        let id = self.next_id;
        self.next_id += 1;
        let slot = SinkSlot { id, tx };
        // Strict (blocking) sends are only safe while this consumer is the SOLE
        // one on the session. Any attach that would produce a second consumer —
        // a live destination joining a solo recorder, OR a strict recorder
        // joining a live session — downgrades every held strict sink to
        // best-effort so nothing can block the shared capture thread (which
        // would starve the live stream's frames and stall the idle re-feed).
        if !self.strict.is_empty() || !self.best_effort.is_empty() {
            self.best_effort.append(&mut std::mem::take(&mut self.strict));
        }
        let sole = self.strict.is_empty() && self.best_effort.is_empty();
        if strict && sole {
            self.strict.push(slot);
        } else {
            self.best_effort.push(slot);
        }
        ConsumerHandle { id, strict }
    }

    /// Remove the given consumer (searches both buckets, since a strict slot
    /// may have been downgraded to best-effort after a live consumer joined).
    /// Returns whether it was attached.
    fn detach(&mut self, handle: ConsumerHandle) -> bool {
        let before = self.strict.len() + self.best_effort.len();
        self.strict.retain(|s| s.id != handle.id);
        self.best_effort.retain(|s| s.id != handle.id);
        before != self.strict.len() + self.best_effort.len()
    }

    fn is_empty(&self) -> bool {
        self.strict.is_empty() && self.best_effort.is_empty()
    }

    /// Deliver one frame to every attached consumer, pruning any that
    /// disconnected. Returns whether at least one consumer is still attached.
    fn push(&mut self, cf: &Arc<CaptureFrame>) -> bool {
        use std::sync::mpsc::TrySendError;
        let mut kept: Vec<SinkSlot> = Vec::with_capacity(self.best_effort.len());
        for slot in self.best_effort.drain(..) {
            match slot.tx.try_send(cf.clone()) {
                Ok(()) | Err(TrySendError::Full(_)) => kept.push(slot),
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
        self.best_effort = kept;
        let mut kept: Vec<SinkSlot> = Vec::with_capacity(self.strict.len());
        for slot in self.strict.drain(..) {
            if slot.tx.send(cf.clone()).is_ok() {
                kept.push(slot);
            }
        }
        self.strict = kept;
        !self.is_empty()
    }
}

/// Serialized capture state for a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Starting,
    Active,
    Stopped,
    Error,
}

/// Typed runtime status for one capture session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub session_id: String,
    pub window_label: String,
    pub state: CaptureState,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames_captured: u64,
    pub frames_dropped: u64,
    pub last_error: Option<String>,
}

impl CaptureStatus {
    fn idle(session_id: String, window_label: String, width: u32, height: u32, fps: u32) -> Self {
        Self {
            session_id,
            window_label,
            state: CaptureState::Starting,
            width,
            height,
            fps,
            frames_captured: 0,
            frames_dropped: 0,
            last_error: None,
        }
    }
}

/// A captured frame. `pixels` is tightly packed **NV12** (Y plane W*H, then
/// interleaved U/V at W*H/2 total): the capture readback converts BGRA -> NV12
/// once per frame so downstream encoders (QSV natively, libx264 with a tiny
/// format swap) never run their own per-process BGRA->YUV swscale.
#[derive(Debug, Clone)]
pub struct CaptureFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub timestamp_ms: u64,
}

/// BT.601 (limited range) BGRA -> NV12. Y plane is W*H bytes; the chroma plane
/// is interleaved U,V pairs, one pair per 2x2 luma block.
pub(crate) fn bgra_to_nv12(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let y_size = w * h;
    let uv_w = w.div_ceil(2);
    let uv_h = h.div_ceil(2);
    let mut out = vec![0u8; y_size + uv_w * uv_h * 2];
    let (y_plane, uv_plane) = out.split_at_mut(y_size);
    if w == 0 || h == 0 {
        return out;
    }
    let w4 = w * 4;
    for row in 0..h {
        let prow = &src[row * w4..row * w4 + w4];
        for col in 0..w {
            let p = col * 4;
            let b = prow[p] as i32;
            let g = prow[p + 1] as i32;
            let r = prow[p + 2] as i32;
            let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y_plane[row * w + col] = y.clamp(16, 235) as u8;
        }
    }
    for rh in 0..uv_h {
        let row0 = rh * 2;
        for cw in 0..uv_w {
            let col0 = cw * 2;
            let mut sb = 0i32;
            let mut sg = 0i32;
            let mut sr = 0i32;
            let mut n = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let rr = row0 + dy;
                    let cc = col0 + dx;
                    if rr < h && cc < w {
                        let p = rr * w4 + cc * 4;
                        sb += src[p] as i32;
                        sg += src[p + 1] as i32;
                        sr += src[p + 2] as i32;
                        n += 1;
                    }
                }
            }
            let (b, g, r) = (sb / n, sg / n, sr / n);
            let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            let o = (rh * uv_w + cw) * 2;
            uv_plane[o] = u.clamp(16, 240) as u8;
            uv_plane[o + 1] = v.clamp(16, 240) as u8;
        }
    }
    out
}

/// A synthetic black NV12 frame (BT.601 limited range: Y=16, U/V=128). Fed to
/// consumers before the first WGC frame arrives so a static capture window can
/// never starve the encoders (the old code parked behind WGC's blocking
/// `TryGetNextFrame` and aborted recordings/streams with `-10053`).
#[cfg(target_os = "windows")]
fn black_nv12(w: u32, h: u32) -> Vec<u8> {
    let w = w.max(1) as usize;
    let h = h.max(1) as usize;
    let y_size = w * h;
    let uv_size = w.div_ceil(2) * h.div_ceil(2) * 2;
    let mut out = vec![0u8; y_size + uv_size];
    out[..y_size].fill(16);
    for plane in out[y_size..].as_chunks_mut::<2>().0 {
        plane[0] = 128;
        plane[1] = 128;
    }
    out
}

/// Shared handle to a running capture session.
pub struct CaptureSession {
    status: Arc<Mutex<CaptureStatus>>,
    /// Bounded ring: the latest frame(s) ready for encoders.
    latest: Arc<Mutex<Option<Arc<CaptureFrame>>>>,
    /// Live consumer set (recorder strict sink + streaming fan-out). Attached
    /// and detached dynamically so several surfaces can share one capture.
    shared: Arc<Mutex<FrameConsumers>>,
    /// Target parameters (window label + requested width/height/fps) used to
    /// decide whether a later request can reuse this session.
    params: (String, u32, u32, u32),
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl CaptureSession {
    /// Take the most recent frame, if any (consuming it).
    pub fn take_latest(&self) -> Option<Arc<CaptureFrame>> {
        self.latest.lock().unwrap().take()
    }

    /// Peek the most recent frame without consuming it.
    pub fn peek_latest(&self) -> Option<Arc<CaptureFrame>> {
        self.latest.lock().unwrap().clone()
    }
}

/// Manages capture sessions keyed by session id.
#[derive(Default)]
pub struct CaptureManager {
    sessions: Mutex<HashMap<String, Arc<CaptureSession>>>,
}

impl CaptureManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// Resolve the raw HWND for a Tauri window label (Windows only).
#[cfg(target_os = "windows")]
fn resolve_hwnd(app: &tauri::AppHandle, label: &str) -> Result<usize, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::Manager;
    let win = app
        .get_webview_window(label)
        .ok_or_else(|| format!("No window labelled '{label}'"))?;
    let handle = win
        .window_handle()
        .map_err(|e| format!("window handle: {e}"))?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Ok(h.hwnd.get() as usize),
        _ => Err(format!("Window '{label}' is not a Win32 window")),
    }
}

/// Start a capture session for a window. Only one session per window label is
/// allowed; starting a second one fails cleanly.
pub fn start(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<String, String> {
    start_shared(manager, app, window_label, width, height, fps)
}

/// Start a capture session with NO attached consumers — ring (`latest`) only.
/// Consumers attach afterwards via `attach_consumer`/`start_for_consumer`.
pub fn start_shared(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<String, String> {
    start_session(manager, app, window_label, width, height, fps)
}

/// Start a capture session that streams every delivered frame to a single
/// strict sink (recording). The caller owns the returned consumer half.
pub fn start_with_sink(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
    sink: Option<FrameSink>,
) -> Result<String, String> {
    match sink {
        Some(tx) => {
            let (sid, _) =
                start_for_consumer(manager, app, window_label, width, height, fps, tx, true)?;
            Ok(sid)
        }
        None => start_shared(manager, app, window_label, width, height, fps),
    }
}

/// Start a capture session that **fan-outs** every delivered frame to many
/// bounded sinks (live streaming hub). Each consumer sees every frame unless its
/// own queue is full, in which case the newest frame is dropped for that
/// destination only — a congested uplink never stalls capture or the other
/// destinations. The callers own the returned consumer halves.
pub fn start_with_broadcaster(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
    sinks: Vec<FrameSink>,
) -> Result<String, String> {
    let mut it = sinks.into_iter();
    let Some(first) = it.next() else {
        return start_shared(manager, app, window_label, width, height, fps);
    };
    let (sid, _) =
        start_for_consumer(manager, app, window_label, width, height, fps, first, false)?;
    for tx in it {
        attach_consumer(manager, &sid, tx, false)?;
    }
    Ok(sid)
}

/// Start (or reuse) a capture session for a consumer, immediately attaching
/// `tx`. When an existing session targets the SAME window at the SAME
/// geometry + fps it is reused, so the recorder and the broadcast hub converge
/// on one WGC readback instead of running two captures of the same window.
/// Returns the session id and the consumer's detach handle.
#[allow(clippy::too_many_arguments)]
pub fn start_for_consumer(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
    tx: FrameSink,
    strict: bool,
) -> Result<(String, ConsumerHandle), String> {
    let params = (window_label.clone(), width, height, fps);
    {
        let sessions = manager.sessions.lock().unwrap();
        if let Some((sid, sess)) = sessions.iter().find(|(_, s)| s.params == params) {
            let mut guard = sess.shared.lock().unwrap();
            let handle = guard.attach(tx, strict);
            return Ok((sid.clone(), handle));
        }
    }
    let session_id = start_session(manager, app, window_label, width, height, fps)?;
    let sessions = manager.sessions.lock().unwrap();
    let sess = sessions
        .get(&session_id)
        .expect("session inserted on start");
    let mut guard = sess.shared.lock().unwrap();
    let handle = guard.attach(tx, strict);
    Ok((session_id, handle))
}

/// Attach a consumer to an already-running session (e.g. a second surface
/// joining a shared capture). Returns the consumer's detach handle.
pub fn attach_consumer(
    manager: &CaptureManager,
    session_id: &str,
    tx: FrameSink,
    strict: bool,
) -> Result<ConsumerHandle, String> {
    let sessions = manager.sessions.lock().unwrap();
    let sess = sessions
        .get(session_id)
        .ok_or_else(|| format!("No capture session '{session_id}'"))?;
    let mut guard = sess.shared.lock().unwrap();
    Ok(guard.attach(tx, strict))
}

/// Shared session start: spawns the WGC worker thread with an empty consumer
/// set; callers attach consumers afterwards.
fn start_session(
    manager: &CaptureManager,
    app: &tauri::AppHandle,
    window_label: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut sessions = manager.sessions.lock().unwrap();
    println!("capture: session {session_id} start requested label={window_label}");
    let status = Arc::new(Mutex::new(CaptureStatus::idle(
        session_id.clone(),
        window_label.clone(),
        width,
        height,
        fps,
    )));
    let latest: Arc<Mutex<Option<Arc<CaptureFrame>>>> = Arc::new(Mutex::new(None));
    let shared: Arc<Mutex<FrameConsumers>> = Arc::new(Mutex::new(FrameConsumers::default()));
    let stop = Arc::new(AtomicBool::new(false));

    #[cfg(target_os = "windows")]
    let hwnd: usize = resolve_hwnd(app, &window_label)?;
    #[cfg(not(target_os = "windows"))]
    let hwnd: usize = 0;

    let (st, la, sh, stp) = (status.clone(), latest.clone(), shared.clone(), stop.clone());
    let thread_sid = session_id.clone();
    let thread = std::thread::Builder::new()
        .name(format!("wgc-capture-{session_id}"))
        .spawn(move || {
            #[cfg(target_os = "windows")]
            capture_thread_windows(hwnd, thread_sid.clone(), width, height, fps, st, la, sh, stp);
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (hwnd, width, height, fps, thread_sid, st, la, sh, stp);
            }
        })
        .map_err(|e| format!("spawn capture thread: {e}"))?;

    sessions.insert(
        session_id.clone(),
        Arc::new(CaptureSession {
            status,
            latest,
            shared,
            params: (window_label, width, height, fps),
            stop,
            thread: Mutex::new(Some(thread)),
        }),
    );
    Ok(session_id)
}

/// Create a bounded frame sink channel for a recording/streaming consumer.
/// The capacity bounds in-flight frames (bounded memory); `send` blocks under
/// backpressure (natural pacer) and errors only when the consumer disconnects.
pub fn bounded_sink(capacity: usize) -> (FrameSink, FrameSinkRx) {
    sync_channel::<Arc<CaptureFrame>>(capacity.max(1))
}

/// Stop a capture session and release its window/session resources.
pub fn stop(manager: &CaptureManager, session_id: &str) {
    let session = manager.sessions.lock().unwrap().remove(session_id);
    if let Some(session) = session {
        session.stop.store(true, Ordering::SeqCst);
        if let Some(t) = session.thread.lock().unwrap().take() {
            let _ = t.join();
        }
        if let Ok(mut st) = session.status.lock() {
            st.state = CaptureState::Stopped;
        }
    }
}

/// Detach one consumer from a session. When the session has no consumers left
/// it is stopped and removed, so a shared capture tears down exactly when the
/// last of its surfaces (recorder + streaming destinations) releases it. Works
/// even when the consumer was already pruned side (its ffmpeg died): the empty
/// set still releases the session.
pub fn detach_consumer(manager: &CaptureManager, session_id: &str, handle: ConsumerHandle) {
    let remove = {
        let mut sessions = manager.sessions.lock().unwrap();
        let Some(sess) = sessions.get_mut(session_id) else {
            return;
        };
        let mut guard = sess.shared.lock().unwrap();
        guard.detach(handle);
        guard.is_empty()
    };
    if remove {
        stop(manager, session_id);
    }
}

/// Snapshot the current status of a session.
pub fn status(manager: &CaptureManager, session_id: &str) -> Option<CaptureStatus> {
    manager
        .sessions
        .lock()
        .unwrap()
        .get(session_id)
        .map(|s| s.status.lock().unwrap().clone())
}

/// Fully dispose all sessions (app shutdown).
pub fn shutdown(manager: &CaptureManager) {
    let ids: Vec<String> = manager.sessions.lock().unwrap().keys().cloned().collect();
    for id in ids {
        stop(manager, &id);
    }
}

/// Push a frame to every attached consumer, pruning any whose channel
/// disconnected (recording/streaming torn down). Best-effort destinations use
/// try_send with drop-newest so a full queue never stalls the shared capture or
/// the other outputs; the strict recorder uses blocking send so recording never
/// silently loses a frame. Best-effort senders are serviced FIRST so a blocked
/// recorder cannot starve the live destinations.
#[cfg(target_os = "windows")]
fn push_frames(shared: &Arc<Mutex<FrameConsumers>>, cf: &Arc<CaptureFrame>) {
    shared.lock().unwrap().push(cf);
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn capture_thread_windows(
    hwnd: usize,
    session_id: String,
    target_w: u32,
    target_h: u32,
    fps: u32,
    status: Arc<Mutex<CaptureStatus>>,
    latest: Arc<Mutex<Option<Arc<CaptureFrame>>>>,
    shared: Arc<Mutex<FrameConsumers>>,
    stop: Arc<AtomicBool>,
) {
    use windows::core::{factory, Interface};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_SDK_VERSION,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

    let fail = |msg: String| {
        if let Ok(mut st) = status.lock() {
            st.state = CaptureState::Error;
            st.last_error = Some(msg);
        }
    };

    unsafe {
        if !CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() {
            fail("CoInitializeEx failed".to_string());
            return;
        }

        // D3D11 device (BGRA support required for the WinRT D3D interop).
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        if let Err(e) = D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        ) {
            fail(format!("D3D11CreateDevice: {e:?}"));
            CoUninitialize();
            return;
        }
        let device = match device {
            Some(d) => d,
            None => {
                fail("D3D11 device is null".to_string());
                CoUninitialize();
                return;
            }
        };
        let context = match context {
            Some(c) => c,
            None => {
                fail("D3D11 context is null".to_string());
                CoUninitialize();
                return;
            }
        };

        // WinRT IDirect3DDevice from the DXGI device.
        let dxgi: IDXGIDevice = match device.cast() {
            Ok(d) => d,
            Err(e) => {
                fail(format!("device->IDXGIDevice: {e:?}"));
                CoUninitialize();
                return;
            }
        };
        let inspectable = match CreateDirect3D11DeviceFromDXGIDevice(&dxgi) {
            Ok(i) => i,
            Err(e) => {
                fail(format!("CreateDirect3D11DeviceFromDXGIDevice: {e:?}"));
                CoUninitialize();
                return;
            }
        };
        let rt_device: IDirect3DDevice = match inspectable.cast() {
            Ok(d) => d,
            Err(e) => {
                fail(format!("inspectable->IDirect3DDevice: {e:?}"));
                CoUninitialize();
                return;
            }
        };

        // GraphicsCaptureItem for the window.
        let interop: IGraphicsCaptureItemInterop =
            match factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>() {
                Ok(i) => i,
                Err(e) => {
                    fail(format!("item interop factory: {e:?}"));
                    CoUninitialize();
                    return;
                }
            };
        let item: GraphicsCaptureItem =
            match interop.CreateForWindow(HWND(hwnd as *mut std::ffi::c_void)) {
                Ok(i) => i,
                Err(e) => {
                    fail(format!("CreateForWindow: {e:?}"));
                    CoUninitialize();
                    return;
                }
            };
        let item_size = match item.Size() {
            Ok(s) => s,
            Err(e) => {
                fail(format!("item Size: {e:?}"));
                CoUninitialize();
                return;
            }
        };
        let cap_w = if target_w > 0 {
            target_w
        } else {
            item_size.Width as u32
        };
        let cap_h = if target_h > 0 {
            target_h
        } else {
            item_size.Height as u32
        };

        // Free-threaded frame pool so FrameArrived/TryGetNextFrame are serviced
        // without a DispatcherQueue or message pump on this worker thread.
        let pool = match Direct3D11CaptureFramePool::CreateFreeThreaded(
            &rt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            3,
            windows::Graphics::SizeInt32 {
                Width: cap_w as i32,
                Height: cap_h as i32,
            },
        ) {
            Ok(p) => p,
            Err(e) => {
                fail(format!("frame pool: {e:?}"));
                CoUninitialize();
                return;
            }
        };
        let session = match pool.CreateCaptureSession(&item) {
            Ok(s) => s,
            Err(e) => {
                fail(format!("CreateCaptureSession: {e:?}"));
                CoUninitialize();
                return;
            }
        };
        let _ = session.SetIsCursorCaptureEnabled(false);

        if let Err(e) = session.StartCapture() {
            fail(format!("StartCapture: {e:?}"));
            CoUninitialize();
            return;
        }

        if let Ok(mut st) = status.lock() {
            st.state = CaptureState::Active;
            st.width = cap_w;
            st.height = cap_h;
        }

        let mut dropped_total = 0u64;

        // Event-driven frame delivery. WGC only raises `FrameArrived` when the
        // window presents a new frame, and `TryGetNextFrame` BLOCKS until a
        // frame is pending — so it must be called from the event callback
        // (where a frame is guaranteed ready and the call returns immediately),
        // never from a free-running poll. The handler forwards the captured
        // frame over a bounded channel; the liveness loop below only ever does
        // bounded receives, so it can never park on a static window (which
        // previously starved encoders and aborted recordings/streams with
        // `-10053`).
        let (frame_tx, frame_rx) =
            std::sync::mpsc::sync_channel::<windows::Graphics::Capture::Direct3D11CaptureFrame>(
                2,
            );
        let dropped_flag = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let copy_drop_flag = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let handler_count = dropped_flag.clone();
        let frame_arrived = TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(
            move |sender: windows::core::Ref<'_, Direct3D11CaptureFramePool>,
                  _args: windows::core::Ref<'_, windows::core::IInspectable>| {
                if let Some(pool_ref) = sender.as_ref() {
                    if let Ok(frame) = pool_ref.TryGetNextFrame() {
                        if frame_tx.try_send(frame).is_err() {
                            // Pool saturated; the next present supersedes this
                            // frame, so dropping it is safe (latest-wins).
                            handler_count.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                Ok(())
            });
        let token = match pool.FrameArrived(&frame_arrived) {
            Ok(t) => t,
            Err(e) => {
                fail(format!("FrameArrived: {e:?}"));
                CoUninitialize();
                return;
            }
        };

        // The GPU readback (`CopyResource` + `Map` + software `bgra_to_nv12`)
        // runs on a DEDICATED copy thread. On this iGPU the readback contends
        // with QSV encoding and can stall for seconds-to-minutes; if it ran
        // inline, that single stall would freeze the whole feed and abort the
        // broadcast (`-10053`). Decoupled, the liveness loop below keeps
        // pushing re-feed frames at the target rate regardless of how long any
        // one readback takes, so encoders are never starved.
        let present_interval =
            std::time::Duration::from_secs_f64(1.0 / (fps.max(1) as f64));
        let last_cf: Arc<Mutex<Option<Arc<CaptureFrame>>>> = Arc::new(Mutex::new(None));
        let copy_busy = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (copy_tx, copy_rx) =
            std::sync::mpsc::sync_channel::<windows::Graphics::Capture::Direct3D11CaptureFrame>(
                1,
            );
        {
            let copy_busy_c = copy_busy.clone();
            let last_cf_c = last_cf.clone();
            let status_c = status.clone();
            let latest_c = latest.clone();
            let shared_c = shared.clone();
            let stop_c = stop.clone();
            let copy_drop_c = copy_drop_flag.clone();
            let session_name = session_id.clone();
            let mut fps_start = Instant::now();
            let mut fps_count = 0u32;
            let _ = std::thread::Builder::new()
                .name(format!("capture-copy-{session_id}"))
                .spawn(move || {
                    // Reusable staging texture + BGRA readback buffer, owned
                    // exclusively by this thread. The texture is lazily
                    // (re)created when the surface size changes (window
                    // resize); the mutably-extended `bgra` Vec is pooled so a
                    // 1080p frame no longer allocates ~8 MiB every capture tick
                    // (8.3 MB BGRA + 3.1 MB NV12 per frame at 30 fps was over
                    // 300 MB/s of allocator churn before this reuse).
                    let mut staging: Option<
                        windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
                    > = None;
                    let mut bgra_scratch: Vec<u8> = Vec::new();
                    while !stop_c.load(Ordering::SeqCst) {
                        let frame = match copy_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                            Ok(f) => f,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        };
                        let copied = copy_rgba(&device, &context, &frame, &mut staging, &mut bgra_scratch);
                        drop(frame);
                        if let Some(frame_data) = copied {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let cf = Arc::new(CaptureFrame {
                                width: frame_data.0,
                                height: frame_data.1,
                                pixels: frame_data.2,
                                timestamp_ms: ts,
                            });
                            // Remember the newest frame for the idle re-feed.
                            if let Ok(mut l) = last_cf_c.lock() {
                                *l = Some(cf.clone());
                            }
                            // Always refresh the ring so previews stay current.
                            if let Ok(mut l) = latest_c.lock() {
                                *l = Some(cf.clone());
                            }
                            // Stream to the consumers when attached; prune any
                            // that went away (sender error).
                            push_frames(&shared_c, &cf);
                            if let Ok(mut st) = status_c.lock() {
                                st.frames_captured += 1;
                                st.width = frame_data.0;
                                st.height = frame_data.1;
                            }
                            fps_count += 1;
                            if fps_start.elapsed().as_millis() >= 1000 {
                                if let Ok(mut st) = status_c.lock() {
                                    st.fps = fps_count;
                                }
                                fps_count = 0;
                                fps_start = Instant::now();
                            }
                        } else {
                            copy_drop_c.fetch_add(1, Ordering::SeqCst);
                        }
                        copy_busy_c.store(false, Ordering::SeqCst);
                    }
                    drop(device);
                    drop(context);
                    println!("capture: copy thread {session_name} ended");
                });
        }

        let mut last_present = Instant::now();
        // Time of the last *genuine* WGC present (vs. an idle re-feed). When
        // the window has presented nothing for a while (static scripture held
        // on screen), the re-feed cadence is throttled so the encoders still
        // see a live, wall-clock-continuous timeline but the copy/encode cost
        // of re-feeding identical frames collapses to ~1/4 of full rate.
        let mut last_real_frame = Instant::now();
        const IDLE_THRESHOLD: Duration = Duration::from_secs(2);
        const IDLE_REFEED_FPS: f64 = 8.0;
        let idle_refeed_interval = Duration::from_secs_f64(1.0 / IDLE_REFEED_FPS);
        let mut last_feed_gap_warn = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            // Bounded pull — never blocks on WGC. On timeout (no new present)
            // fall through to the idle re-feed; on disconnect (pool torn down)
            // leave the loop.
            let pending = match frame_rx.recv_timeout(std::time::Duration::from_millis(2)) {
                Ok(frame) => Some(frame),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };

            if let Some(frame) = pending {
                // A real present means the window is live — the copy thread
                // must run at full cadence again (throttling resets here even
                // if an individual frame is dropped while the copy thread is
                // busy, since the window is clearly re-rendering).
                last_real_frame = Instant::now();
                // Latest-wins drain: if a burst arrived (the copy thread is
                // behind), superseded frames count as drops and only the
                // newest is handed to the copy thread.
                let mut newest = frame;
                while let Ok(extra) = frame_rx.try_recv() {
                    dropped_total += 1;
                    newest = extra;
                }
                // Forward to the copy thread when it is free; otherwise drop
                // the raw frame — the idle re-feed keeps the stream alive.
                if !copy_busy.swap(true, Ordering::SeqCst) {
                    if copy_tx.try_send(newest).is_err() {
                        copy_drop_flag.fetch_add(1, Ordering::SeqCst);
                        copy_busy.store(false, Ordering::SeqCst);
                    }
                } else {
                    dropped_total += 1;
                }
            } else {
                // No new frame arrived: the window is idle (static content) —
                // WGC stops delivering until the next present. Re-feed the last
                // captured frame (or a synthetic black one before the first
                // frame) so encoders are never starved, throttling when the
                // window has been static for a while.
                let refeed_interval = if last_real_frame.elapsed() >= IDLE_THRESHOLD {
                    idle_refeed_interval
                } else {
                    present_interval
                };
                if last_present.elapsed() >= refeed_interval {
                    let cf = last_cf
                        .lock()
                        .ok()
                        .and_then(|l| l.clone())
                        .unwrap_or_else(|| {
                            Arc::new(CaptureFrame {
                                width: cap_w,
                                height: cap_h,
                                pixels: black_nv12(cap_w, cap_h),
                                timestamp_ms: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64,
                            })
                        });
                    push_frames(&shared, &cf);
                    last_present = Instant::now();
                }
            }

            if let Ok(mut st) = status.lock() {
                st.frames_dropped =
                    dropped_total + dropped_flag.load(Ordering::SeqCst) + copy_drop_flag.load(Ordering::SeqCst);
            }

            // Feed-liveness watchdog: if the loop stops iterating (thread
            // starvation, e.g. audio-on load) or a refeed push stalls, the
            // encoders go silent long enough for mediaMTX to time out the
            // broadcast (`i/o timeout` -> `-10053`). Log a gap > 5 s.
            if last_feed_gap_warn.elapsed() >= std::time::Duration::from_secs(5) {
                last_feed_gap_warn = Instant::now();
                let gap = last_present.elapsed();
                if gap >= std::time::Duration::from_secs(2) {
                    println!(
                        "capture: session {session_id} FEED GAP {gap:?} since last handed-out frame"
                    );
                }
            }
        }

        drop(copy_tx);
        let _ = pool.RemoveFrameArrived(token);
        let _ = session.Close();
        let _ = pool.Close();
        drop(item);
        CoUninitialize();
        println!("capture: session {session_id} ended");
    }
}

/// Copies the frame from the WGC surface into a packed NV12 buffer (the same
/// format QSV encodes natively). `bgra_scratch` is a thread-owned pooled buffer
/// reused across frames so each capture tick does not allocate an 8 MiB BGRA
/// Vec. Returns (width, height, nv12 bytes) — the NV12 Vec is the frame payload
/// and therefore cannot be reused (it is wrapped in an `Arc` and shared across
/// consumer channels), but it is 2.6x smaller than the BGRA intermediate we no
/// longer allocate.
#[cfg(target_os = "windows")]
unsafe fn copy_rgba(
    device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
    context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    frame: &windows::Graphics::Capture::Direct3D11CaptureFrame,
    staging: &mut Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>,
    bgra_scratch: &mut Vec<u8>,
) -> Option<(u32, u32, Vec<u8>)> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_STAGING, ID3D11Texture2D,
    };
    use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;

    let content = match frame.ContentSize() {
        Ok(s) => s,
        Err(_) => return None,
    };
    let surface = match frame.Surface() {
        Ok(s) => s,
        Err(_) => return None,
    };
    let access: IDirect3DDxgiInterfaceAccess = match surface.cast() {
        Ok(a) => a,
        Err(_) => return None,
    };
    let texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = match access.GetInterface()
    {
        Ok(t) => t,
        Err(_) => return None,
    };

    let mut desc = D3D11_TEXTURE2D_DESC::default();
    texture.GetDesc(&mut desc);
    let surface_w = desc.Width;
    let surface_h = desc.Height;
    // Recreate the staging texture only when the surface (or its shape) changed.
    let matches = staging.as_ref().map(|t| {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        t.GetDesc(&mut d);
        d.Usage == D3D11_USAGE_STAGING
            && d.BindFlags == 0
            && d.CPUAccessFlags == D3D11_CPU_ACCESS_READ.0 as u32
            && d.Width == surface_w
            && d.Height == surface_h
    }) == Some(true);
    if !matches {
        let mut staging_desc = desc;
        staging_desc.Usage = D3D11_USAGE_STAGING;
        staging_desc.BindFlags = 0;
        staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        staging_desc.MiscFlags = 0;
        let mut created: Option<ID3D11Texture2D> = None;
        if device
            .CreateTexture2D(&staging_desc, None, Some(&mut created))
            .is_err()
        {
            return None;
        }
        *staging = created;
    }
    let staging_texture = staging.as_ref()?;

    context.CopyResource(staging_texture, &texture);

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    if context
        .Map(staging_texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        .is_err()
    {
        return None;
    }

    // Crop to content size.
    let w = (content.Width.max(0) as u32).min(surface_w) as usize;
    let h = (content.Height.max(0) as u32).min(surface_h) as usize;
    if w == 0 || h == 0 {
        context.Unmap(staging_texture, 0);
        return None;
    }

    let src = std::slice::from_raw_parts(mapped.pData as *const u8, (mapped.RowPitch as usize) * h);
    // Reuse the pooled buffer: clear keeps capacity (largest surface so far),
    // so the steady-state 1080p case performs zero allocations per frame.
    bgra_scratch.clear();
    if mapped.RowPitch as usize == w * 4 {
        // Tightly packed rows — one contiguous copy instead of 1080 row slices.
        bgra_scratch.extend_from_slice(&src[..w * h * 4]);
    } else {
        for row in 0..h {
            let offset = row * mapped.RowPitch as usize;
            let line = &src[offset..offset + w * 4];
            bgra_scratch.extend_from_slice(line);
        }
    }
    context.Unmap(staging_texture, 0);

    let nv12 = bgra_to_nv12(bgra_scratch, w, h);
    Some((w as u32, h as u32, nv12))
}

/// Module-local unit tests.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_idle_is_starting() {
        let s = CaptureStatus::idle("a".into(), "output".into(), 1920, 1080, 30);
        assert_eq!(s.state, CaptureState::Starting);
        assert_eq!(s.fps, 30);
        assert_eq!(s.frames_captured, 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn black_nv12_is_limited_range_black() {
        let (w, h) = (4u32, 4u32);
        let p = black_nv12(w, h);
        let (w, h) = (w as usize, h as usize);
        assert_eq!(p.len(), w * h + (w * h) / 2);
        for &b in &p[..w * h] {
            assert_eq!(b, 16);
        }
        for &b in &p[w * h..] {
            assert_eq!(b, 128);
        }
        // An odd dimension exercises the div_ceil sizing path too.
        let q = black_nv12(3, 3);
        assert_eq!(q.len(), 9 + 2 * 2 * 2);
    }

    #[test]
    fn manager_start_requires_window_resolution() {
        // Without a real Tauri app, start() must fail gracefully rather than
        // panic, and must not leave a partial session behind.
        let m = CaptureManager::new();
        // No AppHandle available in unit context; the resolution path simply
        // isn't exercised here. This guards the sync-cells shape.
        assert!(m.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn detach_releases_shared_session_when_last_consumer() {
        let m = CaptureManager::new();
        let (tx, rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let shared = Arc::new(Mutex::new(FrameConsumers::default()));
        let rec_handle = shared.lock().unwrap().attach(tx, true);
        let session = Arc::new(CaptureSession {
            status: Arc::new(Mutex::new(CaptureStatus::idle(
                "s1".into(),
                "capture".into(),
                1920,
                1080,
                30,
            ))),
            latest: Arc::new(Mutex::new(None)),
            shared,
            params: ("capture".into(), 1920, 1080, 30),
            stop: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
        });
        m.sessions.lock().unwrap().insert("s1".into(), session);

        // A broadcast destination attached to the same session keeps it alive
        // after the recorder detaches.
        let (tx2, _rx2) = sync_channel::<Arc<CaptureFrame>>(2);
        let stream_handle = m
            .sessions
            .lock()
            .unwrap()
            .get("s1")
            .unwrap()
            .shared
            .lock()
            .unwrap()
            .attach(tx2, false);
        detach_consumer(&m, "s1", rec_handle);
        assert!(
            m.sessions.lock().unwrap().contains_key("s1"),
            "remaining consumer keeps the shared capture running"
        );

        detach_consumer(&m, "s1", stream_handle);
        assert!(
            !m.sessions.lock().unwrap().contains_key("s1"),
            "last detach stops and removes the session"
        );
        drop(rx);
    }

    #[test]
    fn consumers_deliver_prune_and_detach() {
        let cf = Arc::new(CaptureFrame {
            width: 2,
            height: 2,
            pixels: vec![0u8; 6],
            timestamp_ms: 0,
        });
        let mut set = FrameConsumers::default();
        let (strict_tx, strict_rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let (best_tx, best_rx) = sync_channel::<Arc<CaptureFrame>>(2);

        let strict_h = set.attach(strict_tx, true);
        let best_h = set.attach(best_tx, false);
        assert!(!set.is_empty());
        assert!(set.push(&cf), "frame delivered while consumers attached");
        assert_eq!(strict_rx.recv().unwrap().width, 2);
        assert_eq!(best_rx.recv().unwrap().width, 2);

        // Detaching only the best-effort consumer leaves the strict one alive.
        assert!(set.detach(best_h));
        assert!(!set.is_empty());
        assert!(!set.detach(best_h), "double detach is a no-op");

        // A receiver dropped side gets pruned on the next push.
        drop(strict_rx);
        set.push(&cf);
        assert!(set.is_empty(), "all consumers pruned leaves the set empty");
        let _ = strict_h;
    }

    #[test]
    fn strict_recorder_is_downgraded_when_a_live_consumer_joins() {
        let mut set = FrameConsumers::default();
        let (rec_tx, rec_rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let (best_tx, _best_rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let cf = Arc::new(CaptureFrame {
            width: 2,
            height: 2,
            pixels: vec![0u8; 6],
            timestamp_ms: 0,
        });

        // Solo strict recorder stays in the strict bucket.
        let rec_h = set.attach(rec_tx, true);
        assert_eq!(set.strict.len(), 1);
        assert!(set.best_effort.is_empty());
        assert!(set.push(&cf));
        assert_eq!(rec_rx.recv().unwrap().width, 2);

        // When a live (best-effort) consumer joins, the strict slot is moved
        // into the best_effort bucket so nothing can block the shared thread.
        let best_h = set.attach(best_tx, false);
        assert!(set.strict.is_empty(), "strict bucket emptied on join");
        assert_eq!(set.best_effort.len(), 2);

        // The recorder handle still detaches cleanly from the new bucket even
        // though its handle reports strict=true.
        assert!(set.detach(rec_h));
        assert_eq!(set.best_effort.len(), 1);
        assert!(set.detach(best_h));
        assert!(set.is_empty());
        drop(rec_rx);
    }

    #[test]
    fn strict_recorder_joining_a_live_session_is_downgraded() {
        let mut set = FrameConsumers::default();
        let (best_tx, _best_rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let (rec_tx, rec_rx) = sync_channel::<Arc<CaptureFrame>>(2);
        let cf = Arc::new(CaptureFrame {
            width: 2,
            height: 2,
            pixels: vec![0u8; 6],
            timestamp_ms: 0,
        });

        // A live broadcast owns the session first (best-effort sink).
        let best_h = set.attach(best_tx, false);
        assert!(set.strict.is_empty());
        assert_eq!(set.best_effort.len(), 1);
        assert!(set.push(&cf));

        // A strict recorder then joins: it is downgraded along with any held
        // strict slot so a blocking send can never stall the shared thread
        // while the stream is live. Both buckets never mix.
        let rec_h = set.attach(rec_tx, true);
        assert!(set.strict.is_empty(), "new strict recorder downgraded on join");
        assert_eq!(set.best_effort.len(), 2);
        assert!(set.push(&cf), "delivery keeps both consumers attached");

        assert!(set.detach(rec_h));
        assert_eq!(set.best_effort.len(), 1);
        assert!(set.detach(best_h));
        assert!(set.is_empty());
        drop(rec_rx);
    }

    #[test]
    fn nv12_conversion_produces_saturated_limited_range_planes() {
        // 2x2 pure red (BGRA: B=0, G=0, R=255, A=any).
        let src = vec![0u8, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255];
        let nv12 = bgra_to_nv12(&src, 2, 2);
        assert_eq!(nv12.len(), 6, "Y plane + one UV pair");
        // Y limited range for full red: ((66*255+128)>>8)+16 = 82.
        assert_eq!(nv12[0], 82);
        assert_eq!(nv12[1], 82);
        assert_eq!(nv12[2], 82);
        assert_eq!(nv12[3], 82);
        // Cb,Cr (clamped) for the single 2x2 block.
        assert_eq!(nv12[4], 90);
        assert_eq!(nv12[5], 240);
    }

    #[test]
    fn nv12_conversion_handles_odd_dimensions() {
        // 3x1 BGRA (3 px). UV needs ceil-half sizes; odd rows/cols must not
        // panic and the buffer must be exactly ceil(3/2)*ceil(1/2)*2 bytes.
        let src = vec![
            0, 0, 255, 255, // red
            255, 0, 0, 255, // blue
            0, 255, 0, 255, // green
        ];
        let nv12 = bgra_to_nv12(&src, 3, 1);
        assert_eq!(nv12.len(), 7);
        // Every Y is limited-range, every Cb/Cr is clamped to 16..=240.
        for (i, y) in nv12[..3].iter().enumerate() {
            assert!((16..=235).contains(y), "Y[{i}] = {y}");
        }
        for (i, c) in nv12[3..].iter().enumerate() {
            assert!((16..=240).contains(c), "C[{i}] = {c}");
        }
    }
}
