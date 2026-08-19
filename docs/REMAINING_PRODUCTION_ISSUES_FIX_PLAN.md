# Remaining Production Issues Fix Plan

Status: implementation plan

> **Implementation status (updated 2026-08-19):** WP0–WP9 are implemented, with
> failure-path tests added and the full quality gates green (`npm run test` 43
> files / 443 tests, `npm run build`, `cargo test` 131, `cargo clippy
> --all-targets -- -D warnings`, and the license-worker tests). WP7 adds the
> supported rich-text subset to the canvas compositor (bold/italic/underline/
> per-run color, wrapping, plain fallback). WP9 adds structured searchable
> columns + indexes to the content tables (schema v2, transactional migration,
> backfill, unknown-field preservation). WP10 is addressed by a pinned protocol
> contract test. WP11 is partially addressed: the license-worker tests and the
> remote-bundle check are added to `ci-check.yml`, and `build-windows.yml`
> already pins ffmpeg + Bible ZIP hashes and verifies bundled resources. The
> remaining WP11 steps (NSIS build, clean-machine install/launch, the manual
> acceptance matrix, and forced-termination recovery) require a packaged
> artifact and a clean Windows machine and are not feasible from a unit-test
> environment — they must be executed manually before release.

Audience: coding agents and maintainers
Source: current production-suite audit after Phases 0-10

This document is the current implementation queue for the remaining issues that
prevent Wordlyte from being a unified, dependable production system. It replaces
the stale status assumptions in earlier beta-readiness notes; those notes remain
historical reference material and must not be treated as the current issue list.

## Release Goal

The release is ready only when this workflow is reliable:

```text
Prepare content and service plan
  -> stage and preview
  -> take live through the Broadcast Engine
  -> render the configured program to projection, stage, recording, and streaming
  -> survive workspace navigation, window restart, device loss, network loss,
     and persistence failure without changing audience-visible state incorrectly
```

The target is not feature completeness. NDI input, advanced replay, distributed
rendering, and full digital-audio-console behavior remain out of scope. The target
is correctness of the supported church workflow.

## Current Baseline

The following checks passed during the audit:

- `npm run test`: 39 files, 422 tests passed.
- `npm run build`: passed; Vite reports a large main chunk.
- `cargo check`: passed.
- `cargo test`: 127 tests passed.
- `workers/license/npm test`: 39 tests passed.

The following check is currently failing:

- `cargo clippy --all-targets -- -D warnings`: two test-code lints fail in
  `src-tauri/src/store/data_db.rs:708` and
  `src-tauri/src/engine/presentation.rs:1349`.

The packaged NSIS installer and the Windows manual acceptance matrix have not
been completed. Do not claim a release gate is passed from unit tests alone.

## Non-Negotiable Rules

1. Read `CLAUDE.md`, this document, and the relevant current files before editing.
2. Preserve unrelated worktree changes, including untracked documentation.
3. Keep presentation state backend-authoritative. Do not add a second frontend
   source of truth to hide synchronization problems.
4. Route every audience-visible mutation through the Broadcast Engine.
5. Do not use fire-and-forget calls for audience-visible operations.
6. A failed output, recorder, streamer, camera, or audio operation must not alter
   live presentation state.
7. Persist before swapping durable in-memory configuration, and compensate or
   roll back runtime side effects when persistence fails.
8. Do not change persisted field meaning in place. Add a schema version and a
   migration test for every persisted-shape change.
9. Add failure-path tests with every implementation change.
10. Do not mark a task complete when its integration or manual acceptance gate is
    still missing.
11. Run the narrow tests first, then the complete verification commands for the
    work package.
12. Update `CLAUDE.md` when commands, windows, persistence, or ownership changes.

## Closed Issues Do Not Reopen

These items have current implementations and tests. Agents should only touch
them if a new regression is found:

- License worker request-body parsing, machine-slot accounting, and idempotent
  validation.
- Database corruption classification and migration backup behavior.
- Bible ZIP traversal protection and pinned SHA-256 verification.
- External media deletion boundaries.
- Free-plan scene update-at-cap behavior.
- Local lower-third routing through the engine and remote synchronization.
- Atomic candidate-first output configuration writes.
- Bible database reload and FTS rebuild without process restart.

## Issue Register

### P0-1: Streaming Transport Ownership

**Failure:** `StreamingProvider` is app-scoped, but the actual transport hooks
are mounted by `DestinationCard` inside `StreamerTab`. Navigating away unmounts
the cards and tears down RTMP/WHIP/NDI sessions.

**References:**

- `src/hooks/useStreamingProvider.tsx:25-39,389-445`
- `src/components/StreamerTab.tsx:266-281`
- `src/components/streaming/DestinationCard.tsx:51-96`

**Required result:** transport ownership must remain mounted for the lifetime of
the application or until the operator explicitly stops the destination.

### P0-2: Configured Output Parity

**Failure:** `ProgramFeedPreview` constructs a hardcoded live-source config with
all overlays enabled. Recording and streaming consume that preview while output
configuration can specify a different source, background, theme, blank state, or
overlay mask.

**References:**

- `src/components/outputs/ProgramFeedPreview.tsx:55-88`
- `src/hooks/useRecordingProvider.tsx:67-70,231-236`
- `src/hooks/useStreamingProvider.tsx:113-120,440-445`

**Required result:** every runtime output resolves its own `OutputConfig` through
the same `resolveProgramFrame` path and consumes the same authoritative snapshot.

### P0-3: RTMP Timing Contract

**Failure:** the shared encoder uses the configured FPS, but FFmpeg receives a
hardcoded `-framerate 30`. Non-30 FPS streams can have incorrect timing.

**References:**

- `src-tauri/src/commands/rtmp.rs:81-94,255-261`
- `src/hooks/useRtmpEncoder.ts:497-505`
- `src/types/output.ts:119-120`

**Required result:** the selected FPS is passed through the full encoder,
transport, and FFmpeg contract and is tested at 24, 30, and 60 FPS.

### P1-1: Transport Failure Recovery and Teardown

**Failure:** RTMP and WHIP errors transition to an error state, but there is no
bounded automatic reconnect policy. Packet-feed failure paths can also race with
teardown. The backend queue result is discarded, so queue drops are not accurately
reported.

**References:**

- `src/hooks/useStreamer.ts:177-189,224-228`
- `src/hooks/useRtmpEncoder.ts:400-449,579-590`
- `src-tauri/src/commands/rtmp.rs:192-211,326-347`

**Required result:** each destination has independent, bounded recovery; all
failure paths stop backend sessions idempotently; queue pressure is observable.

### P1-2: Source Registry Coverage

**Failure:** the main source registry is not used by all production consumers.
The output window and camera slice still call `getUserMedia` directly, creating
possible duplicate captures and inconsistent device-loss behavior.

**References:**

- `src/system/sourceRegistry.ts`
- `src/windows/OutputWindow.tsx:453-509`
- `src/store/slices/cameraSlice.ts:45-60`

**Required result:** every local-camera acquisition in each webview goes through
the registry for that webview. Phone-camera signaling remains separate and phone
IDs must never reach `getUserMedia`.

### P1-3: Scene Transaction Lock Ordering

**Failure:** `op_apply_scene` reads and persists settings before acquiring the
presentation mutation lock. A concurrent settings or props mutation can
interleave with scene application and compensation.

**Reference:** `src-tauri/src/engine/presentation.rs:585-616`

**Required result:** scene application acquires the engine mutation lock before
reading presentation state or performing scene persistence, then commits one
consistent state and one revision.

### P1-4: Audience-Visible Fire-and-Forget

**Failure:** song-triggered lower-third activation is invoked asynchronously after
the live item commits. The live operation can report success while its intended
lower-third fails.

**References:**

- `src/hooks/useItemActions.ts:161-180,243-260`
- Plan rule: `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md:1053-1054`

**Required result:** the caller receives a complete success/failure result for the
combined audience-visible operation. Prefer one engine operation that persists
and publishes the live item plus derived lower-third together.

### P1-5: Window Visibility Rollback and Corrupt Output Config Recovery

**Failure:** `set_output_visible` performs the native window operation before
persisting. If persistence fails, the actual window can remain shown/hidden while
disk and runtime retain the previous visibility. Malformed `outputs.json` also
falls back to defaults without necessarily surfacing the original configuration
failure as an operator-visible startup issue.

**References:**

- `src-tauri/src/commands/outputs.rs:125-155`
- `src-tauri/src/outputs.rs:218-246`

**Required result:** native window state is rolled back when persistence fails;
malformed output configuration is preserved/quarantined according to the storage
policy and reported as a startup issue instead of silently appearing default.

### P1-6: Snapshot and Remote Revision Completeness

**Failure:** the presentation snapshot does not contain all planned fields, and
the remote client applies incoming event revisions without rejecting stale
events.

**References:**

- `src-tauri/src/engine/presentation.rs:21-30`
- `src/types/display.ts:33-41`
- `src/remote/wsClient.ts:301-328`

**Required result:** snapshot schema, revision, previous item, active scene, and
timestamp semantics are explicit; stale remote events cannot overwrite newer
remote state.

### P2-1: Supported Compositor Parity

**Failure:** the canvas compositor intentionally approximates rich text and does
not fully model DOM animation behavior. Projection can differ from recording or
streaming for supported content.

**References:**

- `src/components/outputs/canvasProgramFeed.ts:17-29`
- `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md:704-715`

**Required result:** either implement the documented supported rich-text and
animation subset in the canvas path or explicitly gate unsupported slide content
before it can be recorded/streamed. Do not claim parity without fixtures.

### P2-2: Separate Program and Monitor Audio Policy

**Failure:** the shared audio graph exposes one program gain/mute path and does
not provide an independent monitor policy.

**References:**

- `src/system/audioGraph.ts`
- `src/hooks/useAudioGraphProvider.tsx`

**Required result:** program mute/volume cannot unexpectedly mute operator
monitoring, and monitor-only changes cannot alter recording or stream audio.

### P2-3: Searchable Metadata Normalization

**Failure:** songs, presentations, scenes, and services remain opaque JSON rows.
Searchable metadata is not separated from flexible presentation payloads.

**Reference:** `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md:932-945`

**Required result:** searchable fields are structured and indexed while the
presentation payload remains versioned JSON. Existing records must migrate without
losing unknown fields.

### P2-4: Remote and Extension Contracts

**Failure:** remote protocol types remain hand-synchronized, and source/output/
transport extension registries are not implemented.

**References:**

- `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md:978-1014`
- `src/remote/wsClient.ts`
- `src-tauri/src/remote/protocol.rs`

**Required result:** protocol versioning and unknown-value behavior are explicit;
new source/output/transport adapters do not require edits to core engine logic.

### P2-5: Release Quality Gates

**Failure:** strict clippy currently fails, CI does not run the license-worker
tests in the main quality workflow, and the packaged NSIS artifact is not
automatically inspected or smoke-tested.

**References:**

- `src-tauri/src/store/data_db.rs:708`
- `src-tauri/src/engine/presentation.rs:1349`
- `.github/workflows/ci-check.yml`
- `.github/workflows/build-windows.yml:126-130`

**Required result:** source quality gates pass, required release resources are
verified, and the actual packaged Windows artifact passes the documented manual
acceptance matrix before broad beta.

## Execution Order

Do not implement these work packages in parallel when one changes the contract
used by another. Each work package should be one focused agent task or one small
series of commits.

### WP0: Establish a Green Baseline

**Scope:** P2-5 quality gate and test inventory.

**Steps:**

1. Replace the boolean `assert_eq!` with `assert!` in the data DB test.
2. Initialize the presentation test settings without field reassignment.
3. Run frontend tests, frontend build, Rust check/test/clippy, and worker tests.
4. Record test counts and any environment-only failures in the agent report.

**Acceptance:** all repository quality commands pass before feature work begins.

### WP1: Make Output Configuration the Runtime Contract

**Scope:** P0-2 and the foundation for P0-1/P0-3.

**Steps:**

1. Define one function that builds the authoritative presentation snapshot used
   by each output runtime, including live, staged, settings, props, lower third,
   revision, scenes, and app-data path as required by the resolver.
2. Change `ProgramFeedPreview` to accept an actual `OutputConfig` rather than
   manufacturing `program-preview` with `{ type: "live" }` and all masks enabled.
3. Make recorder and streamer providers pass `record-main` and `stream-main`
   configs respectively.
4. Ensure configured source types `live`, `staged`, `item`, `scene`, and `blank`
   work for canvas output, with presentation and overlay overrides applied.
5. Keep camera, media, timer, props, lower-third, blackout, and missing-media
   behavior on the same resolver path.

**Tests:**

- Unit tests for each output source and mask combination.
- Provider tests proving record/stream configs are not replaced by a hardcoded
  live config.
- Fixture tests comparing projection frame resolution and capture frame
  resolution for the same snapshot.

**Acceptance:** changing an output source or overlay mask changes that output and
does not change the Broadcast Engine or another output.

### WP2: Move Destination Runtimes Into the App-Scoped Provider

**Scope:** P0-1.

**Steps:**

1. Split `DestinationCard` into a UI-only editor and a transport runtime
   component.
2. Render one hidden or non-visual runtime child per destination from inside
   `StreamingProvider`, so its hooks remain mounted while the app is running.
3. Register runtime handles with stable destination IDs. The card may consume
   status and invoke commands, but card unmount must not stop a live transport.
4. Make destination removal explicitly stop the runtime before deleting its
   persisted configuration.
5. Disable destination edits that would invalidate an active transport, or apply
   them only after an explicit stop/restart.
6. Ensure Stop All is the only normal master teardown path and remains idempotent.

**Tests:**

- Mount provider, start a destination, unmount only `StreamerTab`, and assert the
  transport remains live.
- Remove a destination while live and assert stop occurs before persistence.
- Navigate away and back without creating duplicate sessions or encoders.
- Stop All after a destination has already failed or disappeared.

**Acceptance:** workspace navigation cannot stop an active stream, and two
destinations still use one shared visual encoder.

### WP3: Complete FPS, Queue, and Transport Recovery Contracts

**Scope:** P0-3 and P1-1.

**Steps:**

1. Add `fps` to the typed `rtmp_start` command input and `RtmpSession` contract.
2. Pass the validated FPS into FFmpeg `-framerate`; reject unsupported values
   consistently at the provider and backend boundaries.
3. Change bounded enqueue results to distinguish `queued`, `dropped`, and
   `closed`. Return a typed/operator-safe result instead of silently converting
   a drop to success.
4. Add per-destination queue depth, dropped packets, sent packets, and last error
   to runtime status. Do not put high-frequency counters in the content DB.
5. Serialize or coalesce packet IPC per destination so a slow backend cannot
   create an unbounded set of outstanding `invoke` promises.
6. Make `rtmp_stop` idempotent and call it from encoder, audio, packet-feed,
   unmount, and startup-failure paths. Reap FFmpeg children and writer threads.
7. Add bounded reconnect for transient RTMP/WHIP failures, for example three
   attempts with exponential delays. A reconnect must reuse the destination ID,
   never duplicate a session, and expose `reconnecting` plus the next attempt.
8. Keep destination failures isolated; one failed destination must not stop other
   destinations or mutate live presentation state.

**Tests:**

- FFmpeg argument tests at 24, 30, and 60 FPS.
- Queue saturation and closed-writer tests.
- Encoder failure, audio failure, send failure, FFmpeg exit, retry, and unmount
  tests.
- Two destinations with one failing and one live.
- Reconnect attempt cap and no-session-leak tests.

**Acceptance:** stream timing matches the selected FPS; queue pressure is visible;
all sessions and processes are gone after Stop All or failure.

### WP4: Finish Source Registry Adoption

**Scope:** P1-2.

**Steps:**

1. Use `useCameraSource` or the registry acquisition API in the output window for
   local background and main camera feeds.
2. Change `cameraSlice.refreshCameras` to enumerate devices only; it must not
   open a temporary capture as a second acquisition path unless that permission
   request is deliberately routed through the registry policy.
3. Keep phone camera streams registered by the WebRTC host and never acquire
   `phone-camera-*`, `native:`, or `ndi:` IDs through browser media APIs.
4. Make device-ended and permission failures update the registry status and paint
   the safe fallback in every consumer.
5. Confirm each webview has one registry per webview where MediaStreams cannot
   cross Tauri windows; do not pretend a JS module is shared across windows.

**Tests:**

- One `getUserMedia` call per local device per webview with multiple consumers.
- Device loss, permission denial, retry, and disconnected fallback.
- Phone source registration/disconnect without `getUserMedia`.
- Output-window camera rendering after reopen.

**Acceptance:** previews, scene zones, projection, recording, and streaming use
the registry contract appropriate to their webview.

### WP5: Close Broadcast Engine Transaction Gaps

**Scope:** P1-3 and P1-4.

**Steps:**

1. Acquire the presentation mutation lock at the first line of scene
   application, before loading scene-dependent presentation state or persisting
   settings/props.
2. Prefer one DB transaction for all durable scene payload fields. If the
   existing store cannot combine them immediately, use explicit compensation and
   tests for every failure point.
3. Add an engine operation for the combined live-item plus derived lower-third
   operation, or extend the existing typed command result so a partial audience
   mutation cannot be reported as success.
4. Await all audience-visible backend calls in the UI. Remove `.then()` chains
   that update local visible state after the parent live operation already
   returned.
5. Audit direct UI `invoke` calls for stage, live, clear, settings, props, timer,
   and lower-third mutations. Keep legacy command names only as thin adapters to
   engine operations.
6. Preserve one revision bump and one authoritative event set per logical
   mutation, including null lower-third and clear behavior.

**Tests:**

- Concurrent scene/settings/props mutation tests.
- Scene persistence failure at each step with previous state unchanged.
- Combined live/lower-third success and failure tests.
- Main, stage, output, and remote convergence after each failure.

**Acceptance:** no audience-visible operation can succeed locally while a required
backend layer failed.

### WP6: Repair Output Visibility and Snapshot Contracts

**Scope:** P1-5 and P1-6.

**Steps:**

1. Capture the prior native window visibility before `set_output_visible`.
2. If persistence fails after a successful show/hide, restore the prior native
   visibility and return the persistence error.
3. Handle external close/hide events through the same authoritative output path,
   updating runtime and persisted visibility deliberately rather than silently.
4. On malformed `outputs.json`, retain the file for diagnosis, load a safe
   fallback only with an explicit startup issue, and never imply the persisted
   configuration was valid.
5. Add `previous`, `active_scene_id`, and `updated_at` to the presentation
   snapshot. Bump the snapshot schema version and update all consumers.
6. In `wsClient`, ignore non-snapshot events with a revision lower than the
   current remote revision. Define equal-revision behavior for multi-event
   logical mutations and snapshot replay.
7. Add event schema/version/timestamp fields where required by the contract
   inventory.

**Tests:**

- Show, hide, focus failure, persistence failure, rollback, reopen, and external
  close tests.
- Malformed output file startup issue test.
- Snapshot schema and legacy compatibility tests.
- Remote stale, equal, and newer event ordering tests.

**Acceptance:** disk, OutputManager runtime, native windows, main UI, stage UI,
output UI, and remote clients converge after success and failure.

### WP7: Define and Deliver Supported Compositor Parity

**Scope:** P2-1.

**Steps:**

1. Create a support matrix for verses, songs, media, cameras, timers, scenes,
   props, logos, lower thirds, custom slides, rich text, and animation.
2. For each supported feature, define its canvas behavior, timing behavior,
   missing-resource behavior, and expected output dimensions.
3. Implement the smallest supported rich-text subset needed for normal church
   slides, including alignment, font family/weight, color, underline, wrapping,
   and explicit fallback for unsupported nodes.
4. Implement or explicitly disable animation features that cannot be captured
   deterministically. Do not silently render a different animation in recordings.
5. Use the same resolved `ProgramFrame` and output config for DOM and canvas.
6. Add deterministic fixture tests rather than relying only on visual manual
   inspection.

**Tests:**

- Fixture coverage for every supported DisplayItem and overlay combination.
- Rich-text style and wrapping fixtures.
- Animation start/steady-state/fallback fixtures.
- Missing media and camera-disconnect fixtures.

**Acceptance:** every feature advertised for recording/streaming has documented
and tested equivalent projection behavior.

### WP8: Separate Program and Monitor Audio Policy

**Scope:** P2-2.

**Steps:**

1. Keep the shared input capture and program gain/mute policy unchanged for
   recording and streaming.
2. Add an independent monitor output policy and state, if monitor playback is
   supported in the current shell.
3. Ensure program mute affects only program consumers; monitor mute affects only
   local operator playback.
4. Surface device-loss and unavailable-monitor states without changing program
   output.

**Tests:**

- Program mute leaves visual output and monitor state predictable.
- Monitor mute does not change recorded or streamed audio.
- Audio device loss and retry preserve the selected policy.

**Acceptance:** operators can monitor safely without changing audience audio.

### WP9: Normalize Searchable Persistence Metadata

**Scope:** P2-3.

**Steps:**

1. Inventory current JSON schemas and existing SQLite tables before changing them.
2. Add structured searchable columns for song title/author/tags, presentation
   title/tags, scene name/tags, and service name/date/search text as appropriate
   to the existing schema.
3. Keep flexible slide/layout/style data in a versioned JSON payload column.
4. Add a transactional migration with `PRAGMA user_version`, pre-migration
   backup, and pure extraction functions from legacy JSON.
5. Backfill metadata without deleting unknown JSON fields.
6. Add indexes only for fields used by actual searches; do not move runtime state
   into the content database.
7. Make malformed payloads visible as content-record startup issues.

**Tests:**

- Legacy-to-new migration and rollback.
- Search behavior before and after migration.
- Unknown JSON field preservation.
- Malformed individual record reporting.

**Acceptance:** search does not require parsing every opaque payload, while old
content remains editable and renderable.

### WP10: Complete Remote and Extension Boundaries

**Scope:** P2-4.

**Steps:**

1. Treat Rust protocol definitions and TypeScript mirrors as one versioned
   contract; generate the mirror where practical or add a checked contract test.
2. Define explicit unknown command/event behavior and capability negotiation.
3. Add source, scene, output, and transport registries at the adapter boundary.
4. Keep the Broadcast Engine dependent only on stable capability interfaces, not
   concrete RTMP, camera, or window implementations.
5. Add remote status events only when required by the remote UI; do not stream
   high-frequency transport metrics unnecessarily.

**Tests:**

- Rust/TypeScript protocol fixture compatibility.
- Unknown command/event compatibility.
- Registry adapter registration and capability gating.
- Adding a fake source/output/transport without editing engine mutation logic.

**Acceptance:** a new adapter requires adapter code and tests, not Broadcast
Engine changes.

### WP11: Release Qualification and Windows Acceptance

**Scope:** P2-5 and final release gate.

**Steps:**

1. Add worker tests to the main PR quality workflow or document the required
   separate blocking workflow.
2. Add package inspection for `remote.html`, remote assets, hymns, Bible assets,
   FFmpeg, FFprobe, installer version, and signing metadata.
3. Keep FFmpeg and Bible artifact tags and hashes pinned; fail the release if a
   mutable URL or missing hash is detected.
4. Build the NSIS installer with `npm run tauri build` on Windows.
5. Install and launch the packaged artifact on a clean Windows machine.
6. Execute the manual matrix below and record the result with the exact build
   version in release notes.
7. Test recovery after forced termination during output configuration and data
   writes.

**Manual acceptance matrix:**

- 1280x720 and 1920x1080.
- Windows scaling at 125% and 150%.
- One monitor and two monitors.
- Projection output and stage output together.
- Recording while navigating between workspaces.
- Streaming while navigating, with two destinations where the license permits.
- RTMP at 24, 30, and 60 FPS.
- Temporary network loss and bounded reconnect.
- FFmpeg exit and retry.
- Camera permission denial, disconnect, and recovery.
- Audio device disconnect and recovery.
- Missing media and safe fallback.
- Window close/reopen during live content.
- Bible install and search without process restart.
- License gate, tier caps, remote pairing, permissions, lease, and revoke.
- Forced process termination during persistence, followed by startup recovery.

**Acceptance:** the packaged artifact, not only the development build, passes the
matrix and all release resources are present.

## Agent Task Template

Every implementation agent should receive one work package using this format:

```text
Implement WP<N>: <title> from docs/REMAINING_PRODUCTION_ISSUES_FIX_PLAN.md.

Read CLAUDE.md and the referenced files first. Preserve unrelated worktree
changes. Implement only this work package. Add the required failure-path tests.
Do not introduce a second source of truth, renderer, or lifecycle owner.

Before reporting completion, run the work package tests and the required full
commands. Report:
- files changed
- behavior changed
- tests run and exact results
- persisted/IPC/event contract changes
- known limitations
- manual checks still required
```

## Final Definition of Done

The unified production-suite release is complete only when:

- WP0 through WP11 acceptance gates pass or an explicitly documented non-goal is
  approved.
- Projection, stage, recording, and streaming consume the configured output
  source and masks.
- Workspace navigation cannot stop an active recorder or stream.
- FPS, timestamps, queue pressure, reconnects, and process teardown are correct.
- All camera consumers use the source lifecycle contract.
- Scene and lower-third mutations are transactional and result-bearing.
- Native windows, disk, runtime state, main UI, stage UI, output UI, and remote
  state converge after failure and restart.
- Persistence failures are visible and recoverable without silently emptying a
  valid installation.
- Full frontend, Rust, worker, build, package, and Windows acceptance checks pass.

Until then, label the product as an architecture-complete internal-test build,
not a production-ready unified suite.
