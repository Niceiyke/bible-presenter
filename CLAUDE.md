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
- `commands/windows.rs`: output, stage, studio/design window toggles and monitor handling.
- `commands/assets.rs`: Bible data download and asset paths.

The startup path searches for `bible_data/wordlyte_bible.db`. If it is unavailable, the app creates an empty placeholder Bible store and Settings can download Bible assets. Bundled hymn data is `bible_data/hymns.json`.

User data is stored under the Tauri app-local data directory. The backend logs to the app data logs directory, and panic logs use the `io.wordlyte.app` local-app path.

## Remote control subsystem

The Remote Control feature lets a phone/tablet on the same LAN aid the operator. The Tauri backend runs an axum server (a WebSocket endpoint plus static files) and the browser bundle is a separate Vite multi-page entry.

- Rust: `src-tauri/src/remote/` (`mod.rs`, `server.rs`, `tls.rs`, `auth.rs`, `sessions.rs`, `hub.rs`, `protocol.rs`, `commands.rs`, `snapshot.rs`, `assets.rs`). The server reuses the last bound local port (persisted in `remote_port.txt` under the app data dir, falling back to a random port if it is taken), keeps authoritative state in `state.remote` (`RemoteControl` in `mod.rs`), and never duplicates live/staged/settings state. It serves **HTTPS** with a self-signed cert for the operator's LAN IP (generated on first use, persisted in `remote_tls.json`) — `getUserMedia` on the phone only works in a secure context, so the remote page must be TLS for the phone camera to stream; the WebSocket upgrades to `wss` automatically. Phones accept the self-signed certificate warning once per IP.
- Wire protocol: `src-tauri/src/remote/protocol.rs` defines `RemoteCommand`/`RemoteEvent`/`RemoteSnapshot`; the frontend mirrors these in `src/types/remote.ts` (`REMOTE_PROTOCOL_VERSION` must match `protocol.rs`). Command/event names are typed literally (e.g. `bible.stage`, `lower_third.show`) and route through the `dispatch` in `remote/commands.rs`.
- Control model: a single exclusive controller lease (`ControllerLease` in `sessions.rs`). Mutating commands are gated on an operator role, an up-to-date `expected_revision`, and the lease. `RemoteRequestControl` is exempt from the lease gate because it acquires the lease. WebRTC signaling relays (`camera.offer`/`camera.answer`/`camera.ice`) are deliberately NOT mutating — they only forward SDP/ICE and would otherwise fail when a snapshot goes stale or ICE bursts trip the mutation rate limiter. Pairing uses a code (30-minute TTL, generous per-IP rate budget) whose SHA-256 hash is stored; device tokens are persisted under the app data dir (`remote_devices.json`).
- Tauri commands: `remote_enable`, `remote_disable`, `remote_status`, `remote_regenerate_pairing`, `remote_revoke_device`, `remote_revoke_all`, `remote_claim_control` (registered in `src-tauri/src/main.rs`; implementations in `commands/remote.rs`).
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
