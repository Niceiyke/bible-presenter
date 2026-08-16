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
4. **Phase 4 — Streamer surface** (~3 days +): WHIP via `RTCPeerConnection`
   (WebView2-native WebRTC); RTMP/SRT later on the existing `webrtc` crate if needed.
5. **Phase 5 — Multi-bus** (future): sources → PGM/AUX buses → outputs, turning
   `SceneComposition` zones into the first-class bus primitive.

Phase 1 is strictly additive and safe to land independently; everything after it
consumes the same model.