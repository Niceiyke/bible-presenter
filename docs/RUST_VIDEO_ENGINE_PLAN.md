# Rust Video Engine Plan

Status: implementation plan
Audience: coding agents and maintainers
Scope: move the entire video pipeline out of the webview into a separate Rust
engine process (wgpu compositor + ffmpeg-next + NDI SDK), leaving the Tauri
process as a content/command center (Bible, songs, presentations, media,
service plans) plus thin preview clients.

This document is an implementation plan, not a feature wishlist. Every phase
must leave the application buildable and usable. Agents must implement one
phase at a time, run the verification commands for that slice, and update this
document and `CLAUDE.md` when a contract changes.

## 1. Why

The current production-suite architecture (see `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md`)
fixed the *contract* — one broadcast `Engine`, revision-tagged events, a shared
`ProgramFrame`, app-scoped providers — but the video *implementation* still runs
in WebView2:

- **MediaStreams cannot cross Tauri windows**, so phone camera relay needed one
  RTCPeerConnection per window and the operator window must host the phone peer
  even when the output window is closed.
- **React state in the video path** produced the `#185` re-render loops that the
  `programEncoder` / `useCameraSource` stable-snapshot fixes patch around.
- **Two renderers** (DOM `OutputWindow`/`StageWindow` vs the canvas
  `ProgramFeedCanvas`) can diverge, so the operator can see a projection that
  differs from the recorded/streamed frame.
- **WebCodecs in WebView2** limits encode quality/control (H.264 profiles,
  level, keyframe cadence) and is CPU-hungry; per-destination encoders and
  canvas rasterization burn CPU for no audience benefit.
- **NDI** needs the vendor SDK anyway; NDI receive (input) has no WebView2 path.

The rearchitecture moves all capture, compositing, encoding, muxing, recording,
streaming, and NDI into a **separate Rust engine process**. The Tauri/webview
app becomes the operator console: content prep, service planning, command and
control, and preview. The engine owns program state and output windows natively.

## 2. Target architecture

```text
Tauri process (operator console, WebView2)
  - Content: Bible, songs, presentations, media library, service plans
  - Command/control UI -> engine commands over IPC
  - Thin preview clients (MJPEG preview frames over IPC)
        |  JSON-RPC over stdio + binary frame channel (shared memory)
        v
Rust engine process (sidecar, owns ALL video)
  - Authoritative presentation state + snapshot contract (engine/…)
  - wgpu compositor -> renders ProgramFrame to output + stage windows (winit)
  - ffmpeg-next: HW decode, HW encode (NVENC/QSV), mux, RTMP, recording
  - NDI SDK (grafton-ndi): send (NDI|HX) + receive (NDI input)
  - Capture: local cameras (ffmpeg dshow) + phone frames bridged over shm
```

Layers:

```text
Content and Service Layer        (Tauri console: Bible, songs, media, plans)
        |  commands + events
        v
Broadcast Engine                  (engine process: authoritative live/staged state)
        v
Source and Program Layer          (source registry, ProgramFrame resolution)
        v
Compositor                        (wgpu: one render of the program)
        |  decoded frames / encoded packets
        v
Transport Layer                   (ffmpeg-next + NDI SDK: RTMP, WHIP, NDI, record)
        v
Output Layer                      (output + stage windows, NDI sources on LAN)
```

The operator console is a client, exactly like the remote control. It never
owns live state. The engine never serves IPC to the remote directly; the
console relays remote commands into engine commands.

### 2.1 Process boundary and IPC

- The engine is a **sidecar binary** spawned by Tauri at startup (`tauri.conf.json`
  `externalBin`, or a stdio child spawned by `main.rs` when the engine is
  licensed/enabled).
- **Command/event channel**: newline-delimited JSON-RPC over the sidecar's
  stdin/stdout. Commands mirror today's Tauri command names; events mirror the
  revision-tagged presentation events plus new engine lifecycle events
  (`video-engine-state`, `ndi-source-changed`, `recording-state`,
  `stream-state`). A shared `EngineContract` (Rust enum in `src-tauri/src/engine/ipc.rs`
  mirrored by `src/types/engine.ts`) is the single contract — additive
  `schema_version` like `outputs.json`.
- **Frame channel**: high-bandwidth frames (console previews, and phone camera
  frames flowing *into* the engine) cross via **shared memory**
  (Windows `CreateFileMapping` — `shared_memory` crate), ring-buffered, with a
  small control header (width/height/stride/frame index). The console preview
  additionally gets a **MJPEG stream** over the JSON channel at ~5–10 fps for
  cockpit/stage thumbnails; shared memory is for low-latency preview where the
  console needs it.
- The engine is authoritative for: live/staged state, settings/props/lower-third,
  output windows, recorders, streamers, NDI sessions, and source acquisition.
  The console persists content (Bible, songs, presentations, services, media)
  as it does today.

## 3. Engine modules (`src-tauri/src/engine/…` target layout)

The current `engine/presentation.rs` becomes the engine process's state layer.
New module layout inside the engine:

```text
src-tauri/src/engine/
  mod.rs            # engine contract docs
  presentation.rs   # existing Engine: op_* single-lock single-revision
  snapshot.rs       # PresentationSnapshot (schema v2) — unchanged contract
  ipc.rs            # JSON-RPC command/event contract with the console
  windows.rs        # winit output/stage window ownership + monitor handling
  compositor/
    mod.rs
    frame.rs        # ProgramFrame (mirrors src/compositor/ProgramFrame.ts)
    resolver.rs     # resolveProgramFrame (port from TS)
    wgpu.rs         # wgpu device/surface, texture upload, frame render
    text.rs         # text layout/render (cosmic-text/glyphon) + parity fixtures
    lower_third.rs  # resolveLowerThird port
    media.rs        # ffmpeg decode -> wgpu texture
  capture/
    mod.rs
    camera.rs       # ffmpeg dshow local cameras
    phone.rs        # shared-memory bridge for console-relayed phone frames
    audio.rs        # audio input -> shared bus (ffmpeg wasapi)
  transport/
    mod.rs
    encode.rs       # ffmpeg-next HW encode (NVENC/QSV) one encoder per profile
    rtmp.rs         # ffmpeg mux to RTMP URLs
    whip.rs         # WHIP (console-relayed WebRTC or webrtc-rs when mature)
    ndi.rs          # grafton-ndi send + receive
    record.rs       # recording (MP4/WebM via ffmpeg)
  persistence.rs    # atomic file writer, session state
```

## 4. Compositor (wgpu)

- One `wgpu` device, GPU-composited. Renders the resolved `ProgramFrame`
  (source item, effective background, blackout, masked overlays, scene zones,
  lower third, logo) to:
  - the **output window** (projection surface, exclusive/duplicated),
  - the **stage window** (confidence view),
  - an **offscreen texture** that the transport layer encodes.
- **Media decode → texture**: ffmpeg-next decodes to `NV12`/`BGRA`, uploaded to
  a `wgpu` texture (`Rgba8Unorm`/`Bgra8Unorm`), filtered by the compositor.
- **Text**: `cosmic-text` + `glyphon` (or skia bindings if parity demands).
  Rich text (ProseMirror slides, styled lower thirds) is the long pole — see
  §8.
- **Phone camera frames**: received in the console, written to shared memory,
  read by the engine, uploaded like any camera texture.
- The DOM renderers stay the **parity oracle** during migration: fixtures
  render the same `ProgramFrame` through both the DOM path and the wgpu
  compositor and must match (within a tolerance) before an output moves over.

## 5. Transport (ffmpeg-next + NDI SDK)

- **Encode**: one ffmpeg-next encoder **per visual profile** (not per
  destination), hardware-accelerated (`h264_nvenc` / `h264_qsv` / `d3d11va`),
  producing H.264 Annex-B access units — the same packet bus concept as
  `src/system/programEncoder.ts`, now in-process. This is the CPU win that
  motivates the move.
- **RTMP**: ffmpeg-next mux + network (replaces the `ffmpeg -f h264 -i pipe:`
  subprocess). Sessions keyed by `session_id`, typed `queued/dropped/closed`
  results, bounded queue — the existing `commands/rtmp.rs` contract is the spec.
- **Recording**: ffmpeg-next mux to MP4 (or WebM), replacing `MediaRecorder`.
- **WHIP**: console-relayed WebRTC via the shared-memory/relay path during
  migration; revisit `webrtc-rs`/GStreamer `webrtcbin` only if WHIP needs become
  native (see §8 tradeoffs).
- **NDI (SDK, both directions)**:
  - **Send (NDI|HX)**: ffmpeg-next HW-encodes to H.264 Annex-B →
    `NDIlib_send_send_video_async_v2` with the access units. Sessions keyed by
    `session_id` like RTMP; announce `"Wordlyte – <name>"`. This replaces the
    WebCodecs→`ndi_send` base64 path in `src-tauri/src/commands/ndi.rs`.
  - **Receive (NDI input)**: `NDIlib_recv_capture_v2` polling loop returns
    decoded `video_frame` (BGRA/UYVY) + `audio_frame`; video → wgpu texture
    upload, audio → shared audio bus. The SDK does the decode; the engine owns
    the receive loop and buffer queue. NDI sources register into the engine's
    source registry like cameras, so a received NDI feed can appear in a scene
    zone or be taken live.
  - The `ndi` cargo feature gate stays; the SDK ships in the installer
    (`Processing.NDI.Lib.x64.dll` bundled, per the existing NDI Phase 8 plan).

## 6. Audio

Port the shared audio graph concept (`src/system/audioGraph.ts`) into the
engine: one input device (`ffmpeg` wasapi/dshow) → gain bus → `programTrack`
cloned to recording + streaming destinations. Independent monitor track so
program mute/volume never affects operator monitoring. NDI receive audio feeds
the same bus. Premium-tier gating moves to the engine side too (defense in
depth; console still gates the UI).

## 7. What stays in the Tauri console

- Content: Bible lookup/versions/search, songs/lyrics, presentations/slides,
  media library + metadata, service plans/schedules, scenes **as data**,
  props/timers **as data**.
- Command/control UI, remote-control server, licensing UI, diagnostics display.
- **Preview clients**: cockpit live/staged previews, stage preview, camera
  thumbnails — all thin viewers of engine snapshots/events + MJPEG preview
  frames. No component owns acquisition, encoding, or rendering of the program.

Deleted from the webview once the engine path is live: `canvasProgramFeed`,
`ProgramFeedCanvas/Preview`, `programEncoder.ts`, `useRtmpEncoder`, `useStreamer`,
`useRecordingProvider` (video part), `useCameraSource` (acquisition part),
`OutputWindow`/`StageWindow` webview branches, `useAudioGraphProvider` (acquisition
part), phone-camera *rendering* in windows (relay stays in console).

## 8. Explicit tradeoffs and decisions

- **GStreamer rejected for size**: the NDI SDK already covers NDI send/receive
  and ffmpeg-next covers everything else this app needs; GStreamer's ~100MB
  runtime + plugin registry tax buys only `webrtcbin`/`ndisrc` graph elements we
  can hand-build (~150 lines receive glue) — not worth the installer footprint.
- **WebRTC stays in the console** during migration (phone camera, WHIP): relay
  frames over shared memory. `webrtc-rs` is not production-grade yet; revisit
  when it is, or if GStreamer's `webrtcbin` becomes acceptable.
- **NDI receive glue is owned code**: the SDK does decode; the engine owns the
  receive loop, buffer queue, and source-registry registration. Protocol work
  stays in the SDK.
- **Rich text parity is the long pole**: wgpu text must match the DOM renderers
  for slides/lower thirds. Budget a dedicated parity phase with fixture tests
  before moving projection over; otherwise projections regress visually.
- **Console and engine state cannot diverge**: the console applies engine events
  through the existing `PresentationSync` guard semantics; the engine is the
  only writer of program state. Do not add a second live-state owner.

## 9. Implementation phases

Every phase must leave `npm run build` and `cargo check` green.

### Phase A: Engine process skeleton + IPC contract

- Add the sidecar binary (or `externalBin`), spawn/teardown from `main.rs`.
- Define `engine/ipc.rs` JSON-RPC contract: command names mirror the current
  Tauri display/output/rtmp/ndi commands; events mirror revision-tagged
  presentation events + engine lifecycle events. Add `src/types/engine.ts`
  mirror + contract tests.
- Move `engine/presentation.rs` state + ops into the engine process as the
  authoritative owner; the Tauri console's commands become IPC clients.
- `presentation_snapshot` served by the engine; console hydrates via snapshot +
  replay (existing `PresentationSync`).
- Acceptance: staging/going live from the console drives the engine; console
  and output windows converge; existing frontend tests pass against the IPC
  contract.

### Phase B: wgpu compositor parity

- Port `resolveProgramFrame` + `resolveLowerThird` to Rust; wgpu compositor
  renders the frame to a hidden window.
- Fixture parity: same fixtures feed DOM renderers and wgpu compositor; compare
  output (text, colors, backgrounds, scenes, lower thirds, media) with a
  tolerance. Rich text is the acceptance gate.
- Acceptance: rendered frame matches the DOM oracle for every fixture.

**B1 (DONE, `59b82cf`):** the pure Rust mirror lives in
`src-tauri/src/engine/compositor/` (`frame.rs`, `lower_third.rs`,
`resolver.rs`) with the resolver/lower-third TS suites ported as Rust unit
tests (197 lib tests passing, clippy clean). B2 adds the wgpu renderer against
the hidden window; B3 adds the fixture-parity harness against the DOM oracle.

### Phase C: Move output + stage windows to the engine

- Engine owns winit output/stage windows (monitor handling moves too).
- Console shows low-res MJPEG previews of both.
- Delete `OutputWindow`/`StageWindow` webview branches.
- Acceptance: projection and stage render from the engine; monitor/scaling
  matrix (1/2 monitors, 125%/150% scaling) passes.

### Phase D: Transport — encode, RTMP, recording

- One ffmpeg-next HW encoder per profile feeding a packet bus; RTMP sessions
  and recording replace the WebCodecs/MediaRecorder paths.
- Keep the existing `rtmp_start`/`rtmp_send`/`rtmp_stop`/`rtmp_status` and
  `recording_*` command shapes over IPC.
- Acceptance: two RTMP destinations share one encoder; recording survives
  navigation; failed transport does not change live state.

### Phase E: NDI send + receive

- `ndi` feature + `grafton-ndi`; send NDI|HX from the shared encoder; receive
  loop registers NDI sources into the source registry (usable in scene zones /
  live).
- Keep the SDK-gated scaffold behavior until the SDK is present.
- Acceptance: OBS/vMix/ProPresenter can take the Wordlyte source; a received
  NDI camera feeds a scene zone and can go live.

### Phase F: Capture — cameras, audio, phone bridge

- Local cameras via ffmpeg dshow; audio graph in-engine; phone camera relay
  from console over shared memory into the source registry.
- Delete webview acquisition hooks (`useCameraSource`, `useSharedLocalCameraStream`,
  `useAudioGraphProvider` acquisition parts).
- Acceptance: one camera shared by preview/scene/program/stream without
  duplication; device loss safe-fallbacks; audio mute never touches visuals.

### Phase G: Strip the webview video path

- Delete `canvasProgramFeed`, `ProgramFeedCanvas/Preview`, `programEncoder.ts`,
  `useRtmpEncoder`, `useStreamer`, `useNdiSender`, recording/streaming video
  providers, and any remaining video in the console.
- Console keeps: content, service, scenes-as-data, remote, licensing, engine
  command/control, MJPEG previews.
- Acceptance: `npm run build` + `cargo check` + `npm run test` green; no
  `getUserMedia`, `VideoEncoder`, `MediaRecorder`, or `<canvas>` capture remains
  in the webview; manual acceptance matrix (§10) passes.

## 10. Manual acceptance matrix (unchanged product surface)

- Main window 1280x720 and 1920x1080.
- Windows scaling 125% and 150%.
- Output and stage on one monitor and on two monitors.
- Output/stage window toggle failure; engine start failure.
- Stage failure before go-live.
- Clear live / clear all propagation.
- Service reorder, undo, redo, save, restart recovery.
- Missing Bible assets and missing media files.
- Lower third, timer, props, scene, camera, presentation behavior.
- Recording while navigating workspaces; RTMP to two destinations; WHIP to a
  public endpoint; NDI send to OBS/vMix; NDI receive from an NDI camera.
- Camera permission denial and disconnect; audio device disconnect; network
  loss during stream; forced process termination during persistence.

## 11. Testing strategy

- **Rust unit tests**: engine ops (port the existing `engine/presentation.rs`
  tests), `resolveProgramFrame`/`resolveLowerThird` parity, wgpu text fixture
  parity, ffmpeg encode/rtmp session logic (mocked process/network), NDI
  send/receive loop with a mock SDK layer, packet-bus ordering/backpressure.
- **Contract tests**: `src/types/engine.ts` ↔ `engine/ipc.rs` (mirror of the
  existing `protocolContract.test.ts` approach).
- **Console tests**: components now mock the IPC client; existing
  `useItemActions`, `presentationSync`, store tests are preserved against the
  new command surface.
- **Integration**: console→engine command flow, engine→console event flow,
  window reopen convergence, phone frame bridge, one encoder → two transports.
- Agents run `npm run build`, `npm run test`, `cargo check`, `cargo clippy`,
  and the phase's acceptance criteria before moving on.

## 12. Agent execution rules

1. Read this plan and the relevant current files before editing.
2. State the phase and exact task being implemented.
3. Avoid unrelated refactors.
4. Preserve existing persisted data unless the task includes a migration.
5. Route every program mutation through the engine (no console-side live-state
   ownership).
6. Do not add a second compositor, second encoder, or second source lifecycle.
7. Add tests for the failure path, not only the success path.
8. Run `npm run build` for frontend changes; `cargo check`/`clippy` for backend.
9. Update `CLAUDE.md` and `docs/CONTRACT_INVENTORY.md` when contracts change.
10. Report files changed, tests run, failures, and remaining risks.

## 13. Definition of done

The rearchitecture is complete when:

- Every audience-visible frame is produced by the engine's wgpu compositor.
- Every encode/mux/transport runs in-process in the engine (ffmpeg-next + NDI
  SDK); no WebView2 media APIs remain in the video path.
- Output and stage windows are native engine windows.
- NDI send and NDI receive both work from the engine.
- The console is a pure command/control + content client.
- Program state is single-owned (engine) with no divergence path.
- `npm run build`, `npm run test`, `cargo check`, `cargo clippy` pass.
- The manual acceptance matrix passes on supported Windows configurations.

The architectural test: adding a new source, output, transport, or scene effect
requires implementing that capability's adapter in the engine and its UI in the
console — never editing every workspace, window, and live-state switch.