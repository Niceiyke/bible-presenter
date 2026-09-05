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
- `capture`: transparent, always-on-bottom webview on the primary monitor (sized to fit, click-through, off the taskbar, never focused) that renders the same `OutputWindow` DOM surface; it is the dedicated WGC source for the recorder/streamer so recording/streaming works even when the projection window is closed. It is **hidden by default** and only revealed while a recording/streaming session is active (`ensure_capture_visible` before WGC binds, `maybe_hide_capture` after the last session stops in `commands/capture.rs`) — during a session it MUST intersect the desktop, since a hidden/minimized window stops delivering new frames and capture freezes on the first idle frame, while WGC captures covered windows fine so the operator never sees it. Never revealed through `outputs_set_visible`.
- `stage`: performer confidence monitor, 1280x720, hidden by default.
- `design`: configured Design Hub window, 1440x900, hidden by default.
- `studio`: configured Audio Studio window, 1440x900, hidden by default.

`App.tsx` currently renders dedicated React branches for `output` (projection), `capture` (same `OutputWindow` surface but no phone-camera answering peer), and `stage`. Any work involving `design` or `studio` must first verify whether those windows are intended to load the same operator app or need their own renderer branch. The `capture` window follows the same event-driven hydrate path as `output` in `useAppInitialization` (early-return after `setIsInitialized(true)`), and `OutputWindow` hydrates itself from `presentation_snapshot` + `outputs_list`.

Tauri capabilities are granted per window label (`src-tauri/capabilities/`): `default.json` covers `main`/`stage`/`studio`, `output.json` covers `output` + `capture`. Any new window label MUST be added to a capability file or its webview gets no IPC access at all — `invoke`/`listen` fail silently and the window renders frozen defaults (this exact failure kept the `capture` window stuck on "Waiting for projection...").

`src/windows/OutputWindow.tsx` renders projected content, backgrounds, media, cameras, timers, songs, custom slides, props, logos, transitions, lower thirds, and safe projection error fallback.

`src/windows/StageWindow.tsx` renders Now Live and Up Next confidence views, timer/clock information, custom slide previews, settings, lower-third state, and stage theme behavior.

## Output manager (Phase 1)

The output manager is a configurable output-surface abstraction: every output (projection window, stage window, a future overflow monitor, recorder, streamer) is an `OutputConfig` that subscribes to a program source and renders it. Outputs never mutate engine state — they only subscribe.

- Types: `src/types/output.ts` (`OutputConfig`, `OutputSource`, `OutputPresentation`, `OutputOverlays`, `OutputGeometry`, `OutputRecording`, `OutputStreaming`, `OutputState`). Sources: `live` | `staged` | `scene` | `item` | `blank`. Presentation overrides (theme / `reference_output_height` / background / blanked) layer on top of broadcast settings; overlays mask gates props / lower-third / logo per output.
- Backend: `src-tauri/src/outputs.rs` (`OutputManager`, Arc-managed like `RemoteControl`, persisted to `outputs.json` under the app data dir with additive forward migration from `default_outputs()`). Registered on `AppState.outputs` in `src-tauri/src/state.rs` and initialized in `main.rs` before windows are built.
- Commands: `src-tauri/src/commands/outputs.rs` — `outputs_list`, `outputs_states`, `outputs_update` (replace-all, idempotent), `outputs_set_visible` (show/hide a window output, or start/stop a recorder/streamer). Window visibility is unified through the single authoritative `set_output_visible` helper (`commands/outputs.rs`): the legacy `toggle_output_window`/`toggle_stage_window` commands (`commands/windows.rs`) and the Output Manager all route through it, so the window, the persisted `outputs.json`, the runtime `OutputState`, and the UI (which reads `outputStates` in `AppHeader`/`RemoteTab`) can never disagree. It toggles the bound window FIRST, then persists + swaps config, then broadcasts `output-config-changed`/`output-state-changed`; external window close events are synced back in `main.rs`. Recorders/streamers persist through `outputs_update`; runtime progress reports via `report_output_state`.
- Events: `output-config-changed` (full list, replace-all semantics) and `output-state-changed` (per-output runtime status). Typed in `src/hooks/useTauriEvent.ts`.
- Frontend: `outputSlice` (`src/store/slices/outputSlice.ts`) holds `outputs` + `outputStates`, hydrated and kept in sync by `useAppInitialization.ts`. `OutputWindow`/`StageWindow` (separate webviews, local state) hydrate via `outputs_list` and listen to `output-config-changed`, applying `presentation`/`overlays` overrides. Default configs have empty overrides and full overlay masks, so behavior is identical until the operator customizes an output.
- The legacy Phase 2 canvas compositor (the `useCanvasCapture` `captureStream()` loop and the `drawProgramFrame`/`ProgramFeedCanvas`/`ProgramFeedPreview` canvas rasterizer in `canvasProgramFeed.ts`) was **removed as dead code** — it was superseded by native WGC of the `capture` window and the single DOM renderer (`ProgramSurface`/`ProgramSurfacePreview`). `canvasProgramFeed.ts` now holds only the camera-id resolution the DOM path still uses (`collectCameraDeviceIds` + `getEffectiveBg`). The DOM path in `OutputWindow`/`StageWindow` remains authoritative.
- The Phase 5 recorder surface (`src/hooks/useRecordingProvider.tsx` + `src/components/RecordingsTab.tsx`, backend `src-tauri/src/commands/recordings.rs`) records the program from the dedicated off-screen `capture` window natively: `RecordingSession` on `AppState.recording` starts native Windows Graphics Capture with a bounded frame sink (`capture::bounded_sink` / `capture::start_with_sink` in `src-tauri/src/capture/mod.rs`), a writer thread drains the **NV12** frames (the capture readback converts BGRA→NV12 once per frame, so QSV/libx264 encoders never run per-process swscale) into ffmpeg stdin (`rawvideo nv12` → H.264 → MP4), and ffmpeg writes to a temp file as it records. Because capture binds the off-screen `capture` window (which renders the same `OutputWindow` surface) rather than the audience `output` window, recording works even when the projection window is closed. Memory stays bounded (the sink blocks under backpressure — no browser Blob/base64 accumulation). Consumer lifecycle is **attach/detach on a shared session**: `capture::start_for_consumer` / `capture::attach_consumer` / `capture::detach_consumer` (with `ConsumerHandle`s) let the recorder attach a **strict** (never-drop, blocking) sink and streaming destinations attach **best-effort** (try_send, drop-newest) sinks to the SAME capture session when both target the same window at the same geometry+fps — so a recording overlapped with a broadcast runs ONE WGC readback instead of two, and the session (and its WGC thread) tears down exactly when the last consumer detaches. A strict sink is only safe while it is the SOLE consumer: the recorder is **auto-downgraded to best-effort** the moment a live (best-effort) consumer joins the shared session, because a blocking `send` can otherwise stall the shared capture thread and abort the live RTMP streams (`-10053` WSAECONNABORTED at recorder stop) or deadlock detach; recording stays strict only in solo mode, and detach searches both buckets by id so a downgraded recorder handle still removes cleanly. Commands: `recordings_list`, `recording_save` (legacy blob path, still available), `recording_delete`, `recordings_open_folder`, plus native `recording_start` / `recording_status` / `recording_stop_active` / `recording_abort`. The `RecordingProvider` is now a thin controller around those commands (no compositor/MediaRecorder/canvas); the Recordings workspace (System nav) previews the program with the shared `ProgramSurfacePreview` DOM renderer and shows a REC/STOP/Abort transport, elapsed timer, and saved files (MP4/H.264). Video-only for now — program audio is the deliberate Phase 7 mix bus.
- The legacy Phase 4 WHIP streamer (`src/hooks/useStreamer.ts`) and the legacy Phase 6 WebCodecs RTMP ingest (`src/hooks/useRtmpEncoder.ts` + the loopback audio path) were **removed as dead frontend code** — superseded by the native multi-destination RTMP broadcast (below). The backend pieces they talked to still exist: `commands/streaming.rs` (the active native hub), `commands/rtmp.rs` (`rtmp_start`/`rtmp_send`/`rtmp_stop`/`rtmp_status`/`rtmp_send_audio`, sessions keyed by `session_id` in a `HashMap` on `AppState.rtmp`), and the `useNativeRtmpBroadcast` hook drive the live path. ffmpeg resolves bundled-first via `src-tauri/src/binpaths.rs` (`{resource_dir}/bin/ffmpeg.exe` + `ffprobe.exe`, shipped as `bundle.resources`; fetch once with `scripts/fetch-ffmpeg.ps1` — LGPL build, not committed) with a PATH fallback, and errors cleanly when missing.
- The legacy Phase 6 WebCodecs RTMP ingest frontend (`src/hooks/useRtmpEncoder.ts`) was **removed as dead code** — superseded by the native hub below (the backend `commands/rtmp.rs` still exists for the `rtmp_*` command set, but the native `streaming.rs` broadcast is the active path).
- The Phase 6 native multi-destination RTMP broadcast is the active Streaming Hub (`src/components/StreamerTab.tsx` + `src/components/streaming/` + `src/hooks/useNativeRtmpBroadcast.ts`, backend `src-tauri/src/commands/streaming.rs`). Per the operator's scope decision the hub is **RTMP-only** this pass — WHIP and NDI cards/presets were dropped from the streaming UI. One backend broadcast (`stream_rtmp_start` → `capture::start_for_consumer`, a best-effort sink on the dedicated off-screen `capture` window — it converges onto the same session the recorder uses when active, so recording+streaming run a single WGC readback) captures the program once and pushes it into **ONE ffmpeg process that encodes once and `tee`s the encoded stream to every enabled RTMP destination** (`-f rawvideo -pix_fmt nv12 -s WxH -r fps -i pipe:0 -an -c:v ... -f tee '[f=flv:onfail=ignore]url1|[f=flv:onfail=ignore]url2'` — streams are `-map`ped explicitly because the tee muxer refuses targets without them), so N destinations cost one encode + one cheap `-c copy` FLV mux each instead of N full BGRA→YUV pipelines; `stream_rtmp_stop`/`stream_rtmp_status` manage the single `BroadcastSession` on `AppState.streaming` (stop detaches the one `ConsumerHandle`, closes the program-audio `AudioFeed` BEFORE waiting on ffmpeg, then reaps the child), and every `StreamDestinationStatus` mirrors the shared process (all live or all failed with the shared `stderr_tail`). `useNativeRtmpBroadcast` polls `stream_rtmp_status` every 1s while active and drives a **master Go Live All / Stop All**. Each destination is a config-only RTMP preset (YouTube / Facebook Live / Twitch / Custom RTMP in `presets.ts` — ingest server pre-filled, the operator pastes only their stream key) rendered as a `DestinationCard`; `StreamerTab` shows a `ProgramSurfacePreview` master preview and gates on `capabilities.rtmpAvailable` (= `ffmpegAvailable`). Capture resolution/FPS and destinations persist on the `stream-main` output config (`stream_destinations`, seeded from the legacy `streaming` field). This is **video-only** (`-an`) — program audio is the deliberate Phase 7 mix bus. **Accepted on hardware** against a local mediaMTX RTMP server (`rtmp://127.0.0.1:1935`): a single broadcast published two simultaneous H.264 destinations (`[path 12345]` + `[path 4321]` both online) with HLS playback serving live viewers, and Stop All tore the publish down cleanly (`[RTMP] closed: EOF` → muxer destroyed). The mediaMTX WebRTC player does not play the stream because libx264's High-profile B-frames aren't WebRTC-conformant ("WebRTC doesn't support H264 streams with B-frames") — the HLS path is the viewer to use for local validation; real platforms (YouTube/Facebook/Twitch) accept the stream as-is.
- The Phase 7 program audio bus (`src-tauri/src/commands/program_audio.rs` + `src/hooks/useProgramAudio.tsx`) adds the external-input mix bus shared by the recorder and the streamer. Per the operator's scope decision the audio source is **external mic / line-in only** (a PA/mixer line-in typically carries the full program mix) — output-window content audio (background `<audio>`, live media `<video>`/`<audio>`) is deliberately deferred. `AudioFeed` (`commands/program_audio.rs`) is a refcounted **shared capture**: one dedicated ffmpeg subprocess opens the dshow device ONCE (`-f dshow -audio_buffer_size 100 -i audio=DEV`), encodes AAC-LC 48 kHz/128 kbps, and writes ADTS to stdout; a reader thread → bounded channel → fan-out thread broadcasts to every connected `TcpStream`, so recording+streaming run ONE dshow capture + ONE AAC encode instead of two ffmpeg processes fighting over the same dshow pin (which under QSV load stalled both pipelines with `h264_qsv Invalid FrameType:0` / exit `0xbebbb1b7`). Consumers never open dshow themselves: `subscribe_feed(device)` joins the feed (refcounted; reused while alive + same device, else torn down and restarted) and returns a private `AudioRelay` whose `port()` the consuming ffmpeg reads as `-f aac -i tcp://127.0.0.1:<port>` with `-c:a copy` (no re-encode; `aac` is the raw-ADTS demuxer name — `adts` is only the muxer). `AudioRelay::drop` releases the consumer's feed refcount (the last drop kills the feed) AND closes the consumer's socket; it MUST be dropped BEFORE the caller waits on ffmpeg, or `child.wait()` blocks forever because ffmpeg never sees audio EOF and never finalizes the mux (this exact bug silently lost recordings — the relay's per-consumer EOF closes the hang even when the OTHER surface keeps the feed alive with its own relay). The recorder (`recording_start` with `audio_device`; `record_ffmpeg_args` takes `audio_feed_port`; `RecordingSession.audio` holds the relay) and the streamer (`stream_rtmp_start` with `audio_device`; `stream_tee_args` takes `audio_feed_port`; `BroadcastSession.audio` holds the relay, `audio_attached` in `StreamDestinationStatus`) both subscribe this way; every stop/abort does `session.audio = None` before waiting on ffmpeg. `ProgramAudioProvider` (mounted in `App.tsx`) captures the chosen input once (`getUserMedia`, processing off), encodes AAC-LC with WebCodecs `AudioEncoder`, wraps frames with `wrapAdts` (reused from `useRtmpEncoder.ts`), and sends every packet to BOTH `recording_send_audio` and `stream_rtmp_send_audio` — the backend no-ops whichever surface has no active session, so one arm feeds every live recorder/streamer (including recorder+streamer simultaneously) with zero cross-tab coordination. Both commands enforce `LicenseTier::Premium` (shared audio input). The Recorder and Streaming workspaces expose a "Program audio" toggle + input-device picker; recording/streaming just pass `enableAudio` to their start command. 
- The Phase 5 multi-bus / zone-bus primitives: `SceneComposition` zones become the first-class bus primitive. A `SceneZone` may carry `source: SceneZoneSource` (static `item`, or pinned to `verse`/`camera`/`timer`/`song`/`media`/`slide`). When a scene composition is the live item and content of a pinned class is taken live, the backend patches the matching zone(s) in place (`patch_scene_zones` in `src-tauri/src/remote/commands.rs`, wired into `op_commit_staged`/`op_go_live_item`) instead of replacing the whole scene — so a camera+Bible scene's verse zone advances as the operator steps through Scripture, and a timer zone follows the live countdown. Static zones (no `source`) keep legacy replace-the-scene behavior; a scene applied wholesale still replaces. The TS union in `src/types/scene.ts` mirrors the serde-tagged Rust `SceneZoneSource` in `src-tauri/src/store/media_schedule.rs`; the SceneBuilder inspector exposes the "Follows live content" selector. Scene-aware stepping: `compositionKind` in `src/items/registry.tsx` delegates `nav`/`nextLive` to the first pinned zone whose content kind supports navigation, so the Cockpit Next button and keyboard Arrow/Home/End advance the live scene's verse/song without leaving the operator console. The compositor, DOM outputs, recorder, and streamer all pick up the patched zones automatically since they render `zone.item`.
- The Phase 7 system diagnostics (`src/system/` + `src/components/SystemTab.tsx`, backend `src-tauri/src/commands/system.rs` via the `sysinfo` crate): a readiness/check battery (ffmpeg available (bundled or PATH), WebCodecs H.264 probe, WebRTC, audio input, camera, display count via `get_available_monitors`, CPU/RAM/disk) runs once in `SystemDiagnosticsProvider` (mounted in `App.tsx`), derives a pure capability report (`src/system/capabilities.ts` — `rtmpAvailable` (= `ffmpegAvailable`), `audioAvailable`, `cameraAvailable`, a streaming-capacity tier, and human-readable reasons) and gates services so disabled ones stay visible but can't start (StreamerTab disables RTMP Go Live and shared audio when their prerequisites are missing). The System → Diagnostics workspace shows the checklist + hardware summary + live performance panel; metrics poll (`system_metrics`) only while that panel is open.
- The Phase 8 NDI scaffold (`src-tauri/src/commands/ndi.rs` + the `ndi` cargo feature, `ndiAvailable` capability): lets the hub publish the program as an NDI|HX source on the LAN (OBS via obs-ndi, vMix, ProPresenter) and is **SDK-gated on the build machine** — the real sender needs the NDI SDK (`https://ndi.video/for-developers/ndi-sdk/download/`, EULA) installed to `C:\Program Files\NDI\NDI 6 SDK` (or `NDI_SDK_DIR`) plus `grafton-ndi` + LLVM/clang (bindgen). Per the operator's scope decision the NDI cards/presets were dropped from the streaming UI this pass (the hub is RTMP-only), but the `ndi` backend commands remain for the roadmap refresh (the Phase 6 WebCodecs frontend that consumed them — `useNdiSender`/`useRtmpEncoder` — was removed as dead code; a future NDI sender will be native like the RTMP hub). End users download nothing: `Processing.NDI.Lib.x64.dll` ships inside the installer (fetched at release time by a `fetch-ndi.ps1`-style script, <30 days old per the NDI license). Until the SDK is present `ndi_status` reports unsupported and NDI cards stay gated. The real pipeline (H.264 Annex-B → SDK send + avsync, sessions keyed by `session_id`) lands in the `#[cfg(feature = "ndi")]` branches once `grafton-ndi` + LLVM/clang (bindgen) are available; NDI audio and NDI **input** (discovery → receive → `VideoDecoder` + `VideoTrackGenerator` camera source) are follow-ups. Full design: `docs/OUTPUT_MANAGER_DESIGN.md` §9.

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
- `commands/ndi.rs`: NDI status/send stubs (`ndi_status`, `ndi_start`, `ndi_send`, `ndi_stop`) — SDK-gated behind the `ndi` cargo feature.
- `capture/mod.rs`: native window-capture service (Phase 4 of `docs/DOM_NATIVE_CAPTURE_IMPLEMENTATION_PLAN.md`) — an `Arc<CaptureManager>` on `AppState.capture` (built in `main.rs`) holding sessions keyed by `session_id`. The Windows backend (`capture_thread_windows`, target-gated) runs one worker thread per session: `D3D11CreateDevice` (BGRA) -> `IDXGIDevice` -> `CreateDirect3D11DeviceFromDXGIDevice` -> `IGraphicsCaptureItemInterop::CreateForWindow(HWND)` (via `raw-window-handle` `HasWindowHandle`) -> `Direct3D11CaptureFramePool::CreateFreeThreaded` (so no DispatcherQueue/pump is needed) -> `GraphicsCaptureSession.StartCapture`; it polls `TryGetNextFrame`, copies the frame surface through a staging texture (`D3D11_MAP_READ`) into a packed **NV12** `CaptureFrame` (`bgra_to_nv12`, BT.601 limited range — one conversion per WGC readback shared by every consumer, so QSV/libx264 encoders never run per-process swscale), and keeps the latest frame on the session. Because a **static window stops presenting new frames** (WGC only fires when the window presents — e.g. scripture held on screen), the loop also does an **idle re-feed**: it remembers the last captured frame and re-feeds it to the sink at the target rate, so a recorded/streamed timeline spans the real wall-clock duration (identical frames encode at near-zero bitrate) instead of stalling after the first moments. Frames stream to attached consumers via `capture::bounded_sink()`/`start_with_sink` (`FrameSink` = bounded `SyncSender`; blocks under backpressure — bounded memory). Typed `CaptureStatus` (fps/drops/resolution/last error) is reported per session. A `#[cfg(not(windows))]` fallback keeps the crate compiling cross-platform. Commands `program_capture_start` (takes `window_label`, defaults to `output`; `width`/`height`/`fps` optional), `program_capture_stop`, and `program_capture_status` are in `commands/capture.rs`, registered in `main.rs`. The `windows = "=0.61.3"` dep adds `Graphics`, `Graphics_DirectX`, `Graphics_DirectX_Direct3D11`, `Win32_System_WinRT_Direct3D11`, `Win32_System_WinRT_Graphics_Capture`, `Win32_System_Com`, `Win32_Graphics_Direct3D11`, `Win32_Graphics_Dxgi`, and `Win32_Graphics_Dxgi_Common` features (plus `raw-window-handle`). Consumed by the Phase 5 recorder (`recording_start`) and later streaming; the status-consumer hook is Phases 5+.
- `commands/windows.rs`: output, stage, studio/design window toggles and monitor handling.
- `commands/assets.rs`: Bible data download and asset paths.
- `commands/license.rs`: license status, activation, refresh, and deactivation. State lives in `src/license.rs` (`LicenseManager`, Arc-managed on `AppState.license`, persisted to `license.json` under the app data dir) and validation runs against a Cloudflare Worker in `workers/license/` (deploy instructions + admin API in its README; the endpoint host is set in `default_server_url()` and overridable via `WORDLYTE_LICENSE_URL`).

The startup path searches for `bible_data/wordlyte_bible.db`. If it is unavailable, the app creates an empty placeholder Bible store and Settings can download Bible assets. Bundled hymn data is `bible_data/hymns.json`.

`DataDb::open` only quarantines (renames aside with timestamped `corrupt-*` sidecars) and recreates the data database on *demonstrable* corruption (`SQLITE_CORRUPT`/`SQLITE_NOTADB`). Permission, transient-lock, IO, or migration errors are surfaced (`OpenError::Other`), never quarantined. If the data database cannot be opened, `main.rs` falls back to an in-memory store and records a `startup_issues` entry (on `AppState` and `MediaScheduleStore`) that `get_startup_status` returns to the operator banner — a valid installation is never silently hidden behind an empty workspace.

User data is stored under the Tauri app-local data directory. The backend logs to the app data logs directory, and panic logs use the `io.wordlyte.app` local-app path.

## License / beta gating

Wordlyte enforces a per-church, machine-bound, expiring license so beta testers can't use the app forever or copy it to other systems.

- **Machine fingerprint**: `machine_uid::get()` (Windows `MachineGuid`, `/etc/machine-id`, macOS UUID) hashed to a 64-hex id and sent to the license server (no PII). The persisted `license.json` record is bound to that id — copying the app data dir or install folder to another PC fails the local machine check (`invalid`) and re-activation on a new PC hits the server-side device-slot cap.
- **Expiry + offline grace**: the Worker's server time is authoritative for `expires_at`. The app validates on launch and on demand (`license_refresh`); when the server is unreachable it keeps working through an offline grace window (`OFFLINE_GRACE_DAYS` in `src-tauri/src/license.rs` — 14 days Free, 30 days paid), then locks until one online check. Clock rollback is caught with a monotonic `last_seen_at` anchor (`CLOCK_TOLERANCE_SECS`).
- **Tiers (free / pro / premium)**: every key carries a `tier`, stored server-side at issue time and clamped per tier (`workers/license/src/index.js` — free=1 machine, pro=3, premium=50). `evaluate_status` in `license.rs` degrades a lapsed *paid* key to `Free` (status stays `Active`) instead of locking, so the church keeps projecting with Free features until renewal; Free keys lock outright. The effective tier rides `LicenseStatusInfo.tier` → `LicenseInfo.tier` (`src/types/license.ts`). The single frontend capability map is `src/system/tiers.ts` (`TIER_CAPABILITIES` + `tierCapabilities()`): free = 1 Bible version, 1 on-air window, watermark on output, 3 scenes, preset-only lower-third templates, no remote/recording/streaming/NDI; pro = + remote, recording, streaming (1 destination), NDI, custom templates, no watermark, 2 windows; premium = unlimited windows/destinations/machines + shared audio input. Enforcement: backend `license::ensure_active_tier` guards `remote_enable` and the 1-window output cap in `outputs_set_visible`; `check_scene_cap` in `commands/scenes.rs` caps 3 scenes on Free; the rest are frontend gates (watermark in `OutputWindow.tsx`, Bible version caps in `BibleVersionsSection`/`BibleTab`/`BiblePickerModal`, REC/streamer/NDI/shared-audio/template gates). Change a key's tier with `scripts/extend.mjs <key> 0 <tier>` or the admin UI's Tier button.
- **Enforcement**: the operator shell gates on `license_status` — `App.tsx` shows `LicenseGate` (activation / blocked screens) before the console renders when the status is not `active`, and `OfflineLicenseBanner` when offline within grace. Defense in depth: `license::ensure_allowed` is called at the top of the broadcast commands (`stage_item`, `commit_staged`, `go_live`, `go_live_item`, `toggle_output_window`, `toggle_stage_window`, `show_output_test_pattern`, `outputs_set_visible` when revealing, `remote_enable`). Content prep (Bibles, media, songs, settings) stays available.
- **Events**: `license-updated` carries `LicenseInfo` (`src/types/license.ts`) after any status/activation/refresh change; hydrated on init via `license_status`. Settings → License (`src/components/settings/sections/LicenseSection.tsx`) shows status, expiry, device slots, the machine fingerprint, and refresh/deactivate actions.
- **Admin**: issue keys (`scripts/issue.mjs` in `workers/license/`, optional `tier` arg), revoke instantly server-side, extend/upgrade (`extend.mjs <key> <days> [tier]`), list keys, or the `/admin` web UI (tier selector, Tier/Extend/Revoke per key). This is a speed-bump control (a determined user could patch the binary); it stops casual copying and gives a server-side kill switch.

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
