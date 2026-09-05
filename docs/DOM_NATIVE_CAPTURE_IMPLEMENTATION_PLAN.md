# DOM-First Native Capture Implementation Plan

## Goal

Make the DOM the only visual renderer:

```text
Resolved program state
  -> shared DOM ProgramSurface
      -> OutputWindow
      -> Cockpit preview
  -> Windows Graphics Capture of OutputWindow
      -> recording / RTMP / WHIP / NDI
```

The audience `OutputWindow` remains the authoritative program surface. Recording
and streaming capture its final rendered pixels instead of maintaining a
separate canvas compositor.

## Principles

- Do not convert arbitrary DOM into canvas for production capture.
- Resolve output state once before rendering any surface.
- Reuse the same DOM presentation component for OutputWindow and Cockpit.
- Restrict native capture to registered Wordlyte output windows, never arbitrary
  desktop windows or monitors.
- Treat program audio as a separate, explicit mix. Window capture supplies
  pixels, not a reliable program-audio track.
- Keep the existing canvas path until native capture has passed its production
  acceptance checks.

## Phase 0: Confirm Capture Feasibility

1. Build a small Rust proof of concept using Windows Graphics Capture and D3D11.
2. Capture the Tauri `output` window by HWND, not the full monitor.
3. Verify frames during DOM transitions, video playback, lower thirds, scenes,
   props, and camera output.
4. Test the output window when it is hidden, minimized, moved between monitors,
   covered, DPI-scaled, and display-disconnected.
5. Establish the product policy from the results. The expected policy is that
   the output window must be visible while recording or streaming, and that
   starting a dependent transport reveals it if necessary.
6. Add a Windows-only capture capability check to System Diagnostics before
   exposing the feature.

Acceptance criteria:

- Capture the output window at 1920x1080 and 30 FPS for 30 minutes.
- No stale frames, capture crashes, or sustained dropped frames.
- The output window behaves correctly on common display and DPI changes.

## Phase 1: Resolve Program State Once

Add a pure `resolveOutputFrame` module, for example
`src/outputs/resolveOutputFrame.ts`.

Inputs:

- Broadcast live and staged state.
- `OutputConfig`.
- Presentation settings.
- Props and lower-third state.
- License capabilities.
- Active media transport state.

The resolved frame must include:

- The selected source: live, staged, fixed item, scene, or blank.
- Effective settings with all per-output presentation overrides applied.
- Effective overlay visibility.
- Theme, blanking, and background-logo takeover state.
- Props and lower third after output masks.
- Media and camera transport state.

Move inline output override logic out of `OutputWindow.tsx` into this resolver.
Do not allow renderers to combine global settings with per-output settings
themselves.

Tests must cover every `OutputSource`, presentation override, overlay mask,
blank state, and license watermark combination.

## Phase 2: Extract Shared DOM ProgramSurface

Extract OutputWindow's visual content into a presentational `ProgramSurface`
component. It receives a resolved frame and one rendering mode:

- `mode="output"` for the audience window.
- `mode="preview"` for Cockpit.

Keep Tauri event listeners, output configuration hydration, and native window
ownership in `OutputWindow`. Move these features into `ProgramSurface`:

- Backgrounds and background media.
- Bible verses and fitted typography.
- Songs and custom slides.
- Scene compositions.
- Main media and camera rendering.
- Props and lower thirds.
- Background-logo takeover.
- Transitions and license watermark.

Preview mode should use a fixed aspect-ratio wrapper, CSS scale based on the
reference output height, no interaction, muted media, and constrained visual
work where that does not alter appearance.

Acceptance criteria:

- OutputWindow and Cockpit use the same DOM rendering code.
- A preview is a second DOM instance, not a second rendering implementation.
- Output behavior remains unchanged.

## Phase 3: Remove Canvas from Cockpit

Replace `ProgramFeedPreview` in Cockpit with `ProgramSurface` using the
resolved `output-main` frame.

Retain lightweight DOM preview health information instead of canvas metrics:

- Latest output-frame revision.
- Current item identity.
- Media ready or error state.
- Camera connection state.

Cockpit must no longer mount `ProgramFeedCanvas`, `canvasProgramFeed.ts`, or
`useCanvasCapture`.

## Phase 4: Native Window Capture Service

Add a Rust capture abstraction, such as `src-tauri/src/capture/mod.rs`, with a
platform-neutral contract:

- `start(window_label, geometry, fps)`.
- `stop(session_id)`.
- `status(session_id)`.
- Frame delivery to encoders.

Implement the Windows backend with Windows Graphics Capture and D3D11:

- Resolve the registered output window HWND.
- Capture D3D11 textures from that window.
- Detect resize, close, device loss, and capture failures.
- Maintain monotonic frame timestamps.

Expose narrowly scoped commands:

- `program_capture_start`.
- `program_capture_stop`.
- `program_capture_status`.

Emit typed runtime status for active state, actual capture FPS, resolution,
frame drops, and fatal errors.

## Phase 5: Native Recording — IMPLEMENTED

Replace the frontend canvas/MediaRecorder path (`useCanvasCapture` in
`useRecordingProvider.tsx` + `useRecorder` WebM → base64 → disk) with backend
native capture. Recording is video-only for now; program audio is the separate
deliberate mix bus in Phase 7.

The backend owns the whole pipeline:

- `RecordingSession` in `src-tauri/src/commands/recordings.rs` (held on
  `AppState.recording`).

  - `recording_start(width, height, fps)` starts native capture of the `output`
    window with a frame sink (`capture::start_with_sink`) and spawns ffmpeg
    (`rawvideo bgra` on stdin → libx264 → MP4 temp file on disk). Only one
    recording can be active. The output window must be open (capture fails
    cleanly otherwise).
  - `recording_status()` returns live progress (frames written, bytes written,
    started-at anchor, any ffmpeg error).
  - `recording_stop_active()` stops capture (drops the sink → writer EOF →
    ffmpeg finalizes) and renames the temp file to `recording-<timestamp>.mp4`.
  - `recording_abort()` stops and deletes the temp file without saving.

- A bounded frame sink in `src-tauri/src/capture/mod.rs`
  (`capture::bounded_sink`, `start_with_sink`) streams every captured frame to a
  writer thread into ffmpeg stdin. The channel is bounded (`SINK_CAPACITY`), so
  `send` blocks under backpressure — memory stays bounded and no recorded frames
  are dropped while ffmpeg keeps up. Recording explicitly never accumulates a
  browser Blob or base64 value.

The frontend `RecordingProvider` (`src/hooks/useRecordingProvider.tsx`) is now a
thin controller/reporter around those commands (no compositor, no MediaRecorder,
no canvas). Navigation away from the Recordings tab cannot stop a recording
because the capture lives backend-side. `RecordingsTab.tsx` previews the program
with the shared `ProgramSurfacePreview` (same store-driven DOM as the Cockpit)
and shows a REC/STOP/Abort transport plus the saved-file list (MP4, H.264).

Deviation from the sketch: status is reported via the dedicated
`recording_status` command rather than through the Output Manager's
`outputStates` (an Output-Manager-backed event can be adopted in Phase 6 when
recording becomes a first-class OutputConfig).

Acceptance criteria:

- Recordings contain the exact output-window pixels. (User: pending)
- Recording survives workspace navigation. (User: pending)
- Memory usage remains bounded during long recordings. (User: pending)

Production verification must exercise video, camera, lower thirds, and
transitions for at least 60 minutes, and handle output-window close and capture
failure paths.

## Phase 6: Native Multi-Destination RTMP Broadcast — IMPLEMENTED

Replaces the canvas compositor feeds in `StreamerTab` with a single backend
broadcast: one native WGC capture of the `output` window fans the frames out to
every enabled RTMP destination. Per the operator's scope decision, the hub is
**RTMP-only** this pass — WHIP and NDI cards/presets were dropped from the
streaming UI; the hooks (`useStreamer`, `useRtmpEncoder`, `useNdiSender`,
`useCanvasCapture`) and `ProgramFeedPreview`/`ProgramFeedCanvas` stay in the
codebase but the streaming components no longer import them.

- `stream_rtmp_start(app, state, destinations, width, height, fps)` in
  `src-tauri/src/commands/streaming.rs` validates every RTMP URL up front,
  spawns **one ffmpeg per destination**
  (`-f rawvideo -pix_fmt bgra -s WxH -r fps -i pipe:0 -an -c:v libx264
  -preset veryfast -pix_fmt yuv420p -f flv -flvflags no_duration_filesize <url>`),
  and starts a single broadcast capture via
  `capture::start_with_broadcaster` (a `FrameConsumer::Fanout` vec of
  `bounded_sink` sinks, capacity 8). The capture runs the `output` window.
- A writer thread per destination drains its mpsc receiver into that ffmpeg's
  stdin. `stream_rtmp_stop` stops the capture (senders drop → rx sees EOF →
  ffmpeg finalizes), joins the writers, and kills any straggler after a 5s
  timeout. `stream_rtmp_status` reports per-destination `StreamDestinationStatus`
  plus the active `BroadcastSession`. `BroadcastSession` lives on
  `AppState.streaming: Arc<Mutex<Option<...>>>`.
- Frontend: `useNativeRtmpBroadcast` polls `stream_rtmp_status` every 1s while
  active and drives a **master Go Live All / Stop All**; `StreamerTab` is the
  control surface (RTMP-only `ProgramSurfacePreview` master preview, RTMP-only
  capability gate via `capabilities.rtmpAvailable = ffmpegAvailable`). Capture
  resolution/FPS persists to the `stream-main` output config. This is
  **video-only** (`-an`) — program audio is the deliberate Phase 7 mix bus.

Acceptance criteria:

- One output capture session supports recording plus multiple destinations.
- Switching tabs never interrupts a live destination.
- Transport health is visible per destination.

Validation (hardware): accepted against a local mediaMTX RTMP server
(`rtmp://127.0.0.1:1935`). One broadcast published two simultaneous H.264
destinations (`[path 12345]` + `[path 4321]` both online), HLS playback served
live viewers, and Stop All tore the publish down cleanly (`[RTMP] closed: EOF` →
muxer destroyed). The mediaMTX WebRTC player does not play the stream (libx264's
High-profile B-frames aren't WebRTC-conformant — "WebRTC doesn't support H264
streams with B-frames"); HLS is the local-validation viewer. Real platforms
(YouTube/Facebook/Twitch) accept the stream as-is.

## Phase 7: Program Audio Bus — IMPLEMENTED (external input)

**Scope decision (operator):** the Phase 7 mix-bus source is **external mic /
line-in only** (a PA/mixer line-in typically carries the full program mix). Live
media-video audio, background audio playback, and the Music Player remain
DELIBERATELY DEFERRED follow-ups — the output-window-content audio path needs a
controlled Web Audio graph or native process-audio capture that is out of scope
this pass. This matches the plan's guidance to "begin with the existing
deliberate external input path."

What shipped:

- `src-tauri/src/commands/program_audio.rs` — `AudioFeed`, a reusable loopback
  feed that generalizes the legacy `rtmp.rs` transport: binds `127.0.0.1:0`,
  spawns an accept+writer thread (non-blocking, ~5s, buffering early packets),
  and drains a bounded drop-newest channel into the socket ffmpeg reads as a
  second `-f aac -i tcp://127.0.0.1:<port>` input (`-c:a copy`, no re-encode; `aac` is the raw-ADTS demuxer name).
- Recorder (`recordings.rs`): `recording_start` gained `enable_audio`;
  `record_ffmpeg_args` takes `audio_port`; `RecordingSession.audio` holds the
  feed; `RecordingStatus.audio_attached` reports it.
- Streamer (`streaming.rs`): `stream_rtmp_start` gained `enable_audio` (a feed
  per audio-enabled destination); `stream_ffmpeg_args` takes `audio_port`;
  `StreamDestinationStatus.audio_attached` reports it.
- Shared senders: `recording_send_audio` and `stream_rtmp_send_audio` (both
  `LicenseTier::Premium`) — each no-ops when no matching session is active.
- Frontend: `src/hooks/useProgramAudio.tsx` `ProgramAudioProvider` (mounted in
  `App.tsx`) captures the chosen input once (`getUserMedia`, processing off),
  encodes AAC-LC with WebCodecs `AudioEncoder`, wraps frames with `wrapAdts`
  (reused from `useRtmpEncoder.ts`), and sends every packet to BOTH send
  commands — so one arm feeds any live recorder/streamer with zero cross-tab
  coordination. RecordingsTab + StreamerTab each expose a "Program audio"
  toggle + input-device picker and pass `enableAudio` to their start command.

Remaining follow-ups: content-window audio sources, source inclusion/volume/
mute/follow-live policies, and the program-audio meter + no-audio warning in
Cockpit/Streaming.

## Phase 8: Remove Canvas Capture

After native capture passes all production acceptance checks:

1. Delete `src/components/outputs/ProgramFeedCanvas.tsx`.
2. Delete `src/components/outputs/canvasProgramFeed.ts`.
3. Delete `src/hooks/useCanvasCapture.ts`.
4. Remove canvas-specific tests and diagnostics.
5. Replace canvas FPS diagnostics with native capture and encoder metrics.
6. Update `CLAUDE.md` and `docs/OUTPUT_MANAGER_DESIGN.md` to document the
   DOM-first native-capture architecture.

## Validation Matrix

Test the shared DOM surface and native capture with Bible, songs, rich slides,
scenes, cameras, media, props, blanking, logo takeover, watermarks, and every
lower-third type.

Test at 1280x720 and 1920x1080, at 125% and 150% Windows scaling, with output
and stage on one or two monitors. Run at least one 60-minute recording and
stream containing video, camera, lower thirds, and transitions. Exercise output
window close, monitor removal, capture device loss, encoder failure, and output
restart recovery.

## Delivery Order

1. Resolve output frame state.
2. Extract shared DOM ProgramSurface.
3. Remove canvas from Cockpit.
4. Complete the Windows native-capture spike.
5. Move recording to native capture.
6. Move RTMP, WHIP, and NDI to native capture.
7. Add the program audio bus.
8. Delete canvas capture infrastructure.

This order eliminates Cockpit visual duplication early while isolating the
higher-risk native capture migration until it has been proven in the target
Windows environment.
