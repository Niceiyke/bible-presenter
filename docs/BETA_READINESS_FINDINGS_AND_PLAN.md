# Beta Readiness Findings and Implementation Plan

Status: Review complete; implementation pending.

Scope: operator presentation flow, output and stage windows, persistence, remote
control, licensing, streaming/recording, and release packaging.

## Recommendation

Do not begin a broad external beta until the blocker and high-severity items
below are fixed and the final beta gate passes. A limited internal beta may
continue only with explicit warnings around live-state synchronization,
database safety, and streaming.

## Verification Baseline

The following checks passed during the review:

- 314 frontend tests in 31 test files.
- 77 Rust unit tests.
- `npm run build`.
- `cargo check`.
- `cargo clippy --all-targets --all-features -- -D warnings`.
- 31 license-worker tests.

`npm run tauri build` completed the frontend build but did not produce an NSIS
installer within the ten-minute review window. Packaged behavior remains
unverified.

## Findings

### Blockers

1. **Clear staged is frontend-only.**

   The Cockpit clear button only calls `setStagedItem(null)`. The backend staged
   slot, output window, and stage window retain the item. Reopening a window can
   restore the supposedly cleared item.

   References: `src/components/layout/Cockpit.tsx:154-156`,
   `src-tauri/src/remote/commands.rs:85-90`.

2. **Clear All does not persist cleared props.**

   `op_clear_all` clears the in-memory props layer but does not call the props
   persistence path. Previously cleared props can reappear after restart.

   References: `src-tauri/src/remote/commands.rs:136-149`,
   `src-tauri/src/store/media_schedule.rs:1787-1796`.

3. **Fresh databases do not create `slide_templates`.**

   Template operations query and write the `slide_templates` table, but the
   initial migration never creates it. Template listing, saving, and deletion
   fail on a fresh installation.

   References: `src-tauri/src/store/data_db.rs:53-95`,
   `src-tauri/src/store/media_schedule.rs:1747-1762`.

4. **Database recovery can delete all user data.**

   Any database open or migration error removes the database and sidecars before
   recreating it. This includes permission errors, transient locks, migration
   bugs, and unexpected schema errors.

   Reference: `src-tauri/src/store/data_db.rs:18-29`.

5. **Concurrent stage and send-live operations are not atomic.**

   Desktop and remote callers can interleave stage and commit operations. A
   newer item can replace the staged slot before an older caller commits it.

   References: `src/hooks/useItemActions.ts:187-205`,
   `src-tauri/src/remote/commands.rs:162-175`,
   `src-tauri/src/state.rs:8-15`.

### High Severity

6. **`goLive` reports success when no item was committed.**

   `commit_staged` may legitimately return null, but the frontend still updates
   previous-item state, may stage the next item, and returns success.

   References: `src/hooks/useItemActions.ts:139-184`,
   `src-tauri/src/commands/display.rs:21-33`.

7. **Window hydration can overwrite newer events with stale state.**

   Hydration invokes and event listeners run concurrently without a revision or
   ordering guard. Output hydration also ignores null live results. The main
   window does not hydrate staged state at all.

   References: `src/windows/OutputWindow.tsx:179-205,281-291`,
   `src/windows/StageWindow.tsx:66-109`,
   `src/hooks/useAppInitialization.ts:108-109`.

8. **Lower-third hydration can disagree with the output.**

   The main window restores an active lower-third payload but does not set
   `ltVisible(true)`. The output can show a lower third while the operator UI
   reports it hidden.

   Reference: `src/hooks/useAppInitialization.ts:98-100`.

9. **Revoked remote devices can retain active permissions.**

   Revocation removes the token, but authorization falls back to cached socket
   permissions when the token is missing. Existing sockets are not reliably
   closed.

   References: `src-tauri/src/remote/commands.rs:520-529`,
   `src-tauri/src/commands/remote.rs:218-231`,
   `src-tauri/src/remote/server.rs:380-405`.

10. **Remote control does not re-check licensing for every mutation.**

    License checks occur when remote control is enabled. An already-connected
    remote can continue mutating presentation state after expiry or revocation.

    References: `src-tauri/src/commands/remote.rs:97-100`,
    `src-tauri/src/remote/commands.rs:594-659`.

11. **Backend tier enforcement is incomplete.**

    Recording, RTMP, NDI, and output configuration commands rely primarily on
    frontend gates. Direct local IPC callers can bypass the advertised tier
    restrictions.

    References: `src-tauri/src/commands/recordings.rs:73-100`,
    `src-tauri/src/commands/rtmp.rs:175-225`,
    `src-tauri/src/commands/ndi.rs:55-74`,
    `src-tauri/src/commands/outputs.rs:30-40`.

12. **WHIP streaming is likely blocked by the packaged CSP.**

    The configured `connect-src` does not allow operator-configured external
    HTTPS WHIP endpoints.

    References: `src-tauri/tauri.conf.json:69-70`,
    `src/hooks/useStreamer.ts:203-223`.

13. **The release workflow replaces the hymn library with an empty file.**

    CI writes `[]` to the tracked populated hymn file before packaging. Beta
    installers produced by this workflow contain no hymns.

    Reference: `.github/workflows/build-windows.yml:57-62`.

14. **RTMP has unbounded buffering and incomplete failure cleanup.**

    Encoded packets are sent into an unbounded backend channel. Slow networks
    can grow memory without limit. Encoder/feed failure teardown does not always
    call `rtmp_stop`, leaving FFmpeg sessions registered.

    References: `src/hooks/useRtmpEncoder.ts:234-269,383-394`,
    `src-tauri/src/commands/rtmp.rs:113-125`.

15. **Remote pairing validation and consumption are racy.**

    Pairing validation releases its lock before the code is marked used. Two
    concurrent handshake requests can both pass validation.

    References: `src-tauri/src/remote/auth.rs:156-187`,
    `src-tauri/src/remote/server.rs:440-459`.

16. **Remote revision checks accept future revisions.**

    Mutating commands reject only revisions older than the server revision.
    Arbitrary future revisions are accepted, defeating strict stale-client
    protection.

    Reference: `src-tauri/src/remote/commands.rs:577-587`.

17. **Remote camera signaling lacks complete authorization and ownership checks.**

    Camera offer and ICE commands are broadly exempted from mutation checks, and
    camera stop does not reliably prove that the caller owns the camera.

    References: `src-tauri/src/remote/commands.rs:605-618,1098-1147`.

### Medium Severity

18. **Startup failures silently become empty/default data.**

    Independent initialization failures are converted to empty arrays or default
    settings, and the app is marked initialized without identifying the failed
    resource.

    Reference: `src/hooks/useAppInitialization.ts:62-79,136`.

19. **Keyboard blackout and lower-third commands are not transactional.**

    Local state is changed before backend success and several commands are
    fire-and-forget. The operator UI can disagree with the output after a command
    failure.

    Reference: `src/hooks/useKeyboardShortcuts.ts:52-56,80-107`.

20. **Undo Clear All can partially restore state.**

    Undo restores staged, live, props, and lower-third state sequentially. A late
    failure leaves earlier restorations applied without compensation.

    Reference: `src/hooks/useItemActions.ts:280-313`.

21. **Output configuration persistence is non-atomic.**

    A crash can corrupt `outputs.json`; startup then silently falls back to
    defaults. In-memory configuration can also change before persistence succeeds.

    Reference: `src-tauri/src/outputs.rs:139-209`.

22. **Recording IPC has no size limit and performs large synchronous work.**

    Large base64 recordings are decoded and written without a size cap or
    blocking-task boundary. Same-name files are overwritten without an explicit
    policy.

    Reference: `src-tauri/src/commands/recordings.rs:69-99`.

23. **Persisted schedules and branding can retain machine-specific paths.**

    Media items and selected backgrounds/logos can persist absolute paths. Moving
    or restoring app data can leave schedules and scenes pointing to another
    machine.

    References: `src-tauri/src/store/media_schedule.rs:1188-1209`,
    `src/hooks/useItemActions.ts:324-355`,
    `src/components/layout/ContentBrowser.tsx:127-130`.

24. **Targeted remote signaling can invalidate unrelated clients.**

    Targeted hub events increment the global revision even though other clients
    do not receive those events.

    Reference: `src-tauri/src/remote/hub.rs:43-60`.

25. **License machine-slot registration is race-prone.**

    The Worker uses a read-modify-write sequence against KV. Concurrent
    activations can exceed the configured machine limit or lose registrations.

    Reference: `workers/license/src/index.js:131-143`.

26. **Release dependencies and FFmpeg are not integrity-pinned.**

    CI uses `npm install`, and FFmpeg is downloaded from a mutable latest URL
    without checksum verification.

    References: `.github/workflows/build-windows.yml:54-66`,
    `scripts/fetch-ffmpeg.ps1:16-33`.

27. **License deployment can succeed without `ADMIN_TOKEN`.**

    The workflow warns and deploys even when the admin secret is missing, making
    license administration unusable.

    Reference: `.github/workflows/deploy-license-worker.yml:45-69`.

28. **There is no PR quality gate for release-critical code.**

    The Windows build workflow runs on main pushes and does not require frontend,
    Rust, or Worker tests before merge.

    References: `.github/workflows/build-windows.yml:2-5`,
    `package.json:6-12`.

29. **Worker tests do not cover expiry, cron, production bindings, or concurrent
    activation.**

    Reference: `workers/license/scripts/test.mjs:102-215`.

### Low Severity and Release Hygiene

30. **Windows artifacts are not configured for Authenticode signing.**

    Updater signing variables are present, but executable and installer signing
    is not configured. Beta users may see SmartScreen unknown-publisher warnings.

    References: `.github/workflows/build-windows.yml:68-75`,
    `src-tauri/tauri.conf.json:77-104`.

31. **There is no isolated license staging environment.**

    The Worker configuration declares only the production KV environment, which
    makes operational testing risky.

    Reference: `workers/license/wrangler.toml:5-9`.

32. **NDI is still a scaffold.**

    The repository exposes NDI types, UI, and commands, but the SDK sender and
    runtime bundling are not implemented. NDI must not be presented as a supported
    beta capability until completed or explicitly marked experimental.

    Reference: `TODO.md:6-13`.

33. **Configured window capabilities require packaged verification.**

    The output capability is separate from the default capability. This may be
    correct, but the packaged output window must be tested for command and event
    access before release.

    References: `src-tauri/capabilities/default.json:5-20`,
    `src-tauri/capabilities/output.json:1-10`.

## Implementation Plan

### Phase 0: Baseline and Test Harness

1. Record the current worktree status and baseline test counts.
2. Add helpers for mocked Tauri invokes and emitted events.
3. Add isolated `AppState` and SQLite fixture helpers.
4. Add delayed-response helpers for hydration race tests.
5. Add remote WebSocket authorization fixtures.
6. Do not begin implementation until the baseline is recorded.

### Phase 1: Atomic Presentation State

1. Add one backend presentation mutation lock or one mutex-protected
   presentation state object.
2. Refactor stage, commit, send-live, clear-live, clear-staged, and Clear All
   into locked internal operations.
3. Add an atomic `send_live_item` command and update frontend callers to use it.
4. Make `commit_staged` returning null a failed/no-op operation.
5. Add a backend `clear_staged` command and update Cockpit to invoke it.
6. Persist empty props during Clear All.
7. Add rollback behavior when Clear All persistence fails.
8. Add concurrency tests for stage A, stage B, clear, and send-live ordering.
9. Add tests for empty go-live and clear-staged propagation.

Completion gate: no concurrent presentation test can commit the wrong item, and
all clear operations update backend, main, output, and stage state.

### Phase 2: Authoritative Synchronization

1. Add a typed presentation snapshot command containing live, staged, settings,
   props, lower-third state, and a monotonic revision.
2. Increment the revision for every successful presentation mutation.
3. Include revisions in presentation events.
4. Register listeners before window hydration.
5. Apply hydration snapshots only when they are not older than the latest event.
6. Hydrate staged state in the main window.
7. Apply null values explicitly in every window.
8. Restore lower-third visibility together with the payload.
9. Replace silent startup fallbacks with structured startup warnings.
10. Add event-versus-hydration race tests for main, output, and stage windows.

Completion gate: reopening any window during or after a transition produces the
same authoritative state as the main operator window.

### Phase 3: Database and Persistence Safety

1. Add the `slide_templates` table to the migration.
2. Convert migrations to versioned, transactional migrations.
3. Stop deleting the live database after generic errors.
4. Quarantine explicitly corrupt databases with a timestamped backup.
5. Surface unrecoverable database errors instead of showing empty data.
6. Add fresh-schema and legacy-schema migration tests.
7. Make `outputs.json` writes temp-file plus atomic rename.
8. Keep a last-known-good outputs backup.
9. Restore in-memory output configuration when persistence fails.
10. Normalize persisted media references to IDs or app-relative paths.
11. Migrate existing absolute media paths.
12. Ensure media relinking updates schedule and scene resolution.
13. Add relocation, relinking, missing-file, and restart tests.

Completion gate: no persistence failure deletes user data or silently turns valid
data into an empty/default workspace.

### Phase 4: Remote Security

1. Replace separate pairing validation and consumption with one atomic method.
2. Close all active sockets on device revocation.
3. Treat missing token records as revoked; never use cached permissions as a
   fallback.
4. Enforce current license status and tier during every mutating remote dispatch.
5. Require exact revision equality for normal mutations.
6. Exclude targeted signaling from the global presentation revision unless it
   changes authoritative state.
7. Require camera permission for signaling commands.
8. Track camera ownership and reject stops from non-owners.
9. Add concurrent pairing, revocation, stale-revision, and camera ownership tests.
10. Move license machine-slot reservation to a serialized Worker-side mechanism,
    preferably a Durable Object or transactional D1 design.
11. Add concurrent license activation tests.
12. Replace Worker `Math.random()` key generation with Web Crypto randomness.

Completion gate: a revoked or expired remote cannot mutate state, reuse a pairing
code, control another device's camera, or bypass revision checks.

### Phase 5: Streaming and Recording

1. Add backend license and tier checks to recording, RTMP, NDI, and output
   configuration commands.
2. Replace RTMP unbounded channels with bounded queues.
3. Define packet-drop or controlled-stop behavior when queues are full.
4. Make `rtmp_stop` idempotent and call it from every frontend failure path.
5. Reap FFmpeg processes and remove dead sessions from backend state.
6. Add recording size limits and early payload validation.
7. Move large base64 decode/write work to a blocking task.
8. Use extension validation and atomic recording writes.
9. Add disk-full, duplicate-name, invalid-payload, FFmpeg-exit, and network-stall
   tests.
10. Permit only the required HTTPS destinations in the CSP, or proxy WHIP
    signaling through a validated backend command.
11. Test WHIP in a packaged WebView, not only jsdom.

Completion gate: streaming and recording fail closed, do not leak processes or
memory, and work in the packaged application.

### Phase 6: UI Failure Recovery

1. Make keyboard blackout update local state only after backend success or add
   explicit rollback.
2. Make lower-third keyboard show/hide await backend success.
3. Roll back PageUp/PageDown local state if the backend rejects the update.
4. Add a backend `restore_presentation_snapshot` command for Clear Undo.
5. Restore live, staged, props, and lower-third state as one transaction.
6. Add partial-failure tests for every restoration component.

Completion gate: no failed keyboard or undo operation leaves operator state
different from output state.

### Phase 7: Release Pipeline

1. Remove the CI step that overwrites `hymns.json`.
2. Validate hymn JSON and assert a minimum entry count before packaging.
3. Change CI installs from `npm install` to `npm ci`.
4. Pin FFmpeg version and verify SHA-256 before bundling.
5. Add a PR workflow for frontend tests/build, Rust check/test/clippy, and Worker
   tests.
6. Make license deployment fail if `ADMIN_TOKEN`, Cloudflare credentials, or
   bindings are missing.
7. Add a separate staging Worker environment.
8. Add installer inspection for hymns, remote bundle, FFmpeg, FFprobe, version,
   and capabilities.
9. Configure and verify Authenticode signing.
10. Build and launch the packaged application in a Windows smoke-test job.
11. Verify output, stage, design, studio, and remote-window behavior in the
    packaged build.

Completion gate: CI cannot publish a release with missing content, missing
secrets, unverified binaries, or failing quality checks.

### Phase 8: NDI Release Decision

1. If NDI is out of beta scope, mark it experimental and disable its live
   controls consistently.
2. If NDI is in beta scope, implement the SDK sender, runtime bundling,
   attribution, license checks, backend tier enforcement, and OBS/vMix end-to-end
   tests.
3. Do not present scaffold commands as a supported live output.

## Final Beta Gate

The project is ready for broad beta only when all of the following are true:

- Fresh install starts without deleting or losing data.
- Existing databases migrate without destructive recovery.
- Slide templates work on a fresh database.
- Hymns are present in the release artifact.
- Stage, clear staged, go-live, clear live, and Clear All synchronize across all
  windows.
- Clear All remains cleared after restart.
- Concurrent send-live operations cannot expose the wrong item.
- Lower-third state remains consistent after restart and command failure.
- Revoked remote devices lose access immediately.
- Remote mutations stop after license expiry or revocation.
- Camera ownership is enforced.
- Streaming handles FFmpeg exit, network stalls, queue saturation, and teardown.
- Recording handles size limits, disk failures, and interrupted writes.
- WHIP works in a packaged build.
- License deployment fails closed when secrets are missing.
- CI runs all frontend, Rust, Worker, and packaging checks before release.
- Installer resources, signatures, windows, FFmpeg, remote bundle, and hymns are
  verified.

Required final commands:

```text
npm ci
npm run test
npm run build
cd src-tauri
cargo check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cd ../workers/license
npm ci
npm test
```
