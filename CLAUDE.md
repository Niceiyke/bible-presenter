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
- `output`: transparent, always-on-top audience output, 1920x1080, hidden by default.
- `stage`: performer confidence monitor, 1280x720, hidden by default.
- `design`: configured Design Hub window, 1440x900, hidden by default.
- `studio`: configured Audio Studio window, 1440x900, hidden by default.

`App.tsx` currently renders dedicated React branches for `output` and `stage`. Any work involving `design` or `studio` must first verify whether those windows are intended to load the same operator app or need their own renderer branch.

`src/windows/OutputWindow.tsx` renders projected content, backgrounds, media, cameras, timers, songs, custom slides, props, logos, transitions, lower thirds, and safe projection error fallback.

`src/windows/StageWindow.tsx` renders Now Live and Up Next confidence views, timer/clock information, custom slide previews, settings, lower-third state, and stage theme behavior.

## Output manager (Phase 1)

The output manager is a configurable output-surface abstraction: every output (projection window, stage window, a future overflow monitor, recorder, streamer) is an `OutputConfig` that subscribes to a program source and renders it. Outputs never mutate engine state — they only subscribe.

- Types: `src/types/output.ts` (`OutputConfig`, `OutputSource`, `OutputPresentation`, `OutputOverlays`, `OutputGeometry`, `OutputRecording`, `OutputStreaming`, `OutputState`). Sources: `live` | `staged` | `scene` | `item` | `blank`. Presentation overrides (theme / `reference_output_height` / background / blanked) layer on top of broadcast settings; overlays mask gates props / lower-third / logo per output.
- Backend: `src-tauri/src/outputs.rs` (`OutputManager`, Arc-managed like `RemoteControl`, persisted to `outputs.json` under the app data dir with additive forward migration from `default_outputs()`). Registered on `AppState.outputs` in `src-tauri/src/state.rs` and initialized in `main.rs` before windows are built.
- Commands: `src-tauri/src/commands/outputs.rs` — `outputs_list`, `outputs_states`, `outputs_update` (replace-all, idempotent), `outputs_set_visible` (toggles the bound window and re-broadcasts authoritative state on reveal).
- Events: `output-config-changed` (full list, replace-all semantics) and `output-state-changed` (per-output runtime status). Typed in `src/hooks/useTauriEvent.ts`.
- Frontend: `outputSlice` (`src/store/slices/outputSlice.ts`) holds `outputs` + `outputStates`, hydrated and kept in sync by `useAppInitialization.ts`. `OutputWindow`/`StageWindow` (separate webviews, local state) hydrate via `outputs_list` and listen to `output-config-changed`, applying `presentation`/`overlays` overrides. Default configs have empty overrides and full overlay masks, so behavior is identical until the operator customizes an output.
- The Phase 2 program-feed canvas compositor (`src/components/outputs/canvasProgramFeed.ts` draw helpers, `useCanvasCapture` hook, `ProgramFeedCanvas`/`ProgramFeedPreview` components) rasterizes the same program the DOM renderers paint and exposes `captureStream()`. It is a verification surface (PGM toggle in the Cockpit On-Air preview) and the capture source for recorder/streamer surfaces. The DOM path in `OutputWindow`/`StageWindow` remains authoritative.
- The Phase 3 recorder surface (`src/hooks/useRecorder.ts` + `src/components/RecordingsTab.tsx`, backend `src-tauri/src/commands/recordings.rs`) records the `ProgramFeedCanvas` stream via `MediaRecorder` to WebM, saved as base64 into `{app_data_dir}/recordings/`. Commands: `recordings_list`, `recording_save`, `recording_delete`, `recordings_open_folder`. The Recordings workspace (System nav) shows the live compositor, REC/STOP/Abort transport, elapsed timer, and saved files.
- The Phase 4 streamer surface (`src/hooks/useStreamer.ts` + `src/components/StreamerTab.tsx`) uploads the same compositor stream over WHIP (`RTCPeerConnection` + SDP POST; WebView2-native WebRTC, no backend changes). Endpoint URL + bearer token persist through `outputs_update` into the `stream-main` output's `streaming` field. The Streaming workspace (System nav) shows the live compositor, endpoint config, Go Live/Stop transport, and bitrate/status. See `docs/OUTPUT_MANAGER_DESIGN.md`.
- The Phase 6 RTMP ingest (`src/hooks/useRtmpEncoder.ts` + `src/components/StreamerTab.tsx`, backend `src-tauri/src/commands/rtmp.rs`) adds an RTMP mode: the compositor is encoded once with WebCodecs H.264 (Annex-B, `MediaStreamTrackProcessor` pulls `VideoFrame`s), packets are streamed to the backend, and long-lived `ffmpeg -f h264 -i pipe:` processes mux with `-c copy` (no re-encode) to the RTMP URLs. Backend commands `rtmp_start`/`rtmp_send`/`rtmp_stop`/`rtmp_status` (plus `rtmp_send_audio`) manage sessions keyed by `session_id` in a `HashMap` on `AppState.rtmp`, each with a writer thread draining an mpsc channel into ffmpeg stdin. Optional audio (Phase 6.1): an input device (mic / line-in / mixer feed, audio processing off) is captured via `getUserMedia`, encoded with WebCodecs `AudioEncoder` (AAC-LC), wrapped in ADTS headers, and streamed via `rtmp_send_audio` to a backend loopback TCP socket that ffmpeg reads as a second `-f adts -i tcp://127.0.0.1:<port>` input (muxed `-c:a copy`). ffmpeg resolves bundled-first via `src-tauri/src/binpaths.rs` (`{resource_dir}/bin/ffmpeg.exe` + `ffprobe.exe`, shipped as `bundle.resources`; fetch once with `scripts/fetch-ffmpeg.ps1` — LGPL build, not committed) with a PATH fallback, and errors cleanly when missing.
- The Phase 6.2 multi-platform Streaming Hub (`src/components/StreamerTab.tsx` + `src/components/streaming/`): the streamer streams the single compositor feed to any number of destinations at once. Each destination is a platform preset (YouTube / Facebook Live / Twitch / Custom RTMP / Custom WHIP in `presets.ts` — the ingest server is pre-filled, the operator pastes only their stream key) rendered as a `DestinationCard` owning its transport (`useRtmpEncoder` with a `sessionId`, or `useStreamer`). The compositor video track and the shared audio input are **cloned per destination** (a track allows only one `MediaStreamTrackProcessor`). Master **Go Live All** / **Stop All** control every enabled destination; per-card status/bitrate/error are shown. Destinations persist as `stream_destinations` (`StreamDestination` in `outputs.rs` + TS) on the `stream-main` output config, seeded from the legacy `streaming` field when present.
- The Phase 5 multi-bus / zone-bus primitives: `SceneComposition` zones become the first-class bus primitive. A `SceneZone` may carry `source: SceneZoneSource` (static `item`, or pinned to `verse`/`camera`/`timer`/`song`/`media`/`slide`). When a scene composition is the live item and content of a pinned class is taken live, the backend patches the matching zone(s) in place (`patch_scene_zones` in `src-tauri/src/remote/commands.rs`, wired into `op_commit_staged`/`op_go_live_item`) instead of replacing the whole scene — so a camera+Bible scene's verse zone advances as the operator steps through Scripture, and a timer zone follows the live countdown. Static zones (no `source`) keep legacy replace-the-scene behavior; a scene applied wholesale still replaces. The TS union in `src/types/scene.ts` mirrors the serde-tagged Rust `SceneZoneSource` in `src-tauri/src/store/media_schedule.rs`; the SceneBuilder inspector exposes the "Follows live content" selector. Scene-aware stepping: `compositionKind` in `src/items/registry.tsx` delegates `nav`/`nextLive` to the first pinned zone whose content kind supports navigation, so the Cockpit Next button and keyboard Arrow/Home/End advance the live scene's verse/song without leaving the operator console. The compositor, DOM outputs, recorder, and streamer all pick up the patched zones automatically since they render `zone.item`.
- The Phase 7 system diagnostics (`src/system/` + `src/components/SystemTab.tsx`, backend `src-tauri/src/commands/system.rs` via the `sysinfo` crate): a readiness/check battery (ffmpeg available (bundled or PATH), WebCodecs H.264 probe, WebRTC, audio input, camera, display count via `get_available_monitors`, CPU/RAM/disk) runs once in `SystemDiagnosticsProvider` (mounted in `App.tsx`), derives a pure capability report (`src/system/capabilities.ts` — `rtmpAvailable`, `whipAvailable`, `audioAvailable`, `cameraAvailable`, a streaming-capacity tier, and human-readable reasons) and gates services so disabled ones stay visible but can't start (StreamerTab disables RTMP Go Live and shared audio when their prerequisites are missing). The System → Diagnostics workspace shows the checklist + hardware summary + live performance panel; metrics poll (`system_metrics`) only while that panel is open, and compositor capture FPS comes from a frame counter in `useCanvasCapture` (`src/system/captureMetrics.ts`).

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

- `live-item-update`: live item or null.
- `item-staged`: staged item or null.
- `settings-changed`: presentation settings.
- `lower-third-update`: lower-third payload or null.
- `props-update`: persistent props.
- `media-control` and `media-state`: media transport commands and feedback.
- `songs-sync`, `studio-sync`, and `studio-slides-sync`: content synchronization.
- `system-log` and `operator-warning`: backend/operator diagnostics.

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

- `state.rs`: `AppState`, `PresentationState`, live/staged/settings/lower-third/props state.
- `store/mod.rs`: Bible store and shared data types.
- `store/data_db.rs`: SQLite data database setup and schema helpers.
- `store/media_schedule.rs`: media, schedules, services, songs, presentations, settings, props, scenes, and related persistence.
- `commands/bible.rs`: Bible lookup, versions, search, chapter/verse retrieval, and verse splitting.
- `commands/media.rs`: media import, metadata, playback, relinking, deletion, bulk operations, and existence checks.
- `commands/schedule.rs`: service schedules, recovery, and service persistence.
- `commands/display.rs`: stage, commit, go-live, clear, settings, current item, and timer behavior.
- `commands/studio_pres.rs`: custom presentations and slide templates.
- `commands/songs.rs`: songs and hymn-related persistence.
- `commands/lower_third.rs`: lower-third state, templates, and presets.
- `commands/props.rs`: persistent props.
- `commands/scenes.rs`: scene capture, persistence, and application.
- `commands/system.rs`: system diagnostics (`system_info`, `system_metrics`) via `sysinfo`.
- `commands/windows.rs`: output, stage, studio/design window toggles and monitor handling.
- `commands/assets.rs`: Bible data download and asset paths.

The startup path searches for `bible_data/wordlyte_bible.db`. If it is unavailable, the app creates an empty placeholder Bible store and Settings can download Bible assets. Bundled hymn data is `bible_data/hymns.json`.

User data is stored under the Tauri app-local data directory. The backend logs to the app data logs directory, and panic logs use the `io.wordlyte.app` local-app path.

## Remote control subsystem

The Remote Control feature lets a phone/tablet on the same LAN aid the operator. The Tauri backend runs an axum server (a WebSocket endpoint plus static files) and the browser bundle is a separate Vite multi-page entry.

- Rust: `src-tauri/src/remote/` (`mod.rs`, `server.rs`, `tls.rs`, `auth.rs`, `sessions.rs`, `hub.rs`, `protocol.rs`, `commands.rs`, `snapshot.rs`, `assets.rs`). The server reuses the last bound local port (persisted in `remote_port.txt` under the app data dir, falling back to a random port if it is taken), keeps authoritative state in `state.remote` (`RemoteControl` in `mod.rs`), and never duplicates live/staged/settings state. It serves **HTTPS** with a self-signed cert for the operator's LAN IP (generated on first use, persisted in `remote_tls.json`) — `getUserMedia` on the phone only works in a secure context, so the remote page must be TLS for the phone camera to stream; the WebSocket upgrades to `wss` automatically. Phones accept the self-signed certificate warning once per IP.
- Wire protocol: `src-tauri/src/remote/protocol.rs` defines `RemoteCommand`/`RemoteEvent`/`RemoteSnapshot`; the frontend mirrors these in `src/types/remote.ts` (`REMOTE_PROTOCOL_VERSION` must match `protocol.rs`). Command/event names are typed literally (e.g. `bible.stage`, `lower_third.show`) and route through the `dispatch` in `remote/commands.rs`.
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
