# Beta Readiness Findings and Fix Plan

Status: Blocked on the license-worker defect and the high-severity items below.

Audience: the coding agent implementing the beta-readiness fixes.

Scope: licensing, presentation state, output and stage windows, remote control,
streaming, recording, persistence, security, and release packaging.

## Operating Rules

1. Read `CLAUDE.md` before changing code.
2. Preserve unrelated worktree changes. At the time of this review,
   `src-tauri/Cargo.toml` already had a user change.
3. Keep presentation state backend-authoritative. Do not repair a synchronization
   problem by adding a second frontend source of truth.
4. Preserve transactional behavior for stage, live, clear, settings, props, and
   lower-third operations.
5. Add or update tests with each fix. Do not weaken existing tests or hide errors
   with broad fallbacks.
6. Use `apply_patch` for manual edits and keep changes minimal.

## Verified Baseline

The following checks were run against the reviewed revision:

- `npm run test`: 31 files, 317 tests passed.
- `npm run build`: passed. Vite reports the main JavaScript chunk is larger than
  500 kB.
- `cargo check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `cargo test`: 78 tests passed.
- `workers/license/npm test`: failed 3 checks for second-device registration,
  machine-slot enforcement, and idempotent revalidation.

The production frontend build completed after increasing the command timeout.
The packaged NSIS installer was not smoke-tested during this review.

## Findings

### P0: Fix Before Any External Beta

#### 1. License Durable Object parses the request body twice

The Durable Object reads the request body to obtain `key`, then calls
`request.json()` again to obtain `machineId`. A request body is consumable, so
the second parse returns an empty object. The registry stores `undefined` rather
than the machine fingerprint. This breaks idempotent validation and machine
slot accounting.

References:

- `workers/license/src/index.js:328-333`
- `workers/license/scripts/test.mjs:144-152`

Required fix:

- Parse the body once into a local object and pass both `key` and `machineId` to
  `register`.
- Reject missing or malformed machine IDs in the Durable Object as defense in
  depth.
- Add a regression test that validates machine 1 twice, machine 2 once, and a
  third machine against a two-slot license.
- Confirm the test suite has no `undefined` machine values in stored records.

Acceptance criteria:

- The worker test suite passes all checks.
- Revalidating an existing machine does not consume another slot.
- A third machine cannot activate a two-slot license.

### P1: Fix Before Broad Beta

#### 2. Presentation window hydration has an event-registration race

`listen()` returns a Promise, but snapshot hydration starts without awaiting
listener registration. An event can occur after the snapshot and before the
listener is installed, leaving output or stage stale after reopening.

References:

- `src/hooks/useAppInitialization.ts:176-184`
- `src/windows/OutputWindow.tsx:196-313`
- `src/windows/StageWindow.tsx:82-114`

Required fix:

- Register all presentation-critical listeners before requesting the snapshot.
- Await listener-registration promises before applying the snapshot.
- Include and compare the backend revision so an older snapshot cannot overwrite
  a newer event.
- Apply null live, staged, lower-third, and props payloads explicitly.

Acceptance criteria:

- Delayed-listener tests cover main, output, and stage windows.
- Reopening a window during a live transition converges to the same state as the
  main window.

#### 3. Local lower-third commands do not synchronize remote clients

The desktop `show_lower_third` and `hide_lower_third` commands emit Tauri events
but do not bump the presentation revision or publish `LowerThirdChanged` to the
remote hub. Connected phones can retain stale lower-third state.

References:

- `src-tauri/src/commands/lower_third.rs:7-23`
- Correct remote-aware pattern: `src-tauri/src/remote/commands.rs:527-544`

Required fix:

- Route local show/hide through the same authoritative helper used by remote
  commands, or share a common internal implementation.
- Bump the revision once per successful mutation.
- Emit the desktop event and remote event from the same locked operation.
- Add tests for show, hide, null propagation, revision, and remote payload.

#### 4. RTMP failure paths leak backend sessions and FFmpeg processes

Encoder, audio, and packet-feed failures call frontend teardown but do not always
call `rtmp_stop`. The backend retains the session and child process, so a retry
can report that the destination is already live.

References:

- `src/hooks/useRtmpEncoder.ts:388-445`
- `src-tauri/src/commands/rtmp.rs:342-365`

Required fix:

- Make `rtmp_stop` idempotent and invoke it from every failure path.
- Ensure frontend teardown and backend stop cannot race into a leaked session.
- Detect writer-thread and FFmpeg exit and remove dead sessions from the backend.
- Reap or kill child processes within a bounded timeout.
- Add tests for encoder failure, send failure, FFmpeg exit, retry, unmount, and
  queue saturation.

#### 5. Output visibility has competing sources of truth

The header and keyboard shortcut call legacy `toggle_output_window`, while the
Output Manager has separate visibility and persistence state. The legacy path
does not update `OutputManager`. The manager path persists visibility before
showing/focusing the window succeeds. A failed operation can leave UI, runtime,
and disk state inconsistent.

References:

- `src/components/layout/AppHeader.tsx:47-54`
- `src/hooks/useKeyboardShortcuts.ts:119`
- `src-tauri/src/commands/windows.rs:49-83`
- `src-tauri/src/commands/outputs.rs:77-112`

Required fix:

- Use one visibility command and one authoritative state path.
- Update persisted configuration only after the window operation succeeds, or
  roll back configuration on failure.
- Synchronize external hide/close events into runtime and persisted state.
- Publish the authoritative output state after every successful operation.
- Add tests for show failure, focus failure, hide, reopen, and Free-plan window
  limits.

#### 6. Scene application can partially apply state and ignore live failure

`apply_scene` persists and mutates settings before props persistence completes.
If props fail, settings remain changed. The composition `op_send_live` result is
discarded, so the command can return success without taking the scene live.

Reference:

- `src-tauri/src/commands/scenes.rs:61-91`

Required fix:

- Validate and persist the complete scene payload before mutating in-memory
  presentation state.
- Use one transaction or compensating rollback for settings, props, and lower
  third state.
- Propagate composition stage/commit errors to the caller.
- Add partial-failure tests for settings, props, lower third, and live commit.

#### 7. Database recovery can make a valid installation appear empty

Any `DataDb::open` or migration error renames the live database and then falls
back to an in-memory database from startup. Permission errors, transient locks,
and migration bugs can therefore present an empty workspace and allow changes
that disappear on restart.

References:

- `src-tauri/src/store/data_db.rs:18-40`
- `src-tauri/src/main.rs:109-120`

Required fix:

- Distinguish corruption from permission, lock, and migration errors.
- Never quarantine or replace the database for a generic open error.
- Quarantine only after explicit corruption evidence, preserving timestamped
  backups and sidecars.
- Surface an unrecoverable storage error instead of silently using in-memory
  storage for a normal installation.
- Add fresh DB, legacy DB, corrupt DB, locked DB, and restart tests.

#### 8. Recording save has unlimited IPC payloads and synchronous disk work

The frontend assembles the complete recording and sends it as one base64 string.
The backend decodes the entire payload and writes it without a size cap or
blocking boundary. Long recordings can cause memory spikes or stall runtime
workers.

References:

- `src/hooks/useRecorder.ts:172-176`
- `src-tauri/src/commands/recordings.rs:76-99`

Required fix:

- Add a documented maximum recording size and reject oversized payloads before
  decoding when possible.
- Move decode/write work to `spawn_blocking`, or implement chunked file transfer.
- Write atomically through a temporary file and rename only after success.
- Define duplicate-name behavior explicitly and test it.
- Add tests for oversized, malformed, disk-full, interrupted, and duplicate saves.

### P2: Fix Before or During Controlled Beta

#### 9. License Durable Object cache can overwrite administrator changes

The Durable Object caches records in memory while `/revoke` and `/extend` write
directly to KV. A warm Object can later write stale tier, expiry, or machine data
back to KV.

References:

- `workers/license/src/index.js:184-220`
- `workers/license/src/index.js:318-365`

Required fix:

- Serialize admin mutations through the same per-key Durable Object, or add a
  record version and reject stale writes.
- Add tests for admin mutation followed by new-device registration and concurrent
  mutation/validation.

#### 10. Bible ZIP extraction permits path traversal and lacks artifact pinning

Archive entry paths are joined directly under the destination without canonical
containment checks. The download has no pinned expected SHA-256 or signature.

Reference:

- `src-tauri/src/commands/assets.rs:121-153`

Required fix:

- Reject absolute paths and any `..` path component.
- Canonicalize/check every output path remains under the target directory.
- Download to a temporary archive and replace assets only after complete
  extraction.
- Pin the release URL and verify a committed expected hash.
- Add malicious ZIP tests.

#### 11. Media deletion can remove arbitrary external files

Legacy or relinked absolute paths are passed directly to `remove_file`. A
database record pointing outside the application media directory can cause
destructive deletion.

References:

- `src-tauri/src/store/media_schedule.rs:1551-1560`
- `src-tauri/src/store/media_schedule.rs:1575-1584`

Required fix:

- Clearly distinguish imported app-owned files from externally linked files.
- Require an explicit confirmation for external-file deletion, or restrict
  destructive deletion to app-owned paths.
- Add tests for relative, app-local absolute, and external absolute paths.

#### 12. Free-plan scene cap prevents editing existing scenes

`check_scene_cap` rejects every save when three scenes already exist, including
updates to an existing scene.

Reference:

- `src-tauri/src/commands/scenes.rs:12-32`

Required fix:

- Apply the cap only when creating a new scene.
- Allow updates when the submitted scene ID already exists.
- Add create-at-cap and update-at-cap tests.

#### 13. Arbitrary filesystem commands are exposed to the renderer

`write_text_file` and `read_text_file` accept unrestricted paths. Current UI flows
use file dialogs, but a renderer compromise or future caller could read or
overwrite arbitrary user files.

Reference:

- `src-tauri/src/commands/misc.rs:145-153`

Required fix:

- Restrict paths to approved app data locations, or pass validated dialog results
  through a backend-owned file operation.
- Reject traversal and unexpected extensions where appropriate.
- Add path-boundary tests.

#### 14. Output configuration can diverge from disk after persistence failure

`set_configs` replaces the in-memory list before `persist()` succeeds.

Reference:

- `src-tauri/src/outputs.rs:179-205`

Required fix:

- Serialize and persist the candidate configuration first.
- Swap in-memory state only after persistence succeeds.
- Keep a last-known-good backup and add failure tests.

#### 15. Release packaging is not reproducible or smoke-tested

FFmpeg is downloaded from the mutable `latest` release. CI does not inspect the
NSIS contents or launch the packaged app. The build also needs to verify remote
assets, hymns, FFmpeg, FFprobe, version, and window behavior.

References:

- `scripts/fetch-ffmpeg.ps1:14-29`
- `.github/workflows/build-windows.yml:63-80`
- `src-tauri/tauri.conf.json:77-104`

Required fix:

- Pin the FFmpeg release tag and expected SHA-256.
- Add a package inspection step for required resources.
- Add a Windows packaged smoke test for startup, license gate, output/stage
  windows, remote bundle, hymns, FFmpeg discovery, and recording/streaming gates.
- Verify installer/update signing and document any SmartScreen limitation.

## Implementation Order

### Phase 0: Reproduce and Lock the Baseline

1. Run the verification commands in this document.
2. Reproduce the three failing license-worker checks.
3. Add regression tests before changing behavior where practical.
4. Keep the pre-existing `src-tauri/Cargo.toml` change untouched.

Completion gate: the failing worker test is captured and reproducible.

### Phase 1: License and Remote Safety

1. Fix the Durable Object single-body parse defect.
2. Make per-key license mutations serialized and stale-write safe.
3. Add license status/tier checks to every mutating remote dispatch.
4. Ensure revoked devices lose permissions and active sockets immediately.
5. Add exact revision checks and camera ownership checks where applicable.

Completion gate: all Worker tests pass; expired, revoked, or unauthorized remote
clients cannot mutate presentation state.

### Phase 2: Presentation Transactions and Synchronization

1. Unify local and remote presentation mutation helpers.
2. Close the listener-registration and snapshot race.
3. Ensure revisions cover every successful live, staged, clear, settings, props,
   timer, and lower-third mutation.
4. Fix output/stage/main null propagation and lower-third visibility hydration.
5. Make scene application transactional and propagate live failures.

Completion gate: main, output, stage, and remote snapshots converge after every
mutation, clear, failure, and window reopen.

### Phase 3: Output, Streaming, and Recording Reliability

1. Consolidate output visibility behind one backend-authoritative command.
2. Roll back output configuration when window operations or persistence fail.
3. Make RTMP queues bounded and teardown idempotent.
4. Reap FFmpeg children and remove dead sessions.
5. Bound and offload recording persistence.
6. Add failure-path tests for FFmpeg exit, network stalls, queue saturation,
   encoder errors, disk errors, and unmount.

Completion gate: no leaked process, session, unbounded queue, or inconsistent
output visibility remains after failure or restart.

### Phase 4: Persistence and Filesystem Safety

1. Harden database recovery and add migration coverage.
2. Add malicious archive and path-boundary tests.
3. Protect external media files from accidental destructive deletion.
4. Fix the Free scene update cap.
5. Replace unrestricted file commands with validated operations.

Completion gate: storage failures are visible and recoverable; no valid data is
silently replaced with an empty workspace.

### Phase 5: Release Qualification

1. Pin and hash FFmpeg.
2. Add PR quality gates for frontend, Rust, and Worker tests.
3. Build the Windows installer.
4. Inspect installer resources and signatures.
5. Launch the packaged app and execute the smoke matrix.

Completion gate: the release artifact, not only the development build, passes all
beta checks.

## Required Verification Commands

Run from the repository root:

```text
npm ci
npm run test
npm run build

cd src-tauri
cargo check
cargo test
cargo clippy --all-targets -- -D warnings

cd ../workers/license
npm ci
npm test
```

For release qualification, also run:

```text
npm run tauri build
```

Then inspect and launch the generated NSIS artifact on a clean Windows machine.

## Final Beta Gate

Broad beta must remain blocked until all of the following are true:

- License activation, multi-machine limits, idempotent refresh, revoke, and tier
  changes pass integration tests.
- Main, output, stage, and remote state remain consistent after live, stage,
  clear, lower-third, props, timer, failure, and reopen flows.
- Scene application either completes atomically or leaves the previous state
  intact.
- Database and output persistence failures do not silently lose or hide data.
- ZIP downloads cannot escape their target directory and are integrity-checked.
- RTMP and recording failures clean up all processes, sessions, queues, and
  temporary files.
- External media deletion is safe and explicit.
- Packaged WHIP/RTMP/recording paths are verified on Windows.
- Required installer resources, remote assets, hymns, FFmpeg, and FFprobe exist.
- CI runs all frontend, Rust, Worker, and packaging checks before release.
