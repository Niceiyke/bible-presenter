# Output Manager — Design Proposal

The operator vision is a **unified production engine** (sources → engine → outputs):

```
Sources (DisplayItem)          Engine                     Outputs
  Camera (native/phone)    ┌────────────────┐     ┌───────────────────────┐
  Media (image/video/audio)│  live_item      │     │ Output "projection"    │ window
  Bible verse              │  staged_item    │ ──► │ Output "stage"         │ window
  Custom slide             │  props          │     │ Output "overflow"      │ window
  Song / lyrics            │  lower_third    │     │ Output "record-main"   │ recorder
  Timer                    │  settings       │     │ Output "stream-main"   │ streamer
  Scene composition        │  scenes         │     └───────────────────────┘
  ...                      └────────────────┘
```

The codebase already has most of the engine and source model. What is missing is a
single **configurable output surface** abstraction so every output — a projected
window, a confidence monitor, an overflow monitor, a file recorder, or a streaming
feed — is one configurable, subscribable surface fed by the same program state.

This doc defines the data model, backend state, event contract, and migration path.
It does not change existing behavior: today's `output`/`stage` windows become the
default instances of the manager.

---

## 1. Core concepts

- **Source** — anything that can be rendered: a `DisplayItem` (already the unified
  type), a scene, or the live/staged state of the engine.
- **Program feed** — the authoritative composition being broadcast: live item +
  overlays (props, lower third, logo) resolved against the current settings.
- **Output** — a configurable surface that subscribes to a source and renders it.
  An output may be:
  - a **window** (Tauri webview: `output`, `stage`, or a future `overflow`),
  - a **recorder** (a `MediaRecorder` on a canvas `captureStream()` writing WebM),
  - a **streamer** (a WebRTC/WHIP or RTMP/SRT upload of the same stream).

Every output has its **own** geometry, presentation overrides, and overlay mask.
Outputs never mutate engine state; they only subscribe.

---

## 2. Data model (TypeScript)

New module: `src/types/output.ts`.

```ts
export type OutputKind = "window" | "recorder" | "streamer";

/** What an output renders. */
export type OutputSource =
  | { type: "live" }                       // the engine's live program feed
  | { type: "staged" }                     // the staged (up-next) item
  | { type: "scene"; scene_id: string }    // pin to a saved scene
  | { type: "item"; item: DisplayItem }    // fixed content, e.g. clock, logo
  | { type: "blank" };                     // black/safe fallback

/** Presentation overrides. Absent = inherit engine settings. */
export interface OutputPresentation {
  theme?: string;                          // override audience theme
  reference_output_height?: number;        // typography scale basis (default 1080)
  background?: BackgroundSetting;          // override background layer
  blanked?: boolean;                       // force black
}

/** Which overlay layers render on this output. */
export interface OutputOverlays {
  props: boolean;
  lower_third: boolean;
  logo: boolean;
}

/** Geometry — the render surface is a canvas sized to this. */
export interface OutputGeometry {
  width: number;
  height: number;
}

export interface OutputConfig {
  id: string;                              // "output" | "stage" | "overflow" | "record-main" | ...
  kind: OutputKind;
  label: string;                           // operator-facing name
  enabled: boolean;
  visible: boolean;                        // window shown / recorder+streamer active
  source: OutputSource;
  geometry: OutputGeometry;
  presentation?: OutputPresentation;
  overlays: OutputOverlays;
  /** Window-specific: Tauri window label this binds to. */
  window_label?: string;
  /** Recorder/streamer-specific. */
  recording?: {
    format: "webm";
    directory?: string;                    // default: app-data recordings/
  };
  streaming?: {
    mode: "whip" | "rtmp" | "srt";
    url: string;
    stream_key?: string;
  };
}

/** Runtime status of an output (ephemeral, not persisted). */
export interface OutputState {
  id: string;
  visible: boolean;
  rendering: boolean;
  fps: number;
  error?: string;
}
```

Persisted under the app data dir (same pattern as `remote_devices.json`), not in the
SQLite data DB — it is operator hardware/preference state, like the remote port file.

---

## 3. Backend state (Rust)

New module: `src-tauri/src/outputs.rs`. State registered in `AppState` (see
`state.rs`), mirroring the `RemoteControl` pattern (Arc so tauri state, axum task and
commands share one instance):

```rust
pub struct OutputManager {
    pub configs: Arc<RwLock<Vec<OutputConfig>>>,
    pub runtime: Arc<RwLock<HashMap<String, OutputRuntime>>>,
    configs_file: PathBuf,
}
```

`OutputRuntime` holds the live recorder/streamer handles (MediaRecorder is
frontend-side; the Rust side keeps the file target and stream task for `streamer`).

`AppState` gains:

```rust
pub outputs: Arc<OutputManager>,
```

The manager is constructed after `AppState` in `main.rs`, before windows are created —
it seeds defaults for the existing `output` and `stage` windows (see §6) so startup
behavior is identical.

### Commands — `src-tauri/src/commands/outputs.rs`

| Command | Purpose |
|---|---|
| `outputs_list` | Returns `Vec<OutputConfig>` (+ `OutputState[]`). |
| `outputs_update(configs)` | Replace-all config set (idempotent, like `save_lt_templates`), persists + emits `output-config-changed`. |
| `outputs_set_visible(id, visible)` | Show/hide a window output (maps to the existing window toggle), or start/stop a recorder/streamer. |
| `recorder_start(id, file_name?)` / `recorder_stop(id)` | Explicit record control returning the written file path. |
| `stream_start(id)` / `stream_stop(id)` | Start/stop the streaming surface. |

---

## 4. Event contract

Added to `src/hooks/useTauriEvent.ts` `EventMap` and mirrored in Rust `events.rs`
with `emit_checked`, consistent with existing events:

```ts
"output-config-changed": import("../types/output").OutputConfig[];
"output-state-changed": import("../types/output").OutputState;
```

- `output-config-changed` fires on any config change and carries the **full list**
  (replace-all semantics) so every window hydrates from one authoritative source.
- `output-state-changed` fires per output on visibility/rendering/fps/error changes
  so the operator UI can show live status without polling.

Engine events are untouched: `live-item-update`, `item-staged`, `settings-changed`,
`props-update`, `lower-third-update` keep driving the program feed. Outputs do not
add new engine events.

---

## 5. Frontend

### Store slice — `src/store/slices/outputSlice.ts`

Registered in `src/store/index.ts` like the other slices:

- `outputs: OutputConfig[]`
- `outputStates: Record<string, OutputState>`
- Hydrated in `useAppInitialization.ts` via `outputs_list`.
- Subscribes to `output-config-changed` and `output-state-changed`.

### Rendering

- `OutputWindow.tsx` and `StageWindow.tsx` stop hardcoding their branch logic; they
  read their `OutputConfig` from the store (`window_label === "output"` / `"stage"`),
  apply `presentation`/`overlays` overrides, and render the **same** shared
  `CompositionRenderer` the engine already uses.
- A new generic `ProgramFeed` component resolves `source` → live item / staged item /
  scene / item / blank, and feeds the output.
- **Recorder & streamer** render the same `ProgramFeed` into an offscreen
  1920×1080 canvas and use `canvas.captureStream()`; `MediaRecorder` writes WebM
  (recorder), and the stream feeds an `RTCPeerConnection` WHIP peer (streamer).

Because recording/streaming subscribe to the same `ProgramFeed` as the windows,
there is exactly one program definition — the DOM/Canvas divergence is an
implementation detail of the surface, not of the content.

---

## 6. Migration path (non-breaking)

Seed defaults, identical to today's behavior:

| id | kind | window_label | source | geometry | notes |
|---|---|---|---|---|---|
| `output` | window | `output` | live | 1920×1080 | projected program |
| `stage` | window | `stage` | live | 1280×720 | confidence monitor; `stage_uses_theme` seeds its presentation override |
| `overflow` | window | (none yet) | live | 1920×1080 | optional second projection |
| `record-main` | recorder | — | live | 1920×1080 | disabled until a recorder is started |
| `stream-main` | streamer | — | live | 1920×1080 | disabled until streaming is configured |

- Configs persist to `outputs.json` under the app data dir; absent file → seed defaults.
- Window creation in `tauri.conf.json` stays; `outputs_set_visible` reuses the
  existing window-toggle machinery in `commands/windows.rs`.
- `stage_uses_theme` remains honored and is folded into `stage.presentation` during
  migration (later removed as a settings field).

---

## 7. Phased roadmap

1. **Phase 1 — Output manager core** ✅ (implemented on `feat/output-manager`): types,
   `OutputManager`, commands, events, `outputSlice`, wire `OutputWindow`/`StageWindow`
   to read their config, `outputs.json` persistence + migration. No behavior change.
2. **Phase 2 — Program feed compositor** ✅ (implemented on `feat/output-manager`):
   offscreen-canvas renderer that draws the program feed (verses, slides, songs, media,
   scene compositions, overlays) and exposes `captureStream()`. Window outputs may
   switch to it later for a single render path.
   - `src/components/outputs/canvasProgramFeed.ts`: pure Canvas 2D draw helpers —
     backgrounds, verse typography (reference tag, split marker, theme colors), media
     (image/video/audio card), cameras (native + phone), timers, songs, custom slides
     (background + text/image/video/shape elements), scene-composition zones, props
     (image/clock), logo, and lower thirds. Unit-tested with a stub context.
   - `src/hooks/useCanvasCapture.ts`: rAF loop + `canvas.captureStream()` at a
     configurable FPS, exposing the composited `MediaStream` to recorder/streamer.
   - `src/components/outputs/ProgramFeedCanvas.tsx`: React wrapper owning the resource
     pipeline (images/videos resolved via `convertFileSrc`, pre-warmed camera streams)
     and compositing one `ProgramFeedFrame` per tick.
   - `src/components/outputs/ProgramFeedPreview.tsx`: operator-facing verification
     surface subscribing to the shared store; toggled in the Cockpit's On-Air preview
     (PGM button) so the canvas composition can be eyeballed against the DOM
     `PreviewCard`.
3. **Phase 3 — Recorder surface** ✅ (implemented on `feat/output-manager`):
   `MediaRecorder` → WebM, Recordings tab, start/stop, file listing in app-data. The
   recorder consumes the `ProgramFeedCanvas` stream directly.
   - `src-tauri/src/commands/recordings.rs`: `recordings_list`, `recording_save`
     (base64 body written to `{app_data_dir}/recordings/`), `recording_delete`,
     `recordings_open_folder` (OS reveal).
   - `src/hooks/useRecorder.ts`: MediaRecorder wrapper — lazy creation on `start`,
     WebM chunk collection, base64 persistence via `recording_save`, `cancel`
     (abort without save), empty-capture + save-failure guards. Unit-tested with a
     mocked MediaRecorder.
   - `src/components/RecordingsTab.tsx`: live `ProgramFeedPreview` (the exact pixels
     recorded), REC/STOP/Abort transport, elapsed timer, saved-recordings list with
     size/date, delete and open-folder. Tab registered in `appSlice.activeTab`,
     `LeftNav` (System → Recordings), and `ContentBrowser`.
4. **Phase 4 — Streamer surface** ✅ (implemented on `feat/output-manager`): WHIP via
   `RTCPeerConnection` (WebView2-native WebRTC); RTMP/SRT later on the existing
   `webrtc` crate if needed.
   - `src/hooks/useStreamer.ts`: WHIP client — ICE candidate gathering, SDP offer
     POSTed as `application/sdp` (Bearer auth), answer applied, `connectionstate`
     → live, best-effort `DELETE` of the WHIP resource on stop, `getStats` bitrate
     polling. Unit-tested with stubbed `RTCPeerConnection`/`fetch`.
   - `src/components/StreamerTab.tsx`: live `ProgramFeedPreview`, WHIP endpoint +
     token config persisted to the `stream-main` output's `streaming` field via
     `outputs_update`, Go Live/Stop transport, status + bitrate indicators. Tab
     registered in `appSlice.activeTab`, `LeftNav` (System → Streaming), and
     `ContentBrowser`. No backend changes — WebView2 handles RTP natively.
5. **Phase 5 — Multi-bus / zone bus primitives**: sources → PGM/AUX buses →
   outputs, turning `SceneComposition` zones into the first-class bus primitive.
   Implemented as *live-follow zones*: a `SceneZone` may carry a
   `source: SceneZoneSource` (`item` static, or pinned to `verse`/`camera`/
   `timer`/`song`/`media`/`slide`). When a scene composition is the current live
   item and content of a pinned class is taken live (operator UI or remote), the
   backend patches the matching zone(s) in place via `patch_scene_zones` inside
   `op_commit_staged`/`op_go_live_item` instead of replacing the whole scene — so
   a camera+verse scene's bible zone advances as the operator steps through the
   Bible, a timer zone follows the live countdown, and the compositor
   (recorder/streamer capture) and DOM outputs both pick the refresh up
   automatically. Static zones (no `source`) keep the legacy replace-the-scene
   take. The `SceneZoneSource` union lives in `src/types/scene.ts` and mirrors
   the serde-tagged `SceneZoneSource` in `src-tauri/src/store/media_schedule.rs`;
   the SceneBuilder inspector exposes the "Follows live content" selector.
   Scene-aware stepping: when a composition is live, the Cockpit Next button and
   the keyboard ArrowLeft/ArrowRight/Home/End delegate to the first pinned zone
   whose content kind supports navigation (`compositionDrivingZone` in
   `src/items/registry.tsx`) — so the operator advances the scene's verse/song
   from the operator console without leaving the cockpit.
   Unit-tested in `remote/commands.rs` (`patch_scene_zones`, source matching,
   serde round-trip), `src/items/__tests__/registry.test.ts` (scene stepping),
   and covered by the transactional `useItemActions` path.
6. **Phase 6 — RTMP ingest** ✅ (implemented on `feat/output-manager`): the
   streamer surface gains an RTMP mode alongside WHIP. The compositor stream is
   encoded **once** in the webview with WebCodecs `VideoEncoder` (H.264,
   Annex-B, `annexb` output; hardware-accelerated where available) and its
   packets are streamed to the backend (`rtmp_send`), which feeds a long-lived
   `ffmpeg -f h264 -i pipe:` doing **mux-only** `-c copy` work — ffmpeg never
   re-encodes. Frontend: `src/hooks/useRtmpEncoder.ts` (`MediaStreamTrackProcessor`
   pulls `VideoFrame`s from the compositor track, keyframes every ~2s, per-packet
   base64 over IPC). Backend: `src-tauri/src/commands/rtmp.rs` (`rtmp_start` /
   `rtmp_send` / `rtmp_stop` / `rtmp_status`; dedicated writer thread drains an
   mpsc channel into ffmpeg stdin so the UI thread never blocks on pipe
   backpressure; 5s stop timeout with forced kill). Session lives on
   `AppState.rtmp` (`Arc<Mutex<Option<RtmpSession>>>`). The `stream-main` output's
   `streaming` field persists `mode: "rtmp"` + `url` + `stream_key` through the
   existing `outputs_update` flow; `StreamerTab` toggles WHIP/RTMP. ffmpeg is
   resolved bundled-first (see the note below) and errors cleanly when missing.
   Unit-tested in `commands/rtmp.rs` (URL joining, mux-only args)
   and `src/hooks/__tests__/useRtmpEncoder.test.ts` (WebCodecs stubs, feed,
   teardown).
6. **Phase 6.1 — RTMP audio** ✅ (implemented on `feat/output-manager`): the
   RTMP mode can carry an audio track. The operator enables an input device in
   `StreamerTab` (mic / line-in / mixer feed — `getUserMedia` with echo
   cancellation, noise suppression, and AGC **off** so the PA mix is not
   mangled), selected from `enumerateDevices`. The track is encoded once with
   WebCodecs `AudioEncoder` (AAC-LC `mp4a.40.2`, `AudioData` pulled by a second
   `MediaStreamTrackProcessor`), each frame wrapped in a 7-byte ADTS header
   (`wrapAdts` in `useRtmpEncoder.ts`), and streamed via `rtmp_send_audio`.
   The backend opens a loopback `TcpListener`, passes its port to ffmpeg as a
   second input (`-f adts -i tcp://127.0.0.1:<port>`, `-c:a copy` — still mux
   only), and `spawn_audio_writer` accepts ffmpeg's connection (non-blocking,
   ~5s window, buffers early packets) then drains an mpsc channel into the
   socket. `rtmp_start` takes `with_audio` so the ffmpeg graph only includes
    the AAC input when audio is live. Unit-tested (ADTS framing + URL/args) in
    the same suites above.
6. **Phase 6.2 — Multi-platform Streaming Hub** ✅ (implemented on
   `feat/output-manager`): `StreamerTab` becomes a hub that streams the one
   compositor feed to **any number of destinations at once** (YouTube +
   Facebook + Twitch + custom RTMP/WHIP simultaneously). Each destination is a
   platform preset (`src/components/streaming/presets.ts` pre-fills the ingest
   server — the operator only pastes their stream key), rendered as a
   `DestinationCard` that owns its own transport instance (`useRtmpEncoder` with
   a `sessionId`, or `useStreamer`). The compositor video track is **cloned per
   destination** (a track can only have one `MediaStreamTrackProcessor`), and
   the shared audio input is captured once and cloned per destination too.
   Master **Go Live All** starts every enabled destination; per-card status /
   bitrate / error and Stop-All round it out. Backend: RTMP sessions are keyed
   by destination id in a `HashMap` on `AppState.rtmp` (`rtmp_start` /
   `rtmp_send` / `rtmp_send_audio` / `rtmp_stop` all take `session_id`;
   `rtmp_status` returns the list). Persistence: the `stream-main` output gains
   a `stream_destinations` list (`StreamDestination` in `outputs.rs` + TS),
   seeded from the legacy `streaming` field when present. Unit-tested:
`ffmpeg_args` graphs, preset table / `makeDestination` / `applyPreset`, and
    the session-keyed `useRtmpEncoder` invoke calls.
7. **Phase 7 — System diagnostics & performance monitor** ✅ (implemented on
   `feat/output-manager`): a readiness/check battery plus a live performance
   monitor, so the operator knows what the machine can do and how hard it is
   working mid-show. Backend (`src-tauri/src/commands/system.rs`, new `sysinfo`
   dependency): `system_info` returns a one-shot hardware snapshot (CPU model,
   physical cores, RAM, disk, ffmpeg availability) and `system_metrics` a cheap
   polled metric (CPU %, RAM %, disk %, active RTMP session count). Frontend:
   `SystemDiagnosticsProvider` (mounted in `App.tsx`) runs the battery once —
   backend info, `get_available_monitors` for display count, a WebCodecs H.264
   `isConfigSupported` probe, WebRTC availability, `enumerateDevices` for audio/
   camera presence, `hardwareConcurrency`/`deviceMemory` — and derives a pure
   capability report (`src/system/capabilities.ts`): `rtmpAvailable`,
   `whipAvailable`, `audioAvailable`, `cameraAvailable`, a streaming-capacity
   tier with a recommended simultaneous-stream count, and human-readable
   *reasons* for every disabled service. Gating: disabled services stay visible
   but can't start — `StreamerTab` disables RTMP Go Live (and per-card transport)
   when ffmpeg/WebCodecs H.264 is missing and warns when no audio input exists.
   The System → Diagnostics workspace (`src/components/SystemTab.tsx`, registered
   in `appSlice.activeTab` + `LeftNav` + `ContentBrowser`) shows the checklist,
   hardware summary, capability/gating report, and a live performance panel.
   Metrics poll only while that panel is open (zero idle cost); compositor
   capture FPS is a rolling frame counter in `src/system/captureMetrics.ts`
   ticked by `useCanvasCapture`. Unit-tested: `src/system/__tests__/
   capabilities.test.ts` (gating matrix + capacity tiers).

## 8. Bundled media binaries

ffmpeg/ffprobe are resolved **bundled-first** via `src-tauri/src/binpaths.rs`:
`{resource_dir}/bin/ffmpeg.exe` (shipped through `bundle.resources`, see
`tauri.conf.json`) is used when present, with a PATH fallback so dev and
machines without the bundle still work. The binaries are **not committed** to
git — `scripts/fetch-ffmpeg.ps1` downloads the BtbN **LGPL** Windows build
(no x264/x265 → no GPL obligations for the mux-only RTMP path) into
`src-tauri/binaries/`, and must be run before `npm run tauri build` (tauri-build
validates resource existence, so `cargo check`/`cargo test` need it too).
`binpaths::init` is called in `main.rs` setup with the resolved resource dir.
Removes the "install ffmpeg" hard gate for RTMP streaming and keeps media
probing working offline.

Phase 1 is strictly additive and safe to land independently; everything after it
consumes the same model.

---

## 9. NDI — LAN source output & input (Phase 8)

NDI serves two church segments:

- **OBS mixed services**: Wordlyte renders graphics; OBS mixes + streams. Wordlyte
  publishes its program as an NDI source and OBS consumes it via obs-ndi → NDI
  **output** is the core requirement.
- **Standalone services**: Wordlyte does everything including streaming; NDI
  cameras (or a laptop with vMix/ProPresenter as a source) feed Wordlyte → NDI
  **input** is the core requirement.

Both directions are first-class; neither needs the other to ship.

### 9.1 SDK model — build-time dep, bundled runtime (end users download nothing)

There are two distinct NDI pieces:

- **Build-time SDK** (headers + lib): only needed on the **developer/build
  machine** to compile the sender against `grafton-ndi` (a bindgen build
  dependency, so LLVM/clang are also required). The operator never installs
  this. Download `https://ndi.video/for-developers/ndi-sdk/download/` (accept
  the EULA — it is form-gated, so only a human can do it) and install to
  `C:\Program Files\NDI\NDI 6 SDK` (or set `NDI_SDK_DIR`).
- **Runtime DLL** (`Processing.NDI.Lib.x64.dll`): the only NDI component an end
  user's machine needs, sitting next to the app exe. It ships **inside the
  installer** via `bundle.resources` (mirroring the bundled ffmpeg flow) — the
  church operator installs Wordlyte and NDI just works.

License obligations: royalty-free + redistributable, but no reverse engineering;
the SDK version shipped must be **less than 30 days old at product release** (so
`scripts/fetch-ndi.ps1` re-fetches the runtime DLL at each release and the
release process checks its build date); the app must credit NDI® and link
`ndi.video` near any NDI usage (About box).

The feature-gated scaffold ships first (committed as `7feae56`) so the whole
surface compiles, tests, and gates correctly **without the SDK**:

- `StreamDestination.mode` / `StreamPlatform` accept `"ndi"` (`src/types/output.ts`).
- NDI preset in `src/components/streaming/presets.ts` (no ingest URL).
- Backend `src-tauri/src/commands/ndi.rs` + the `ndi` cargo feature:
  `ndi_status` (reports unsupported when the SDK isn't compiled in — drives
  capability gating) and `ndi_start` / `ndi_send` / `ndi_stop` (error cleanly).
- Capability `ndiAvailable` / `ndiReason` fed from `ndi_status` in the
  diagnostics battery (`src/system/SystemDiagnosticsContext.tsx`), shown in the
  System → Diagnostics checklist and gating NDI cards in `StreamerTab`.
- `src/hooks/useNdiSender.ts`: WebCodecs H.264 Annex-B → `ndi_send`, modeled on
  `useRtmpEncoder` (session-keyed, track cloned per destination); the card hides
  the URL/key inputs and shows the announced source name (`Wordlyte – <label>`);
  the audio checkbox is disabled until the SDK phase adds NDI audio.

### 9.2 Sender pipeline (SDK phase)

Reuses the hub's single-encode architecture: the compositor video track is
cloned per destination, `useNdiSender` encodes H.264 Annex-B (hardware-
accelerated where available, ~2s keyframe interval) and streams packets to the
backend (`ndi_send`). The backend (`#[cfg(feature = "ndi")]` branches in
`commands/ndi.rs`) wraps them with the SDK's H.264 send mode:

1. `ndi_status`: probe the SDK (`NDIlib_initialize`, `NDIlib_is_supported_CPU`,
   version + license age).
2. `ndi_start(session_id, name)`: `NDIlib_send_create_v2` announcing
   `"Wordlyte – <name>"`, an `NDIlib_avsync_create`, and `NDIlib_send_create`
   for the H.264 video (NDI|HX). Sessions live in a `HashMap` on `AppState.ndi`,
   keyed by `session_id` exactly like `AppState.rtmp`.
3. `ndi_send(session_id, data_base64)`: decode + feed each Annex-B access unit
   through `NDIlib_avsync_video` + `NDIlib_send_send_video_async_v2` (H.264
   video needs the A/V-sync reference clock to derive PTS).
4. `ndi_stop(session_id)`: destroy the avsync + sender (idempotent, unknown
   session is a no-op).

The frontend already collects bytes into `{app_data_dir}/recordings`-style
buffers; NDI needs no persistent state beyond the session.

**NDI audio (Phase 8.1)**: NDI|HX carries AAC audio in the payload. When the
SDK phase lands, the hub's shared AAC encode (already produced per destination
for RTMP) is fed via `ndi_send_audio` → `NDIlib_send_send_audio_v2`, re-enabling
the per-card Audio checkbox.

### 9.3 Input pipeline (later)

NDI **input** = SDK discovery + receive → a camera source the operator can stage
like any native camera:

1. `ndi_list_sources`: `NDIlib_find_create_v2` discovery, returned as NDI|HX
   sources (name + address + H.264/HQ capability).
2. `ndi_receive_start(session_id, source)`: `NDIlib_recv_create_v2` with
   `NDIlib_recv_bandwidth_lowest` (NDI|HX first — H.264 packets already match the
   WebCodecs pipeline). Full-bandwidth NDI requires backend re-encode to H.264
   and a faster pipe than IPC (raw frames at 1080p30 ≈ 380 MB/s) — out of scope
   until needed.
3. Frontend: pull H.264 access units (`NDIlib_recv_capture_v2`), decode with
   WebCodecs `VideoDecoder`, and hand the frames to a `VideoTrackGenerator`
   (WebView2-native) so the feed presents as a normal `MediaStreamTrack` to the
   camera/zone sources, `ProgramFeedCanvas`, recorder, and streamer unchanged.

### 9.4 Shipping

`Processing.NDI.Lib.x64.dll` (+ `x86` for the installer if we support 32-bit)
is **bundled into the installer**, not installed on the end-user machine:
`scripts/fetch-ndi.ps1` (mirroring `scripts/fetch-ffmpeg.ps1`) downloads the
current NDI runtime at release time into `src-tauri/binaries/ndi/`, ships it via
`bundle.resources` → `bin/`, and is resolved by the same `binpaths`-style lookup
as ffmpeg. Because NDI's license requires the shipped SDK to be **less than 30
days old at product release**, the fetch script must run at each release and the
release process must fail/skip if the bundled DLL's build date is stale. The
About box adds NDI® attribution + `ndi.video` link. Verify end-to-end with
obs-ndi (OBS source takes `Wordlyte – <label>`).