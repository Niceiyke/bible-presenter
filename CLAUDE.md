# CLAUDE.md

This file describes the current Wordlyte repository. Keep it updated when the application architecture, commands, windows, or persistence model changes.

## Commands

```bash
# Frontend development
npm run dev                 # Vite dev server on port 1420
npm run build               # tsc + vite build -> dist/
npm run preview             # Preview the production frontend build
npm run test                # Vitest (jsdom) unit/behavior tests

# Tauri development and packaging
npm run tauri dev           # Runs the Vite frontend and Tauri desktop app
npm run tauri build         # Production NSIS bundle

# Rust backend
cd src-tauri
cargo check                 # Fast compile check
cargo clippy                # Lints
cargo build                 # Debug build
cargo build --release       # Release build
```

Vitest (jsdom) covers the transactional `useItemActions` core (stage failure, live transitions, clear propagation, settings/props rollback, service persistence), the schedule undo/redo slice, and the output-window toggle failure path. Rust unit tests exist in selected command modules. Production-safety work should extend these frontend tests to stage/live/clear state and Tauri event synchronization.

The UI/UX roadmap is documented in `docs/UI_UX_MODERNIZATION_PLAN.md`.
The unified production-suite architecture and implementation roadmap is
documented in `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md`.
The plan to move the video pipeline out of the webview into a separate Rust
engine process (wgpu compositor + ffmpeg-next + NDI SDK) is documented in
`docs/RUST_VIDEO_ENGINE_PLAN.md`. While that plan is being implemented, do not
add new WebView2 media APIs (getUserMedia, VideoEncoder, MediaRecorder, canvas
capture) to the video path — route new video work through the engine contract
instead.

## Rust compositor (Phase B1)

The engine's compositor domain lives in `src-tauri/src/engine/compositor/`
and is a pure, unit-tested Rust mirror of `src/compositor/`. It is where the
wgpu renderer (Phase B2) and fixture-parity harness (Phase B3) build; the DOM
renderers stay the parity oracle until then.

- `frame.rs` — the `ProgramFrame` model: `ResolvedOutputSource` (tag `kind`,
  lowercase), `ResolvedBackground`, `LogoState` (camelCase, skips `None`),
  `AudioProgramDescriptor` (tag `kind`), `CanvasGeometry`, `ProgramOverlays`,
  `ProgramLayer` (tag `kind`, explicit lowercase renames incl. `lower_third`;
  large payloads boxed for clippy), `ThemeColors` (background/verseText/
  referenceText/waitingText — NOT the `store::ThemeColors` primary/secondary/
  accent/text shape) + `theme_colors()` table (dark/light/navy/maroon/forest/
  slate) + `dark_theme_colors()`.
- `lower_third.rs` — `LowerThirdTemplate`/`LowerThirdPayload` (camelCase
  serde), `default_lt_template()` (mirrors `DEFAULT_LT_TEMPLATE`),
  `normalize_lt_template`, `substitute_tokens` (chrono `%I:%M %p`, `%-m/%-d/%Y`),
  all `Lt*` resolved types, `resolve_lower_third` (ticker mode, name/title/label
  style slots, badge text, bg-image→transparent fallback, is-full-width
  geometry, entry/exit animation fallback).
- `resolver.rs` — `ResolverSnapshot` (live/staged/settings/props/lower_third/
  revision), `ProgramFrameInput` (config + snapshot + scenes + colors +
  timestamp + fps), `FrameMediaPaths { images, videos }`, `get_effective_bg`,
  `resolve_theme_colors`, `derive_logo_state`, `resolve_program_frame` (z-sorted
  zone layers, source resolution, blackout/blank, background/theme/height
  presentation overrides, overlay masks, `missing` structural problems, audio
  descriptor, waiting layer).
- `renderer.rs` — Phase B2: the wgpu 30 offscreen compositor
  (`Compositor::new(width, height)` + `render(&frame, &mut media)` +
  `read_pixels()`), restricted to DX12 on Windows (wgpu 30's Vulkan
  `request_device` crashes on some Intel iGPU drivers, observed UHD 620),
  lazy texture upload via an `Rc` image cache, `SolidUniform` padded to the
  WGSL 48-byte uniform struct size, cosmic-text 0.19 / glyphon 0.12 text,
and the `render_frame_to_pixels` helper + `MemoryMedia`/`MediaResolver` used
by the B3 fixture-parity harness. Text is queued during the layer pass
(`queue_text`/`draw_text_centered`) and flushed through ONE glyphon
`prepare()` per frame (`flush_text`) — glyphon's `prepare()` clears its vertex
batch on every call, so per-call preparation silently keeps only the last
run's glyphs; `draw_text_centered` measures real cosmic-text line widths to
word-wrap and center (the old character-count estimate pushed verses off the
left edge). Requires `windows =0.62.0` in
  `[target.'cfg(windows)'.dependencies]` to unify the gpu-allocator/wgpu-hal
  window-crate split that broke the DX12 build.

`BackgroundSetting` and its payload structs derive `PartialEq` (test-only
comparison). No new WebView2 media APIs were added to the video path.

## Stack

- React 19 and TypeScript.
- Vite 7.
- Tailwind CSS v4 through `@tailwindcss/vite` in `vite.config.ts`.
- Zustand 5 for shared frontend state.
- Framer Motion for transitions and reorder interactions.
- Lucide React for icons.
- Tauri 2 and Rust for the desktop shell, persistence, media operations, and display windows.
- SQLite through `rusqlite` for Bible, media, schedule, song, presentation, lower-third, props, and scene data.

## Frontend entry and shell

`src/main.tsx` mounts `I18nProvider`, the root `ErrorBoundary`, and `App`.

`src/App.tsx` is the operator-shell orchestrator. It mounts:

- `AppHeader` for output, logs, shortcuts, and backend status.
- `LeftNav` for workspace navigation.
- `ContentBrowser` for the active workspace.
- `BottomDrawer` for lower thirds and timers.
- `Cockpit` for staged/live previews and the service queue.
- `MusicPlayer`, toast notifications, recovery, slide editing, and logs.

The current content workspaces are:

- `BibleTab`: Bible versions, quick reference entry, chapter browsing, semantic search, recent items.
- `SongsTab`: user songs, hymn library, song import, editing, arrangements, and lyrics mode.
- `MediaTab`: image/video/audio library, camera view, metadata, fit modes, playback settings, bulk actions, missing-file relinking.
- `StudioTab`: custom presentation list, slide thumbnails, stage/live/service actions, and the slide editor entry point.
- `ScheduleTab`: service selection, service management, reorder, undo/redo, persistent/one-shot behavior.
- `LowerThirdTab`: nameplates, lyrics, free text, presets, templates, and live controls.
- `TimersTab`: countdown, count-up, clock, staging, live display, and stop/reset.
- `PropsTab`: persistent image and clock overlays.
- `ScenesTab`: capture, apply, and delete bundles of settings, props, and lower-third state.
- `SettingsTab`: Bible assets, output styling, themes, backgrounds, monitors, stage, and operator behavior.

## Windows

Window definitions are in `src-tauri/tauri.conf.json` and are created after `AppState` is managed in `src-tauri/src/main.rs`.

- `main`: operator window, 1200x800.
- `design`: configured Design Hub window, 1440x900, hidden by default.
- `studio`: configured Audio Studio window, 1440x900, hidden by default.

Since Phase C4, the `output` and `stage` windows are **not** Tauri webviews — they are winit windows owned by the `wordlyte-engine` sidecar process (`src-tauri/src/engine/windows.rs`), created and shown by the engine window host. `App.tsx` no longer renders output/stage branches and `src/windows/` is deleted; the console shows low-res MJPEG previews of both via `engine_invoke` (`useEnginePreview`). Any work involving `design` or `studio` must first verify whether those windows are intended to load the same operator app or need their own renderer branch.

Sidecar bundling: `wordlyte-engine.exe` ships as a bundle resource (`binaries/wordlyte-engine.exe` → resource dir, resolved by `main.rs` via `resource_dir()`). Because the engine is a `[[bin]]` of the same crate, tauri-build's build script would fail a fresh checkout (the resource does not exist until cargo build produces it). `scripts/copy-engine-binary.mjs` breaks the loop in two modes: `--bootstrap` (wired into `beforeBuildCommand`/`beforeDevCommand`) writes a 0-byte placeholder before cargo build, and the no-arg mode (`beforeBundleCommand`) overwrites it with the freshly built binary before bundling — failing loudly if the binary is missing. The CI Check workflow touches the same placeholder for bare `cargo check/clippy/test`.

Engine window rendering: the sidecar resolves the shared `ProgramFrame` for each window from its config + the `PresentationSnapshot` that the console pushes after every presentation mutation (`EngineCommand::SyncPresentation`, protocol v4, driven from `app_emit_sink` via `sync_engine_presentation` in `src-tauri/src/engine/presentation.rs`), and paints it with the wgpu compositor at the capture rate. The DOM renderers in `src/components/shared/Renderers.tsx` remain the parity oracle. Known C4 gaps: the engine stage window renders the live item only (the webview's Now Live/Up Next confidence view was not carried over), and `show_output_test_pattern` reveals the window but has no pattern listener.

## Output manager (Phase 1)

The output manager is a configurable output-surface abstraction: every output (projection window, stage window, a future overflow monitor, recorder, streamer) is an `OutputConfig` that subscribes to a program source and renders it. Outputs never mutate engine state — they only subscribe.

- Types: `src/types/output.ts` (`OutputConfig`, `OutputSource`, `OutputPresentation`, `OutputOverlays`, `OutputGeometry`, `OutputRecording`, `OutputStreaming`, `OutputState`, `OutputPhase`). Sources: `live` | `staged` | `scene` | `item` | `blank`. Presentation overrides (theme / `reference_output_height` / background / blanked) layer on top of broadcast settings; overlays mask gates props / lower-third / logo per output.
- Backend: `src-tauri/src/outputs.rs` (`OutputManager`, Arc-managed like `RemoteControl`, persisted to `outputs.json` under the app data dir with additive forward migration from `default_outputs()`). Registered on `AppState.outputs` in `src-tauri/src/state.rs` and initialized in `main.rs` before windows are built. `OutputConfig` carries a persisted `schema_version` (`OUTPUT_SCHEMA_VERSION = 1`, `#[serde(default)]` so pre-Phase-0 files load unchanged); `PresentationSnapshot` carries `PRESENTATION_SCHEMA_VERSION = 2` (added `previous` / `active_scene_id` / `updated_at` in the WP6 fix, so a reopened window hydrates the prior live item and the live scene). `OutputManager::new_with_issues` surfaces a malformed `outputs.json` as a startup issue instead of silently appearing default. See `docs/CONTRACT_INVENTORY.md` for the full command/event/persistence inventory and the schema-version rule.
- Commands: `src-tauri/src/commands/outputs.rs` — `outputs_list`, `outputs_states`, `outputs_update` (replace-all, idempotent), `outputs_set_visible` (show/hide a window output, or start/stop a recorder/streamer), `report_output_state` (recorder/streamer adapters push lifecycle transitions). Window visibility is unified through the single authoritative `set_output_visible` helper (`commands/outputs.rs`): the legacy `toggle_output_window`/`toggle_stage_window` commands (`commands/windows.rs`) and the Output Manager all route through it, so the window, the persisted `outputs.json`, the runtime `OutputState`, and the UI (which reads `outputStates` in `AppHeader`/`RemoteTab`) can never disagree. It toggles the bound window FIRST, then persists + swaps config (which re-seeds the runtime `OutputState`), then broadcasts `output-config-changed`/`output-state-changed`; external window close events are synced back in `main.rs`. Recorders/streamers persist through `outputs_update`; runtime progress reports via `report_output_state`.
- The Phase 4 output lifecycle (`OutputState`): every surface's runtime entry carries `phase` ∈ configured/starting/live/stopping/failed/stopped + `reason` + `started_at`. Windows derive their phase from visibility (`set_visible` re-seeds after the atomic persist); the recorder/streamer adapters report transitions through the `report_output_state` command, and `OutputManager::set_state` owns `started_at` (stamped on entering live, cleared on leaving). The adapters (`src/hooks/outputRuntime.ts` — `reportOutputState`/`setOutputVisible`; `useRecordingProvider.tsx`; `useStreamingProvider.tsx`) persist the operator intent FIRST via `outputs_set_visible` and only report a live phase after the write succeeds, so a failed persist can never diverge disk from runtime. Adapters never touch the presentation engine — a failed output can never change live program state.
- The Phase 5 source registry (`src/system/sourceRegistry.ts` + `src/hooks/useCameraSource.ts` + `src/hooks/useSharedLocalCameraStream.ts`): a per-device `SourceState` (`stream` + `status` ∈ idle/opening/connected/error/reconnecting/disconnected + `kind` local/phone/native/ndi + `errorKind`) unified across local webcams, phone cameras, and future capture devices. Local cameras are opened per device per capture quality via `getUserMedia` (registry key `${deviceId}@WxH@fps`; `CAPTURE_1080P` for broadcast/compositor consumers, `PREVIEW_720P` for preview surfaces — so one camera runs 1080p for the program and 720p for cockpit/stage/camera-tab previews simultaneously), ref-counted across every consumer (`acquireSource`/`releaseSource`), and auto-reconnect once on device loss; phone sources are *registered* by the WebRTC host (`setPhoneSource`/`removePhoneSource` in `usePhoneCameraHost.tsx`, status from `phoneStatusFromConnection`) so signaling stays separate from acquisition. Synthetic `phone-camera-`/`native:`/`ndi:` ids are never sent to `getUserMedia` (`resolveSourceKind`). `useCameraSource` is the unified consumer hook (defaults to `CAPTURE_1080P`); `useSourceStatus` is the non-acquiring picker variant; `useSharedLocalCameraStream` defaults to `PREVIEW_720P` for previews and `useSharedLocalCameraStreams` to `CAPTURE_1080P` for the compositor. `ZoneCamera` in `CompositionRenderer` shares the registry stream (no per-zone `getUserMedia`) and `ZoneCamera`/`CameraFeed` render safe fallbacks. `SourcePicker` (`src/components/sources/SourcePicker.tsx`) lists local + phone sources with live status (used by the SceneBuilder camera source).
- The Phase 6 shared audio graph (`src/system/audioGraph.ts` + `src/hooks/useAudioGraphProvider.tsx`) was **removed in Phase D** — the webview no longer captures program audio into the recorder/streamer surfaces. Audio capture moves into the engine (one shared input, cloned per mux session) in a later phase; until then `rtmp_start` rejects `with_audio: true` with a forward-looking message and the operator surfaces show no audio controls.
- The Phase 7 shared encoder / packet bus (`src/system/programEncoder.ts` + `useRtmpEncoder`/`useNdiSender`) was **removed in Phase D** — the engine's shared H.264 ffmpeg encoder (raw RGBA in, Annex-B out) replaces the webview WebCodecs encoder, and mux-only ffmpeg sessions replace the per-destination packet bus. RTMP destinations no longer depend on WebCodecs; the System diagnostics H.264 probe remains only as a hardware report, and the ambient WebCodecs types in `src/types/webcodecs.d.ts` exist solely for that probe.
- The Phase 8 operator workflow: three primary operator modes — `operatorMode` ∈ `prepare`/`service`/`system` in `appSlice` (default `service`, `activeTab` default `schedule`). `LeftNav` has a mode switcher and shows only the current mode's groups (Prepare = Content + Design; Service = Service Plan + Live Tools; System = recording/streaming/diagnostics/remote/settings). The Cockpit clarifies labels (`Staged · Preview`, `On Air · Program → Output`), shows an output readiness indicator (`Output On/Off`), and adds an emergency `RESTORE` button (undoes a clear-all). `FirstRunWizard` (`src/components/FirstRunWizard.tsx`) is a one-time onboarding modal that creates a service and opens the Service Plan.
- Events: `output-config-changed` (full list, replace-all semantics) and `output-state-changed` (per-output runtime status). Typed in `src/hooks/useTauriEvent.ts`.
- Frontend: `outputSlice` (`src/store/slices/outputSlice.ts`) holds `outputs` + `outputStates`, hydrated and kept in sync by `useAppInitialization.ts`. `OutputWindow`/`StageWindow` (separate webviews, local state) hydrate via `outputs_list` and listen to `output-config-changed`, applying `presentation`/`overlays` overrides. Default configs have empty overrides and full overlay masks, so behavior is identical until the operator customizes an output.
- The Phase 2 program-feed canvas compositor (`src/components/outputs/canvasProgramFeed.ts` draw helpers, `useCanvasCapture` hook, `ProgramFeedCanvas`/`ProgramFeedPreview` components) rasterizes the same program the DOM renderers paint and exposes `captureStream()`. It is a verification surface (PGM toggle in the Cockpit On-Air preview) and the preview shown in the recorder/streamer workspaces. The DOM path in `OutputWindow`/`StageWindow` remains authoritative; recording/streaming capture happens in the engine (Phase D), not from this canvas.
- The Phase 3 program-frame model (`src/compositor/ProgramFrame.ts` types + `src/compositor/ProgramFrameResolver.ts`): every output surface resolves the SAME `ProgramFrame` from its `OutputConfig` + the authoritative presentation snapshot via the pure `resolveProgramFrame` — output source (`live`/`staged`/`item`/`scene`/`blank`), presentation overrides (theme / `reference_output_height` / `background` / `blanked`), effective background, overlay masks (props / lower_third / logo), blackout, a declarative ordered `layers` list, structural `missing` problems, and an audio descriptor. `getEffectiveBg` moved into the resolver (re-exported from `canvasProgramFeed.ts` for back-compat). `drawProgramFrame(ctx, frame, res)` now consumes the resolved `ProgramFrame`; missing media (paths in `CanvasResources.failedPaths`) paints the safe `drawMissingPanel` and `ProgramFeedCanvas` reports them via `onMissingMedia`. `ProgramFeedPreview` resolves through `resolveProgramFrame` (live source, all overlays unmasked) and patches `appDataDir` onto the frame. The DOM outputs (`OutputWindow`/`StageWindow`) also resolve through `resolveProgramFrame`: they consume the frame's resolved colors, effective background (`frame.background.setting`), blackout, masked overlays (`frame.overlays` — the props/LT/logo payloads are already mask-applied), and resolved source (`frame.source.item`, so a `blank` source projects nothing and a non-live source projects its item); the DOM renderers remain authoritative for rich text/animations. The shared lower-third model (`src/compositor/LowerThirdResolver.ts`): `resolveLowerThird(payload)` is the single normalized descriptor — content→style slots, background, accent/border/shadow/outline tokens, geometry, animation, scroll — consumed by BOTH the canvas `drawLowerThird` and the DOM `LowerThirdOverlay`, so the two render paths share one resolution (token substitution `{time}`/`{date}` lives here).
- The Phase D recorder surface (`src/hooks/useRecordingProvider.tsx` + `src/components/RecordingsTab.tsx`, backend `src-tauri/src/commands/recordings.rs`) records the program feed in the **engine**: a mux-only ffmpeg (`-c copy`, MP4) writes the shared encoder's H.264 to `{app_data_dir}/recordings/`. Commands: `recordings_list`, `recording_start` (`file_name` + `fps`), `recording_stop` (`file_name`), `recording_status` (engine session table, mirrors `rtmp_status`), `recording_delete`, `recordings_open_folder`. The `RecordingProvider` (mounted in `App.tsx`) is the app-scoped owner: it persists the operator intent FIRST via `outputs_set_visible("record-main", true)`, starts/stops the engine session, and reconciles the surface phase from the `recording_status` poll (`useEngineTransport` polls while the tab is open OR while recording, so an unexpected engine-side stop surfaces as `failed`). The Recordings workspace (System nav) previews the compositor (`ProgramFeedPreview`), shows REC/STOP transport + elapsed timer, capture resolution/fps, and saved files. There is no Abort path — `recording_stop` always finalizes the MP4.
- The Phase D streamer surface (WHIP moved to the engine in a later phase — `useStreamer.ts` was removed; RTMP is the working transport). Endpoint URL + bearer token persist through `outputs_update` into the `stream-main` output's `streaming` field (WHIP cards stay configurable but their Go Live is blocked with a forward-looking reason). The Streaming workspace (System nav) previews the compositor and shows the hub controls. See `docs/OUTPUT_MANAGER_DESIGN.md`.
- The Phase D RTMP ingest (backend `src-tauri/src/commands/rtmp.rs`) proxies the engine's shared H.264 encoder + mux-only ffmpeg fan-out: commands `rtmp_start` (`session_id`/`server_url`/`stream_key`/`with_audio`/`fps`, rejects `with_audio: true` — shared audio moves to the engine in a later phase), `rtmp_stop`, `rtmp_status` (engine session table: `id`/`active`/`url`/`fps`/`queued`/`sent`/`dropped` bytes; never throws — an unreachable sidecar reports no sessions). The frontend `StreamingProvider` drives sessions per destination and derives per-card status from the poll. ffmpeg resolves bundled-first via `src-tauri/src/binpaths.rs` (`{resource_dir}/bin/ffmpeg.exe` + `ffprobe.exe`, shipped as `bundle.resources`; fetch once with `scripts/fetch-ffmpeg.ps1` — pinned BtbN **GPL** build, not committed; GPL is required because the shared encoder uses libx264, and `binaries/ffmpeg-COPYING.GPLv2.txt` ships with it) with a PATH fallback, and errors cleanly when missing.
- The Phase 6.2 multi-platform Streaming Hub (`src/hooks/useStreamingProvider.tsx` + `src/components/StreamerTab.tsx` + `src/components/streaming/`): the streamer streams the single compositor feed to any number of destinations at once. The hub pipeline — destination set, master transport, per-destination engine sessions — is owned by the app-scoped `StreamingProvider` (mounted in `App.tsx` beside `RecordingProvider`), so a broadcast survives navigating away from the workspace; `StreamerTab` is a thin view that previews the provider's live compositor via `ProgramFeedPreview` and drives its controls. Each destination is a platform preset (YouTube / Facebook Live / Twitch / Custom RTMP / Custom WHIP in `presets.ts` — the ingest server is pre-filled, the operator pastes only their stream key) rendered as a `DestinationCard`; the provider owns every destination's engine session (`rtmp_start`/`rtmp_stop` by destination id), so the card can unmount without stopping an active stream. Master **Go Live All** / **Stop All** control every enabled destination; per-card status/bitrate/bytes are derived from the `rtmp_status` poll (a previously-live destination whose session disappears surfaces as `error`). Destinations persist as `stream_destinations` (`StreamDestination` in `outputs.rs` + TS) on the `stream-main` output config, seeded from the legacy `streaming` field when present. There is no webview video encoder and no `MediaStreamTrackProcessor` fan-out — the engine encodes once and muxes per destination.
- The Phase 5 multi-bus / zone-bus primitives: `SceneComposition` zones become the first-class bus primitive. A `SceneZone` may carry `source: SceneZoneSource` (static `item`, or pinned to `verse`/`camera`/`timer`/`song`/`media`/`slide`). When a scene composition is the live item and content of a pinned class is taken live, the backend patches the matching zone(s) in place (`patch_scene_zones` in `src-tauri/src/engine/presentation.rs`, wired into `op_commit_staged`/`op_go_live_item`) instead of replacing the whole scene — so a camera+Bible scene's verse zone advances as the operator steps through Scripture, and a timer zone follows the live countdown. Static zones (no `source`) keep legacy replace-the-scene behavior; a scene applied wholesale still replaces. The TS union in `src/types/scene.ts` mirrors the serde-tagged Rust `SceneZoneSource` in `src-tauri/src/store/media_schedule.rs`; the SceneBuilder inspector exposes the "Follows live content" selector. Scene-aware stepping: `compositionKind` in `src/items/registry.tsx` delegates `nav`/`nextLive` to the first pinned zone whose content kind supports navigation, so the Cockpit Next button and keyboard Arrow/Home/End advance the live scene's verse/song without leaving the operator console. The compositor, DOM outputs, recorder, and streamer all pick up the patched zones automatically since they render `zone.item`.
- The Phase 7 system diagnostics (`src/system/` + `src/components/SystemTab.tsx`, backend `src-tauri/src/commands/system.rs` via the `sysinfo` crate): a readiness/check battery (ffmpeg available (bundled or PATH), WebCodecs H.264 probe, WebRTC, audio input, camera, display count via `get_available_monitors`, CPU/RAM/disk) runs once in `SystemDiagnosticsProvider` (mounted in `App.tsx`), derives a pure capability report (`src/system/capabilities.ts` — `rtmpAvailable`, `whipAvailable`, `audioAvailable`, `cameraAvailable`, a streaming-capacity tier, and human-readable reasons) and gates services so disabled ones stay visible but can't start. Since Phase D, RTMP availability is ffmpeg-only (`rtmpAvailable = ffmpegAvailable`) — the engine's ffmpeg encodes, so WebCodecs support no longer gates streaming; the H.264 probe remains a hardware report only. `StreamerTab` disables RTMP Go Live when ffmpeg is missing and blocks WHIP/NDI Go Live with a forward-looking reason. The System → Diagnostics workspace shows the checklist + hardware summary + live performance panel; metrics poll (`system_metrics`) only while that panel is open, and compositor capture FPS comes from a frame counter in `useCanvasCapture` (`src/system/captureMetrics.ts`).
- The Phase 8 NDI scaffold (`src-tauri/src/commands/ndi.rs` + the `ndi` cargo feature, NDI preset/`ndi` mode in `streaming/`, `ndiAvailable` capability): lets the hub publish the program as an NDI|HX source on the LAN (OBS via obs-ndi, vMix, ProPresenter) and is **SDK-gated on the build machine** — the real sender needs the NDI SDK (`https://ndi.video/for-developers/ndi-sdk/download/`, EULA) installed to `C:\Program Files\NDI\NDI 6 SDK` (or `NDI_SDK_DIR`) plus `grafton-ndi` + LLVM/clang (bindgen). End users download nothing: `Processing.NDI.Lib.x64.dll` ships inside the installer (fetched at release time by a `fetch-ndi.ps1`-style script, <30 days old per the NDI license). Until the SDK is present `ndi_status` reports unsupported and NDI cards stay gated. The real pipeline (H.264 Annex-B → SDK send + avsync, sessions keyed by `session_id`) lands in the `#[cfg(feature = "ndi")]` branches once `grafton-ndi` + LLVM/clang (bindgen) are available; NDI audio and NDI **input** (discovery → receive → `VideoDecoder` + `VideoTrackGenerator` camera source) are follow-ups. The webview `useNdiSender` WebCodecs client was removed in Phase D — NDI send will be an engine session like RTMP, so NDI cards stay gated until then. Full design: `docs/OUTPUT_MANAGER_DESIGN.md` §9.

Do not apply operator-console color tokens directly to projected output. Audience themes are persisted separately in `src/types/settings.ts`.

## State management

`src/store/index.ts` composes Zustand slices from `src/store/slices/`:

- `appSlice`: active tab, settings, initialization, logs, output visibility, studio data, scenes, errors, and general UI state.
- `liveSlice`: live item, staged item, previous item, next verse, recents, history, and blackout state.
- `bibleSlice`: Bible versions, books, chapters, verses, selection, and search.
- `mediaSlice`: media library, filters, metadata, playback, and media UI state.
- `lowerThirdSlice`: lower-third mode, template, visibility, song/lyrics state, presets, and current payload.
- `serviceSlice`: service entries, service history, active service, service manager, and props.
- `cameraSlice`: camera devices and selected camera state.
- `outputSlice`: configurable output surfaces (`outputs`) and their runtime states (`outputStates`).

When adding shared state, prefer the relevant slice instead of adding unrelated local state to `App.tsx`. Avoid duplicating authoritative live or service state in multiple components.

## Initialization and events

`src/hooks/useAppInitialization.ts`:

- Resolves the current Tauri window label.
- Waits for backend startup readiness for the main window.
- Hydrates Bible versions, media, presentations, schedules, songs, hymns, lower-third templates, settings, props, services, current lower third, scenes, recents, and schedule history.
- Registers synchronization listeners.

Typed event names and payloads are defined in `src/hooks/useTauriEvent.ts`.

Important events include:

- `live-item-update`: `{ detected_item, revision }` — live item or null.
- `item-staged`: `{ item, revision }` — staged item or null.
- `settings-changed`: `{ settings, revision }` — presentation settings.
- `lower-third-update`: `{ lower_third, revision }` — lower-third payload
  (`{ data, template }`) or null.
- `props-update`: `{ props, revision }` — persistent props.
- `media-control` and `media-state`: media transport commands and feedback.
- `songs-sync`, `studio-sync`, and `studio-slides-sync`: content synchronization.
- `system-log` and `operator-warning`: backend/operator diagnostics.

The five presentation events are revision-tagged (one logical backend mutation
bumps a single revision and wraps every affected event with it — equal applies).
All production windows route them through the pure `PresentationSync` guard
(`src/system/presentationSync.ts`): buffering until the `presentation_snapshot`
is applied, replaying only at-or-newer events, and dropping stale broadcasts so
an older event can never overwrite newer live/staged/settings/lower-third/props
state. `Engine::rebroadcast` (`engine/presentation.rs`, used by
`set_output_visible`) re-emits the current state at the current revision without
bumping so a freshly-revealed window hydrates safely.

Any change to live, staged, clear, settings, lower-third, props, or service behavior must verify all windows and all listeners, including null/clear payloads.

## Live transition flow

The normal operator flow is:

```text
Content workspace
  -> stageItem(item)
  -> Tauri stage_item
  -> stagedItem / item-staged event
  -> goLive()
  -> Tauri commit_staged
  -> liveItem / live-item-update event
  -> output and stage windows render the authoritative state
```

`sendLive(item)` combines staging and committing. It must never commit if staging failed. Keep this behavior transactional when changing `src/hooks/useItemActions.ts`.

`clearAll()` affects live content, staged content, props, and lower thirds. Treat it as a production-destructive action and preserve failure recovery.

## Rust backend

Rust modules are in `src-tauri/src/`:

- `engine/presentation.rs` (the broadcast engine): every presentation mutation — stage, commit, go-live, clear, settings, blackout, logo, lower third, timer, props, apply-scene — as `Engine` methods (`op_stage`, `op_commit_staged`, `op_send_live`, `op_go_live_item`, `op_clear_all`, `op_set_blackout`, `op_save_settings`, `op_set_logo`, `op_show_lower_third`, `op_hide_lower_third`, `op_update_timer`, `op_toggle_timer`, `op_set_props`, `op_apply_scene`). Contract: one lock acquisition, exactly one revision bump, one event set per logical mutation; every mutation returns `MutationResult` (`snapshot` + `committed` + `scene`). Persist-first ops are transactional with compensation. Scene-zone bus primitives (`zone_source_for`, `patch_scene_zones`) and `PRESENTATION_SCHEMA_VERSION`/`PresentationSnapshot`/`snapshot` live here; `op_get_props` is a free function; `app_emit_sink(&AppHandle)` builds the production window-event sink (tests inject an `EventRecorder`). No tauri runtime handle is needed in engine tests. `Engine<'a, B>` is generic over `EngineBackend` (`engine/backend.rs`): the seam exposing `presentation()` + persistence (`save_settings`/`load_settings`/`save_props`/`load_props`/`list_scenes`) + `publish_remote` + `app_data_dir` — implemented by `AppState` today and by the standalone engine process next (Phase A2 of `docs/RUST_VIDEO_ENGINE_PLAN.md`), so the exact same ops run in both hosts. The wire contract for that process is `engine/ipc.rs` (`ENGINE_PROTOCOL_VERSION`, `EngineCommand`/`EngineEvent`/`EngineRequest`/`EngineResponse`/`EngineEventFrame`, `#[serde(other)] Unknown` tolerance), mirrored in `src/types/engine.ts`. Phase A2 adds the sidecar pieces: `engine/runtime.rs` (`EngineRuntime` implements `EngineBackend` with its own `PresentationState` + in-memory store + buffered `EngineEventFrame`s; `dispatch` maps `EngineCommand`→`Engine::op_*` and returns the response plus the events drained in order), `engine/client.rs` (`EngineClient` spawns/teardowns the `wordlyte-engine` sidecar, correlates responses by id, relays events with each reply; `Clone` shares one channel — dropping a clone never stops the sidecar, teardown is the explicit `shutdown()` in `main.rs`'s `RunEvent::Exit` plus stdin-EOF self-exit on console death; stored as `AppState.engine: Arc<Mutex<Option<EngineClient>>>` and spawned from `main.rs` beside the console exe — the console's display commands still run locally until the Phase A command rewiring), and the `wordlyte-engine` bin (`src/engine_main.rs`, newline-delimited JSON-RPC over stdio: reads `EngineRequest` lines, writes `EngineEventFrame`s then the `EngineResponse` line). `engine_status` (commands/misc.rs) reports sidecar readiness + protocol version.
- `engine/windows.rs` (Phase C): the engine-owned winit window host. `spawn()` runs the winit event loop on a background thread (`EventLoopBuilderExtWindows::with_any_thread`, required off the main thread) driven by `WindowCommand`s over the `EventLoopProxy`; each `HostedWindow` owns a wgpu surface compositor (`Compositor::new_surface`) and a `DiskMediaResolver` (relative paths resolve against `{app_data_dir}/media/`, mirroring `resolvePath` in `src/utils/index.ts`; absolute pass through; carries the shared `MediaFrameHub` so video layers decode once), rendering the `SharedFrame` the engine publishes per label at the capture rate — `draw()` calls `hub.sync(collect_video_refs(&frame))` before presenting so referenced videos spawn decoders and unreferenced ones sweep out. Monitor enumeration + preferred-monitor centering (`place_on_preferred_monitor`), `MonitorInfo`/`WindowStyle` (serde, mirrored in TS). After each render the host downscales to 480-wide and JPEG-encodes the frame, pushing it through a `PreviewSink`; the runtime wraps that as base64 `EngineEvent::PreviewFrame` (protocol v3) drained with the next polled command. The console polls `engine_invoke` (`commands/misc.rs`, the first live bridge over the engine IPC) with a cheap `ping` in `useEnginePreview` (`src/hooks/useEnginePreview.ts`) and renders the output/stage frames in `EnginePreviewPanel` (`src/components/outputs/EnginePreviewPanel.tsx`).
- `engine/compositor/media.rs` (Phase H): in-engine video playback. One ffmpeg subprocess per playing asset emits rawvideo RGBA on stdout (`-map 0:v:0 -an -sn -dn -vf setpts=PTS/<rate>,scale=W:H -pix_fmt rgba -f rawvideo -`, capped at 1920×1080, never upscaled); ffprobe resolves width/height/fps first. `MediaFrameHub` is the registry keyed by the RAW persisted media path (only `default_spawner(app_data_dir, ffmpeg, ffprobe)` resolves relative → `{app_data_dir}/media/`): `sync(refs)` spawns/sweeps decoders (3s linger, 5s retry tombstones), `latest(path)` returns the newest frame, `control(path, MediaAction)` pauses (stop reading stdout — pipe backpressure stalls ffmpeg), resumes, or seeks (kill/restart with `-ss`, keeping the old slot so the last frame freezes across the gap). Decode threads pace publication at wall-clock `1/(fps × rate)`; non-looping assets freeze on their last frame at end; failed decoders clear the slot (renderers paint the missing-media panel) and emit `DecoderEvent::Ended/Failed` on per-decoder channels that `poll_events()` drains into `EngineEvent::MediaEnded/MediaFailed`. The renderer's `MediaResolver::load_video_frame` default returns None; `Compositor.video_cache` re-uploads only when the frame buffer's Arc pointer changes. Sync happens ONLY from render paths (window host draw + transport capture tick), never from runtime dispatch. Audio is explicitly out until the engine audio graph lands.
- `state.rs`: `AppState`, `PresentationState`, live/staged/settings/lower-third/props state.
- `store/mod.rs`: Bible store and shared data types.
- `store/data_db.rs`: SQLite data database setup and schema helpers.
- `store/media_schedule.rs`: media, schedules, services, songs, presentations, settings, props, scenes, and related persistence.
- `commands/bible.rs`: Bible lookup, versions, search, chapter/verse retrieval, and verse splitting.
- `commands/media.rs`: media import, metadata, playback, relinking, deletion, bulk operations, and existence checks.
- `commands/schedule.rs`: service schedules, recovery, and service persistence.
- `commands/display.rs`: thin adapter over the engine — `stage_item`, `commit_staged`, `go_live`, `send_live_item`, `go_live_item`, `clear_live`, `clear_staged`, `clear_all`, `presentation_snapshot` (via `engine::snapshot`), `update_timer`, `save_settings`. Legacy command names/return shapes are preserved.
- `commands/studio_pres.rs`: custom presentations and slide templates.
- `commands/songs.rs`: songs and hymn-related persistence.
- `commands/lower_third.rs`: lower-third state, templates, and presets. `show_lower_third`/`hide_lower_third`/`show_lt_preset` delegate to the engine.
- `commands/props.rs`: `get_props` (engine `op_get_props`, lazy load) and `set_props` (engine `op_set_props`).
- `commands/scenes.rs`: scene capture, persistence, and application. `apply_scene` delegates to engine `op_apply_scene` (one logical transaction); `check_scene_cap`/`scene_save_allowed` stay here.
- `commands/system.rs`: system diagnostics (`system_info`, `system_metrics`) via `sysinfo`.
- `commands/ndi.rs`: NDI status/send stubs (`ndi_status`, `ndi_start`, `ndi_send`, `ndi_stop`) — SDK-gated behind the `ndi` cargo feature.
- `commands/windows.rs`: output, stage, studio/design window toggles and monitor handling.
- `commands/assets.rs`: Bible data download and asset paths.
- `commands/license.rs`: license status, activation, refresh, and deactivation. State lives in `src/license.rs` (`LicenseManager`, Arc-managed on `AppState.license`, persisted to `license.json` under the app data dir) and validation runs against a Cloudflare Worker in `workers/license/` (deploy instructions + admin API in its README; the endpoint host is set in `default_server_url()` and overridable via `WORDLYTE_LICENSE_URL`).

The startup path searches for `bible_data/wordlyte_bible.db`. If it is unavailable, the app creates an empty placeholder Bible store and Settings can download Bible assets. Bundled hymn data is `bible_data/hymns.json`.

`DataDb::open` only quarantines (renames aside with timestamped `corrupt-*` sidecars) and recreates the data database on *demonstrable* corruption (`SQLITE_CORRUPT`/`SQLITE_NOTADB`). Permission, transient-lock, IO, or migration errors are surfaced (`OpenError::Other`), never quarantined. If the data database cannot be opened, `main.rs` falls back to an in-memory store and records a `startup_issues` entry (on `AppState` and `MediaScheduleStore`) that `get_startup_status` returns to the operator banner — a valid installation is never silently hidden behind an empty workspace.

Persistence hardening (Phase 9): the schema migration (`PRAGMA user_version`, data DB = 1) runs inside a **single transaction**, so a failed migration rolls back; before any schema change `DataDb` copies the DB to a timestamped `.pre-migrate-<ts>.bak` sibling (automatic backup, surfaced to the operator as a startup issue). `DataDb::with_tx(f)` is the all-or-nothing transaction helper used by the bulk media operations (`delete_media_bulk`, `bulk_update_media` → `bulk_set_media_metadata`). `DataDb::validate` runs a sanity query after open and `MediaScheduleStore::new` records a startup issue if it fails; `validate_content_records` reports malformed individual records so a broken row is never silently dropped. `outputs.json` is written temp+rename (atomic). The Bible DB can be **reloaded without a restart**: `BibleStore::reload` swaps the shared connection + caches (books/versions/active_version/db_path are `Mutex`-wrapped) and re-queues the background FTS rebuild; `download_bible_db_cmd` calls it on success.

User data is stored under the Tauri app-local data directory. The backend logs to the app data logs directory, and panic logs use the `io.wordlyte.app` local-app path.

## License / beta gating

Wordlyte enforces a per-church, machine-bound, expiring license so beta testers can't use the app forever or copy it to other systems.

- **Machine fingerprint**: `machine_uid::get()` (Windows `MachineGuid`, `/etc/machine-id`, macOS UUID) hashed to a 64-hex id and sent to the license server (no PII). The persisted `license.json` record is bound to that id — copying the app data dir or install folder to another PC fails the local machine check (`invalid`) and re-activation on a new PC hits the server-side device-slot cap.
- **Expiry + offline grace**: the Worker's server time is authoritative for `expires_at`. The app validates on launch and on demand (`license_refresh`); when the server is unreachable it keeps working through an offline grace window (`OFFLINE_GRACE_DAYS` in `src-tauri/src/license.rs` — 14 days Free, 30 days paid), then locks until one online check. Clock rollback is caught with a monotonic `last_seen_at` anchor (`CLOCK_TOLERANCE_SECS`).
- **Tiers (free / pro / premium)**: every key carries a `tier`, stored server-side at issue time and clamped per tier (`workers/license/src/index.js` — free=1 machine, pro=3, premium=50). `evaluate_status` in `license.rs` degrades a lapsed *paid* key to `Free` (status stays `Active`) instead of locking, so the church keeps projecting with Free features until renewal; Free keys lock outright. The effective tier rides `LicenseStatusInfo.tier` → `LicenseInfo.tier` (`src/types/license.ts`). The single frontend capability map is `src/system/tiers.ts` (`TIER_CAPABILITIES` + `tierCapabilities()`): free = 1 Bible version, 1 on-air window, watermark on output, 3 scenes, preset-only lower-third templates, no remote/recording/streaming/NDI; pro = + remote, recording, streaming (1 destination), NDI, custom templates, no watermark, 2 windows; premium = unlimited windows/destinations/machines + shared audio input. Enforcement: backend `license::ensure_active_tier` guards `remote_enable` and the 1-window output cap in `outputs_set_visible`; `check_scene_cap` in `commands/scenes.rs` caps 3 scenes on Free; the rest are frontend gates (watermark in `OutputWindow.tsx`, Bible version caps in `BibleVersionsSection`/`BibleTab`/`BiblePickerModal`, REC/streamer/NDI/shared-audio/template gates). Change a key's tier with `scripts/extend.mjs <key> 0 <tier>` or the admin UI's Tier button.
- **Enforcement**: the operator shell gates on `license_status` — `App.tsx` shows `LicenseGate` (activation / blocked screens) before the console renders when the status is not `active`, and `OfflineLicenseBanner` when offline within grace. Defense in depth: `license::ensure_allowed` is called at the top of the broadcast commands (`stage_item`, `commit_staged`, `go_live`, `go_live_item`, `toggle_output_window`, `toggle_stage_window`, `show_output_test_pattern`, `outputs_set_visible` when revealing, `remote_enable`). Content prep (Bibles, media, songs, settings) stays available.
- **Events**: `license-updated` carries `LicenseInfo` (`src/types/license.ts`) after any status/activation/refresh change; hydrated on init via `license_status`. Settings → License (`src/components/settings/sections/LicenseSection.tsx`) shows status, expiry, device slots, the machine fingerprint, and refresh/deactivate actions.
- **Admin**: issue keys (`scripts/issue.mjs` in `workers/license/`, optional `tier` arg), revoke instantly server-side, extend/upgrade (`extend.mjs <key> <days> [tier]`), list keys, or the `/admin` web UI (tier selector, Tier/Extend/Revoke per key). This is a speed-bump control (a determined user could patch the binary); it stops casual copying and gives a server-side kill switch.
- **Hardening (signed token + DPAPI)**: every `/validate` response is signed with ECDSA P-256 (SHA-256) by the Worker using the `LICENSE_SIGNING_KEY` secret; the app embeds the matching public key in `src/license_crypto.rs` (`LICENSE_PUB_KEY_POINT_HEX`) and re-verifies the canonical claims (`license_key`/`expires_at`/`issued_at`/`church_name`/`email`/`tier`/`max_machines`) on `activate`/`refresh` and on every `load`. A signed (version ≥ 2) record whose signature fails — e.g. a hand-edited `tier`/`expires_at` — is treated as NO license (`Unactivated`), never an upgrade. The persisted `license.json` is encrypted at rest with Windows DPAPI (`protect_at_rest`/`unprotect_at_rest`); legacy plaintext records (starting with `{`) still load and are re-signed on the next online refresh. Keep the keypair halves in sync when rotated.

## Remote control subsystem

The Remote Control feature lets a phone/tablet on the same LAN aid the operator. The Tauri backend runs an axum server (a WebSocket endpoint plus static files) and the browser bundle is a separate Vite multi-page entry.

- Rust: `src-tauri/src/remote/` (`mod.rs`, `server.rs`, `tls.rs`, `auth.rs`, `sessions.rs`, `hub.rs`, `protocol.rs`, `commands.rs`, `snapshot.rs`, `assets.rs`). The server reuses the last bound local port (persisted in `remote_port.txt` under the app data dir, falling back to a random port if it is taken), keeps authoritative state in `state.remote` (`RemoteControl` in `mod.rs`), and never duplicates live/staged/settings state. It serves **HTTPS** with a self-signed cert for the operator's LAN IP (generated on first use, persisted in `remote_tls.json`) — `getUserMedia` on the phone only works in a secure context, so the remote page must be TLS for the phone camera to stream; the WebSocket upgrades to `wss` automatically. Phones accept the self-signed certificate warning once per IP.
- Wire protocol: `src-tauri/src/remote/protocol.rs` defines `RemoteCommand`/`RemoteEvent`/`RemoteSnapshot`; the frontend mirrors these in `src/types/remote.ts` (`REMOTE_PROTOCOL_VERSION` must match `protocol.rs`). Command/event names are typed literally (e.g. `bible.stage`, `lower_third.show`) and route through the `dispatch` in `remote/commands.rs`. Phase 10: `RemoteCommandType` tolerates unknown types via `#[serde(other)] Unknown` (clear "unsupported" response to a newer client); `RemoteSnapshot.capabilities` carries `REMOTE_CAPABILITIES` for feature negotiation; `permissions.changed` is pushed to a device immediately when its role/permissions change (`publish_permissions_changed`); and expensive `bible.search`/`songs.search` are rate-limited per device via `RemoteControl::allow_read_query`.
- Control model: a single exclusive controller lease (`ControllerLease` in `sessions.rs`). New devices pair as read-only (`viewer`); the operator grants content permissions (Scripture / Songs / Camera / Lower ⅓ / Presentation) from Settings → Remote Control, either via role presets (`viewer` none, `operator`/`admin` all) or per-device toggles. `remote_set_role` resets a device's permissions to its role preset; `remote_set_permissions` overrides individual flags. Every mutating command maps to one permission in `required_permission` (`commands.rs`) and is enforced server-side by reading live permissions from the token store on each dispatch; `remote.request_control` additionally requires at least one permission. The remote snapshot carries the device's `permissions` so the phone UI hides controls it cannot use. Mutating commands are gated on an operator role, an up-to-date `expected_revision`, and the lease. `RemoteRequestControl` is exempt from the lease gate because it acquires the lease. WebRTC signaling relays (`camera.offer`/`camera.answer`/`camera.ice`) are deliberately NOT mutating — they only forward SDP/ICE and would otherwise fail when a snapshot goes stale or ICE bursts trip the mutation rate limiter. Pairing uses a code (30-minute TTL, generous per-IP rate budget) whose SHA-256 hash is stored; device tokens are persisted under the app data dir (`remote_devices.json`).
- Phone camera relay: the phone opens **two** RTCPeerConnections and tags every `camera.offer`/`camera.ice` with a `target` (`"operator"` = the main operator window, `"output"` = the projection window; default `"operator"`). The backend relays the SDP/ICE over `phone-camera-offer`/`phone-camera-ice` Tauri events (carrying `target`) to all windows, and answers route back via `phone_camera_answer`/`phone_camera_ice` (both take a `target`). The main window hosts the `"operator"` answering peer in `src/hooks/usePhoneCameraHost.tsx` (mounted by `PhoneCameraProvider` in `App.tsx`) so the phone never disconnects while the output window is closed and the operator can preview the feed; `OutputWindow.tsx` hosts the `"output"` peer for projection. MediaStreams cannot cross Tauri windows, hence one peer per window. Operator previews render the relayed stream in `PreviewCard.tsx` and `CameraTab.tsx` (a `phone-camera-*` device id is synthetic and must never go to `getUserMedia`). The projection `"output"` peer is best-effort: only the `"operator"` peer failure tears the camera down on the phone (`CameraPanel.tsx`). `camera.start` is **register-only** — it never stages; the connected phone cameras appear in the operator's Camera tab (populated by `list_phone_cameras` + the `phone-cameras-changed` Tauri event, emitted on start/stop/device-disconnect), and the operator selects the feed there to stage/Go Live, so multiple phones never fight over the staged slot.
- Tauri commands: `remote_enable`, `remote_disable`, `remote_status`, `remote_regenerate_pairing`, `remote_revoke_device`, `remote_revoke_all`, `remote_claim_control`, `remote_set_role`, `remote_set_permissions` (registered in `src-tauri/src/main.rs`; implementations in `commands/remote.rs`).
- Operator UI: Settings → Remote Control (`src/components/settings/sections/RemoteSection.tsx`) enables/disables the server, shows the pairing code (with a live expiry countdown) and LAN URLs, and manages paired devices and the lease.
- Browser bundle: `src/remote/` is a standalone React app built to `dist/remote.html` (`remote.html` root entry added to `rollupOptions.input` in `vite.config.ts`). It must not depend on Tauri APIs — it talks only to the WebSocket server. Client logic lives in `src/remote/wsClient.ts` (pair/authenticate handshake, revision-aware sends, snapshot/event hydration). The client reconnects automatically with exponential backoff after unexpected drops; a stored token is only cleared on a definitive `unknown_token`/`revoked` rejection so transient handshake failures never force re-pairing. The dev build is served from the project `dist/`.
- Production shipping: `tauri.conf.json` maps `"../dist": "dist"` in `bundle.resources` so the compiled `remote.html` plus assets land at `resource_dir/dist`, which `resolve_remote_assets_dir` (`remote/assets.rs`) searches. Rebuild with `npm run build` before packaging — `remote_enable` errors if `remote.html` is missing.

## Assets and runtime data

Runtime Bible and media assets may not be committed to the repository. Confirm required files from `src-tauri/src/commands/assets.rs` and the current startup logs rather than relying on old model instructions.

Do not reintroduce the old Whisper, ONNX, CPAL, VAD, or transcription-engine architecture described in previous versions of this file. The current repository has no `TranscriptionEngine`, audio engine, or `ort` dependency in `src-tauri/Cargo.toml`.

## Styling and color rules

Operator UI styling currently lives primarily in Tailwind classes and `src/index.css`. The modernization plan defines semantic operator colors in `docs/UI_UX_MODERNIZATION_PLAN.md`.

Target semantic meanings:

- Amber: primary action and attention.
- Red: on-air and destructive actions.
- Cyan: staged/up-next content.
- Green: saved, connected, or completed.
- Purple: presentation/design tools.
- Teal: audio/music tools.
- Blue/cyan focus ring: keyboard focus.

Do not use color alone to convey live state. Pair color with text, icon, border, and layout position.

## Important frontend constraints

- Tailwind v4 requires `@tailwindcss/vite` and `@import "tailwindcss"` in `src/index.css`.
- `select { color-scheme: dark; }` exists to keep native WebView2 option lists readable.
- The app root uses `user-select: none` for operator controls; editable ProseMirror content explicitly restores text selection.
- Use the existing `useTauriEvent` hook for new typed event listeners where possible.
- Use `useFonts` when a window must render user-installed fonts.
- Media paths should be relativized for persistence and resolved consistently before `convertFileSrc`.
- Keep keyboard shortcuts centralized through `keyboardRegistry.ts` and avoid collisions with text inputs, modals, lyric mode, and the slide editor.

## Verification expectations

For frontend-only work:

```bash
npm run build
```

For Rust or Tauri contract changes:

```bash
npm run build
cd src-tauri
cargo check
cargo clippy
```

Manual production checks should cover:

- Main window at 1280x720.
- Main window at 1920x1080.
- Windows scaling at 125% and 150%.
- Output and stage on one monitor.
- Output and stage on two monitors.
- Output/stage window toggle failure.
- Stage failure before go-live.
- Clear live and clear all propagation.
- Service reorder, undo, redo, save, and restart recovery.
- Missing Bible assets and missing media files.
- Lower-third, timer, props, scene, camera, and presentation behavior.
