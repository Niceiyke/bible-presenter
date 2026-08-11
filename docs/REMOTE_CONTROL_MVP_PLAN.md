# Remote Control MVP Implementation Plan

Status: Proposed
Owner: Implementation agent
Scope: Local-network remote control for Wordlyte, including Scripture lookup,
  verse preview, staging, live control, service queue control, songs, and
  lower-third lyrics
Last reviewed: 2026-08-11

## 1. Mission

Build a modern, responsive, top-quality remote control experience for Wordlyte
that runs in a phone or tablet browser on the same local network as the main
Tauri application.

The MVP must let a volunteer:

- Connect safely to the main Wordlyte computer.
- Search Scripture by reference or keywords.
- Browse Bible versions, books, chapters, and verses.
- Preview a verse before broadcasting.
- Stage a verse.
- Send a verse live.
- Move to the next or previous verse.
- See what is on air and what is staged.
- Operate the service queue.
- Control songs and lyrics overlays at a basic level.
- Recover cleanly from connection loss or stale state.

The remote is a production control surface, not a second copy of the entire
operator console. It must remain focused, safe, fast, and easy to use with one
hand.

## 2. Product Principles

1. **The backend is authoritative.** The remote never owns live state.
2. **Preview is never broadcast.** Preview must not call stage or live commands.
3. **Stage and Go Live are separate actions.** They must be visually and
   behaviorally distinct.
4. **Scripture is a first-class workflow.** It must not be hidden behind a
   generic search screen.
5. **One safe action at a time.** The primary action must be obvious for the
   current context.
6. **No hover dependency.** Every important action must work with touch and
   keyboard.
7. **A stale remote must not send stale content live.** Revision checks are
   required for mutating commands.
8. **The remote must fail safely.** Disconnecting the remote must not change
   audience output.
9. **Use progressive disclosure.** Show common Scripture and live actions first;
   keep advanced tools behind secondary screens.
10. **Match the Wordlyte console language.** Cyan means staged, red means live or
    destructive, amber means primary action, and green means connected or saved.

## 3. Current Repository Foundation

### 3.1 Authoritative backend state

`src-tauri/src/state.rs` owns:

- Live display item.
- Staged display item.
- Presentation settings.
- Lower-third state.
- Props layer.

The remote must integrate with this state rather than maintaining a second
source of truth.

### 3.2 Existing display commands

The existing Rust commands are in
`src-tauri/src/commands/display.rs`:

- `stage_item`
- `commit_staged`
- `clear_live`
- `clear_all`
- `get_current_item`
- `get_staged_item`
- `update_timer`

The current stage/live flow is already transactional in
`src/hooks/useItemActions.ts`:

```text
stageItem(item)
  -> stage_item
  -> item-staged event
  -> goLive()
  -> commit_staged
  -> live-item-update event
```

Remote commands must reuse this transaction. Do not implement a remote-only
shortcut that commits arbitrary content directly.

### 3.3 Existing synchronization events

The current typed frontend event map is in
`src/hooks/useTauriEvent.ts`:

- `live-item-update`
- `item-staged`
- `settings-changed`
- `lower-third-update`
- `props-update`
- `media-control`
- `media-state`
- `songs-sync`
- `studio-sync`
- `studio-slides-sync`
- `operator-warning`

These events synchronize Tauri windows. They are not a suitable network
protocol. The remote server must publish equivalent remote events from the
backend after authoritative mutations.

### 3.4 Existing Scripture commands

The Bible commands already exist in `src-tauri/src/commands/bible.rs`:

- `get_bible_versions`
- `get_books`
- `get_chapters`
- `get_verses_count`
- `get_chapter`
- `get_verse`
- `get_next_verse`
- `get_prev_verse`
- `search_semantic_query`
- `split_verse`

The remote should call these through a remote API layer that validates input.
The browser must not call Tauri `invoke` directly.

### 3.5 Existing Scripture UX to preserve

`src/components/BibleTab.tsx` already supports:

- Active Bible version selection.
- Reference search such as `John 3:16`.
- Ranges such as `John 3:16-18`.
- Chapter references such as `Psalm 23`.
- Keyword/semantic search.
- Chapter browsing.
- Preview.
- Stage.
- Go Live.
- Add to Service.
- Copy verse text.
- Stage Next Verse.
- Go Live Next Verse.

The remote MVP should provide the most useful parts of this flow in a simpler
mobile layout.

## 4. MVP Scope

### 4.1 Included

- Remote server lifecycle.
- QR pairing on the local network.
- Device token authentication.
- One remote controller lease.
- Read-only state snapshot.
- Live and staged previews.
- Scripture version selection.
- Scripture reference entry.
- Scripture keyword search.
- Chapter browsing.
- Verse detail preview.
- Stage verse.
- Go Live verse.
- Stage Next Verse.
- Go Live Next Verse.
- Add verse to service.
- Service queue view.
- Stage schedule item.
- Go Live staged item.
- Previous and Next item controls.
- Basic song search and staging.
- Basic lyrics-overlay control.
- Clear Live.
- Clear All with confirmation.
- Blackout with confirmation or press-and-hold.
- Reconnect and stale-state handling.
- Responsive phone, tablet, and desktop-browser UI.

### 4.2 Explicitly deferred

- Remote slide editing.
- Remote song editing.
- Remote media import.
- Remote settings editing.
- Service-plan reorder and deletion.
- Full scene management.
- Camera controls.
- Timer configuration.
- Presentation creation.
- Internet access or cloud accounts.
- Multi-operator concurrent control.
- Full chord-chart support.

## 5. Remote Architecture

```text
Phone / Tablet Browser
        |
        | HTTP for app assets and read requests
        | WebSocket for state and commands
        v
Rust Remote Server
        |
        v
Remote Session + Auth Layer
        |
        v
Shared Control Service
        |
        +--> PresentationState
        +--> BibleStore
        +--> MediaScheduleStore
        +--> Existing display/lower-third behavior
        |
        +--> Tauri events for local windows
        +--> Remote events for connected clients
```

### 5.1 Rust server

Add a remote module:

```text
src-tauri/src/remote/
  mod.rs
  server.rs
  protocol.rs
  auth.rs
  sessions.rs
  hub.rs
  snapshot.rs
  commands.rs
  assets.rs
```

Recommended dependencies:

```toml
axum
tower-http
rust-embed
```

Tokio, Serde, UUID, SHA-256, and async support already exist in the project.

### 5.2 Remote web bundle

Create a separate Vite entry point:

```text
remote.html
src/remote/main.tsx
src/remote/RemoteApp.tsx
src/remote/remoteClient.ts
src/remote/remoteStore.ts
src/remote/remoteProtocol.ts
src/remote/remote.css
```

The remote bundle must not import:

- `@tauri-apps/api/core`
- Tauri dialog plugins.
- Tauri filesystem plugins.
- Desktop-only window APIs.

It can share:

- TypeScript domain types.
- Display item types.
- Song and Bible utility functions.
- Shared semantic CSS tokens.
- Read-only preview components after they are separated from Tauri APIs.

The Rust server should serve the compiled remote assets from the application
bundle. Do not require Node, Vite, or a second development server in the
installed product.

## 6. Remote Security

### 6.1 Enablement

Remote Control must be disabled by default.

Settings should provide:

- Enable Remote Control.
- Disable Remote Control.
- Current server URL.
- Current port.
- QR pairing code.
- Connected devices.
- Revoke device.
- Revoke all devices.
- Regenerate pairing code.

When enabled, show a warning:

```text
Remote Control is available to devices on this local network.
Only enable it on a trusted network.
```

### 6.2 Pairing flow

1. Operator enables Remote Control.
2. Rust generates a random short-lived pairing token.
3. The UI displays a QR code containing the local URL and pairing token.
4. The remote opens the URL.
5. The remote sends the pairing token and a device name.
6. The operator approves the device.
7. Rust issues a long-lived device token.
8. The pairing token becomes invalid.
9. The browser stores the device token locally.

The pairing token must:

- Expire quickly.
- Be single-use.
- Be rate limited.
- Never be stored in plaintext after exchange.

Store only a hash of the long-lived device token.

### 6.3 Roles

| Role | Permissions |
|---|---|
| Viewer | Receive snapshot and watch live state |
| Operator | Scripture, stage, Go Live, queue, songs, lower thirds |
| Admin | Pair, revoke, disable remote, claim control |

The MVP may support Viewer and Operator first. Admin actions remain on the
desktop console if implementation time is limited.

### 6.4 Controller lease

Only one remote device should have mutating control at a time.

The desktop operator remains authoritative and can reclaim control.

Remote states:

```text
Viewing only
Requesting control
You have control
Control held by Main Console
Control held by iPad - Worship Leader
```

The lease should expire after inactivity, for example 10 minutes, and be
renewable through heartbeats.

## 7. Remote Protocol

Create shared protocol definitions in:

- `src/types/remote.ts`
- `src-tauri/src/remote/protocol.rs`

### 7.1 Command envelope

```ts
interface RemoteCommand {
  command_id: string;
  type: RemoteCommandType;
  payload?: unknown;
  expected_revision?: number;
}
```

Every mutating command must include a unique `command_id`.

### 7.2 Command result

```ts
interface RemoteCommandResult {
  command_id: string;
  ok: boolean;
  revision: number;
  error?: {
    code: string;
    message: string;
  };
}
```

### 7.3 Remote snapshot

```ts
interface RemoteSnapshot {
  protocol_version: number;
  revision: number;
  connected: boolean;
  role: "viewer" | "operator" | "admin";
  controller_device_id?: string;
  live_item: DisplayItem | null;
  staged_item: DisplayItem | null;
  active_service: ServiceMeta | null;
  schedule_entries: ScheduleEntry[];
  output_visible: boolean;
  blackout: boolean;
  lower_third: unknown | null;
  bible_versions: string[];
  active_bible_version: string;
  songs: RemoteSongSummary[];
}
```

Do not send the complete media library, all settings, or private filesystem
paths in the MVP snapshot.

### 7.4 Remote events

```text
snapshot
live.changed
staged.changed
schedule.changed
lower_third.changed
output.changed
blackout.changed
controller.changed
operator.notice
```

Every event includes:

```ts
{
  revision: number;
  timestamp: number;
  source_device_id?: string;
  payload: unknown;
}
```

The remote client must ignore events with a revision lower than its current
revision.

## 8. Scripture API For Remote MVP

The remote layer should expose safe API routes or WebSocket commands that map to
the current Bible store commands.

### 8.1 Read operations

```text
bible.versions
bible.books
bible.chapters
bible.verse_numbers
bible.chapter
bible.verse
bible.search
bible.next_verse
bible.previous_verse
```

Payload examples:

```json
{
  "version": "KJV",
  "book": "John",
  "chapter": 3,
  "verse": 16
}
```

Search example:

```json
{
  "query": "John 3:16-18",
  "version": "KJV"
}
```

Use the existing `search_semantic_query` path because it already supports
reference, range, chapter, and keyword search behavior.

### 8.2 Scripture mutation commands

Use semantic commands rather than allowing the browser to create arbitrary
display payloads:

```text
bible.preview
bible.stage
bible.go_live
bible.stage_next
bible.go_live_next
bible.stage_previous
bible.go_live_previous
bible.add_to_service
```

Example:

```json
{
  "type": "bible.stage",
  "payload": {
    "book": "John",
    "chapter": 3,
    "verse": 16,
    "version": "KJV"
  }
}
```

The backend resolves the verse using `BibleStore`, builds a `DisplayItem::Verse`,
and calls the shared stage operation.

### 8.3 Range behavior

For the MVP, display ranges as separate verse results.

Example:

```text
John 3:16
John 3:17
John 3:18
```

Each verse gets its own Preview, Stage, Go Live, and Add to Service actions.
Do not introduce a new range display item unless the existing output model is
explicitly extended and tested.

### 8.4 Scripture version behavior

- Show the active version in the remote header.
- Allow switching between available versions.
- Do not allow disabled versions from `PresentationSettings`.
- Persist version changes through the existing settings path only if the user
  confirms the version should become the desktop active version.
- For safer MVP behavior, keep remote version selection local to the remote
  session and include the version in every Bible command.

Recommended MVP: remote version selection is session-local. It should not
silently change the desktop operator's Bible version.

## 9. Remote UI/UX

### 9.1 Visual direction

The remote should feel like a premium control device rather than a compressed
desktop application.

Use:

- Dark blue-black foundation.
- Large calm surfaces.
- High-contrast text.
- Strong spacing.
- Rounded but restrained cards.
- Clear status strips.
- Minimal decorative color.
- Large touch-friendly actions.

Use these semantic colors:

- Cyan: staged/up next.
- Red: on air, blackout, clear, destructive.
- Amber: primary action and attention.
- Green: connected/success.
- Purple: presentation/design only.
- Teal: audio/music only.

### 9.2 Responsive breakpoints

Phone portrait, approximately 320-599px:

- One-column layout.
- Bottom navigation.
- One primary action per screen.
- Live and staged cards stacked vertically.
- Persistent connection status.

Tablet and phone landscape, approximately 600-1099px:

- Two-column control layout.
- Live and staged previews side by side when space allows.
- Bottom navigation remains available.

Desktop browser, 1100px and above:

- Left navigation rail.
- Main control area.
- Right emergency/status panel.
- Larger service queue visible alongside control cards.

Do not force the desktop three-panel layout onto a phone.

### 9.3 Touch targets

- Primary action: minimum 56px high.
- Secondary action: minimum 48px high.
- Icon button: minimum 48px square.
- Bottom navigation: minimum 64px high.
- Minimum readable text: 12px.
- Use `env(safe-area-inset-bottom)` for mobile browser controls.

### 9.4 Remote shell

```text
+----------------------------------+
| Wordlyte Remote       Connected  |
| Sunday Morning        Controller |
+----------------------------------+
|                                  |
|          Current workspace       |
|                                  |
+----------------------------------+
| Control | Scripture | Service    |
| Songs   | More                   |
+----------------------------------+
```

The top bar always shows:

- Connection status.
- Active service name.
- Current role.
- Controller ownership.

### 9.5 Control screen

```text
ON AIR
[large preview]
John 3:16 (KJV)

STAGED
[large preview]
John 3:17 (KJV)

[          GO LIVE          ]

[ Previous ]             [ Next ]
```

Rules:

- Live uses a red border and `ON AIR` label.
- Stage uses a cyan border and `STAGED` label.
- Go Live is disabled when no item is staged.
- Go Live shows a loading state during commit.
- Previous and Next operate on the current content type.
- The current verse reference is always readable.

### 9.6 Scripture screen

The Scripture screen should have three modes:

```text
Reference | Search | Browse
```

#### Reference mode

```text
Bible version: KJV

[ John 3:16                         ]
[ Find Reference ]
```

Accept:

- `John 3:16`
- `John 3:16-18`
- `Psalm 23`
- Common abbreviated book names where the backend already supports them

After lookup:

```text
John 3:16  KJV
For God so loved the world...

[Preview] [Stage] [Go Live] [Queue]
```

#### Search mode

```text
[ Search by topic or phrase             ]
[ Search ]

Strong match
John 3:16
For God so loved the world...
[Preview] [Stage] [Go Live]
```

Show readable match labels, not raw scores.

#### Browse mode

```text
Book       John v
Chapter    3 v

1  2  3  4  5  6  7
```

Selecting a chapter loads the verse list. Each verse row supports:

- Tap to preview.
- Stage.
- Go Live.
- Queue.
- Copy.

### 9.7 Scripture verse detail

Open a bottom sheet or detail panel for a selected verse:

```text
John 3:16
KJV

For God so loved the world, that he gave his only begotten Son...

[Preview]
[Stage]
[Go Live]
[Add to Service]

Previous verse       Next verse
```

The detail panel should preserve the selected chapter context.

### 9.8 Bible control strip

When a verse is staged or live, show a compact control strip:

```text
John 3:16  KJV       16 / 36

[Stage Next Verse] [Go Live Next Verse]
```

The next action must use the authoritative active version and chapter context.

### 9.9 Service screen

```text
Sunday Morning

ON AIR
John 3:16

STAGED
Welcome Slide

QUEUE
1  Welcome
2  John 3:16
3  Amazing Grace
4  Sermon Scripture
```

Each item may provide:

- Preview.
- Stage.
- Go Live.

Keep reordering and deleting out of the first MVP unless the existing schedule
API is extended with safe revision handling.

### 9.10 Songs screen

The remote MVP song screen should support:

- Search My Songs.
- Search Hymns.
- Preview first/current section.
- Select full-screen or lyrics-overlay mode.
- Stage.
- Go Live.
- Next and Previous.

Do not expose song editing on the phone.

### 9.11 Emergency screen

Put emergency controls under a separate screen or expandable section:

```text
Emergency Controls

[ Clear Live ]
[ Blackout ]
[ Clear All ]
```

Rules:

- Clear Live is a visible destructive action.
- Blackout requires press-and-hold for 800ms or a confirmation.
- Clear All requires a modal listing live, staged, lower-third, and props.
- If undo is available, show `Undo` immediately after success.

## 10. State Synchronization

### 10.1 Initial connection

1. Remote authenticates.
2. Server sends `snapshot`.
3. Remote stores snapshot and revision.
4. Remote enables commands only after hydration.

### 10.2 Normal event flow

```text
Desktop or remote command
  -> Rust mutates authoritative state
  -> Rust emits local Tauri event
  -> Rust publishes remote event
  -> Remote updates snapshot
  -> Remote displays acknowledgement
```

### 10.3 Reconnect

On reconnect:

- Clear any pending optimistic state.
- Request a fresh snapshot.
- Replace local remote state with the snapshot.
- Display `Synchronized`.
- Re-enable mutating controls.

Never replay old mutating commands automatically after reconnect.

### 10.4 Stale state

If the remote misses events or has not received an update for a timeout:

- Mark the UI `State may be out of date`.
- Disable Go Live, Clear All, and Blackout.
- Allow a manual refresh.
- Keep read-only previews visible.

## 11. Implementation Phases

### Phase 0: Protocol and safety contract

Tasks:

- Document local-network threat model.
- Define pairing, roles, controller lease, and revocation.
- Define command and event envelopes.
- Define snapshot schema.
- Define revision and conflict behavior.
- Create JSON fixtures for snapshot, commands, results, and errors.

Files:

- New `src/types/remote.ts`.
- New `src-tauri/src/remote/protocol.rs`.
- New protocol fixture files under `src/remote/__fixtures__/`.

Acceptance criteria:

- Protocol version is explicit.
- No command can mutate state without authentication and authorization.
- Stale revisions produce a predictable error.

### Phase 1: Rust remote server and pairing

Tasks:

- Add Axum/Tower HTTP and WebSocket server.
- Add embedded remote asset serving.
- Add server start/stop lifecycle.
- Add random port selection.
- Add pairing code generation.
- Add hashed device token storage.
- Add WebSocket heartbeat.
- Add device sessions.
- Add initial snapshot delivery.
- Add pairing status to backend logs.

Files:

- `src-tauri/Cargo.toml`.
- `src-tauri/src/main.rs`.
- `src-tauri/src/state.rs`.
- New `src-tauri/src/remote/*.rs`.

Acceptance criteria:

- Remote is disabled by default.
- Pairing works from a phone on the same LAN.
- Invalid tokens are rejected.
- Revoked tokens are rejected.
- Desktop application remains usable when no remote is connected.

Verification:

```bash
cd src-tauri
cargo check
cargo clippy
cargo test
```

### Phase 2: Read-only snapshot and event bridge

Tasks:

- Build authoritative remote snapshot from AppState and stores.
- Add live, staged, lower-third, service, and output state.
- Add Bible versions and active version.
- Add song summaries.
- Broadcast remote events after successful backend mutations.
- Add revision counter.
- Add event ordering rules.

Files:

- New `src-tauri/src/remote/snapshot.rs`.
- New `src-tauri/src/remote/hub.rs`.
- `src-tauri/src/commands/display.rs`.
- `src-tauri/src/commands/lower_third.rs`.
- `src-tauri/src/commands/schedule.rs`.
- `src-tauri/src/commands/bible.rs`.

Acceptance criteria:

- Remote receives current live and staged state immediately after pairing.
- Local operator changes appear on the remote.
- Remote reconnect receives a fresh snapshot.
- Lower-third null/clear events are represented correctly.

### Phase 3: Responsive remote shell

Tasks:

- Add Vite remote entry point.
- Add connection screen.
- Add pairing screen.
- Add responsive navigation.
- Add Control, Scripture, Service, Songs, and More screens.
- Add semantic status badges.
- Add mobile safe-area support.
- Add keyboard focus and accessible labels.
- Add loading, offline, stale, and error states.

Files:

- `vite.config.ts`.
- `index.html` or new `remote.html`.
- New `src/remote/main.tsx`.
- New `src/remote/RemoteApp.tsx`.
- New `src/remote/remoteClient.ts`.
- New `src/remote/remoteStore.ts`.
- New `src/remote/remote.css`.

Acceptance criteria:

- Phone portrait is usable one-handed.
- Tablet landscape shows live and staged information together.
- Desktop browser has a wider service-control layout.
- No critical action relies on hover.
- Controls remain usable at browser zoom and Windows scaling.

### Phase 4: Bible MVP

Tasks:

- Add remote Bible version loading.
- Add reference entry.
- Add reference parsing through the existing backend search behavior.
- Add keyword/semantic search.
- Add readable match labels.
- Add books, chapters, and verse-number browsing.
- Add chapter verse list.
- Add verse detail view.
- Add local preview.
- Add Stage.
- Add Go Live.
- Add Add to Service.
- Add Stage Next Verse.
- Add Go Live Next Verse.
- Add Previous Verse.
- Add Copy Verse.
- Add loading and failure state per request.

Remote API handlers should call the existing BibleStore methods rather than
duplicating SQL or parsing logic in the browser.

Required Bible behaviors:

- Search `John 3:16` returns a reference result.
- Search `John 3:16-18` returns separate verse results.
- Search `Psalm 23` opens chapter results.
- Keyword search returns results with match labels.
- Switching version changes subsequent searches and lookups.
- Stage never commits live.
- Go Live performs stage-then-commit safely.
- Next Verse uses the selected chapter/version context.
- No result shows a raw backend score as the primary label.

Suggested remote components:

```text
src/remote/bible/
  BibleScreen.tsx
  BibleReferenceInput.tsx
  BibleSearchResults.tsx
  BibleBrowsePanel.tsx
  VerseDetailSheet.tsx
  VerseActionBar.tsx
  BibleVersionPicker.tsx
```

Required tests:

- Reference search request shape.
- Keyword search request shape.
- Version selection.
- Chapter loading.
- Verse detail loading.
- Preview does not broadcast.
- Stage builds the correct Verse display item.
- Go Live does not commit after stage failure.
- Next and previous use the correct book, chapter, verse, and version.
- Search error remains visible and recoverable.

### Phase 5: Remote service and live controls

Tasks:

- Add service summary and queue.
- Add schedule item preview.
- Add Stage queue item.
- Add Go Live staged item.
- Add Next and Previous current-item controls.
- Add Clear Live.
- Add Clear All confirmation.
- Add Blackout confirmation/hold behavior.
- Add controller lease checks.
- Add command loading states.

Acceptance criteria:

- Remote and desktop show the same live item.
- Remote and desktop show the same staged item.
- A stale remote cannot send live.
- Clear All explains all affected layers.
- Disconnecting the remote does not affect output.

### Phase 6: Songs and lyrics overlay

Tasks:

- Add song summaries to snapshot.
- Add remote song search.
- Add song preview.
- Add full-screen/overlay mode selection.
- Add Stage and Go Live.
- Add current and next song section.
- Add lower-third current line and next line.
- Add Show Overlay and Hide Overlay.
- Reuse the canonical song sequence utility.

Do not add song editing to the remote MVP.

Acceptance criteria:

- Full-screen songs preserve their display mode through stage and commit.
- Overlay songs preserve their display mode through stage and commit.
- Song navigation follows the saved arrangement.
- Lower-third failures are visible.

### Phase 7: Hardening and device management

Tasks:

- Add connected-device list.
- Add revoke device.
- Add revoke all.
- Add controller reclaim.
- Add pairing regeneration.
- Add command rate limits.
- Add payload limits.
- Add audit log entries.
- Add protocol version rejection.
- Add duplicate command protection.
- Add stale-state timeout.
- Add optional TLS/WSS design decision.

Acceptance criteria:

- Revoke takes effect without restarting Wordlyte.
- Duplicate Go Live commands do not cause duplicate transitions.
- Invalid payloads never reach display commands.
- All remote mutations have a source device in logs.

## 12. Correctness Rules

### 12.1 Preview

Preview may:

- Load Bible data.
- Load song data.
- Render local previews.
- Navigate current preview content.

Preview may not:

- Call `stage_item`.
- Call `commit_staged`.
- Call `show_lower_third`.
- Call `hide_lower_third`.
- Call `clear_all`.
- Change output visibility.

### 12.2 Stage

Stage must:

- Validate the command.
- Resolve authoritative content.
- Replace the staged item only after validation.
- Emit staged state.
- Return success only after the backend mutation completes.

Stage failure must preserve the previous staged item.

### 12.3 Go Live

Go Live must:

- Require a current staged item.
- Check controller ownership.
- Check revision if supplied.
- Commit atomically.
- Broadcast live state.
- Return the authoritative committed item.

Never let a remote Go Live command directly select an arbitrary item and bypass
staging.

### 12.4 Clear All

Clear All affects:

- Live item.
- Staged item.
- Lower third.
- Props.

The remote confirmation must list those layers before execution.

### 12.5 Bible version isolation

The remote's selected Bible version should be included in every lookup and
display command. Do not depend only on a global active version that another
operator can change.

## 13. Testing Strategy

### 13.1 Rust unit tests

Add tests for:

- Pairing token generation and expiration.
- Token hashing.
- Device revocation.
- Role authorization.
- Controller lease.
- Revision conflict.
- Duplicate command id.
- Snapshot serialization.
- Remote Bible request validation.
- Bible reference search delegation.
- Verse resolution.
- Next/previous verse resolution.
- Stage command failure recovery.
- Clear All event fan-out.

### 13.2 Frontend remote tests

Add tests under:

```text
src/remote/__tests__/
  remoteClient.test.ts
  remoteStore.test.ts
  RemoteApp.test.tsx
  BibleScreen.test.tsx
  ControlScreen.test.tsx
```

Test:

- Connecting.
- Pairing.
- Snapshot hydration.
- Event revision ordering.
- Reconnect.
- Stale state.
- Bible search.
- Reference lookup.
- Chapter browse.
- Verse preview.
- Stage.
- Go Live.
- Stage Next Verse.
- Clear All confirmation.
- Controller lock.
- Mobile navigation.
- Keyboard accessibility.

### 13.3 Existing application tests

Run the existing transactional tests to ensure remote integration did not break
the desktop flow:

```bash
npm run test
```

Pay particular attention to:

- Stage failure.
- Live transitions.
- Clear propagation.
- Output-window synchronization.
- Service persistence.

### 13.4 Manual network matrix

| Area | Checks |
|---|---|
| Pairing | QR, manual code, invalid token, expired token |
| Devices | Revoke, reconnect, second viewer, controller reclaim |
| Network | Same Wi-Fi, weak Wi-Fi, disconnect, reconnect |
| Bible | Reference, range, chapter, keyword, version switch |
| Bible actions | Preview, Stage, Go Live, Next, Previous, Queue |
| Live | Stage, Go Live, Clear Live, Clear All, Blackout |
| Queue | Preview, Stage, Go Live, Next, Previous |
| Songs | Search, preview, full-screen, overlay, next/previous |
| Failure | Backend error, stale state, revision conflict |
| Windows | Main, output, and stage update together |
| Layout | Phone portrait, phone landscape, tablet, desktop browser |
| Scaling | Browser zoom 80-200%, Windows 100-150% |
| Accessibility | Keyboard, focus, labels, touch targets |

## 14. Build and Verification Commands

For frontend changes:

```bash
npm run test
npm run build
```

For Rust/Tauri changes:

```bash
npm run build
cd src-tauri
cargo check
cargo clippy
cargo test
```

Before completing the MVP, also verify the production app manually with:

```bash
npm run tauri dev
```

The agent must record:

- Device used.
- Network used.
- Main computer IP and port.
- Pairing result.
- Test results.
- Any skipped checks.

## 15. AI Agent Execution Protocol

The implementation agent must:

1. Read `CLAUDE.md` before editing.
2. Inspect current `git status` and `git diff` before each phase.
3. Never revert unrelated user changes.
4. Preserve existing Tauri command names and event names.
5. Use `apply_patch` for manual edits.
6. Add protocol fixtures before implementing UI assumptions.
7. Keep Rust authoritative for remote state and live commands.
8. Never duplicate stage/live logic in the remote browser.
9. Add tests for each new command and state transition.
10. Run frontend tests and build after every frontend phase.
11. Run Rust checks after every Rust or Tauri phase.
12. Verify mobile and desktop layouts before marking UI complete.
13. Review the diff for unrelated changes.
14. Report limitations and skipped network tests explicitly.

## 16. Definition Of Done

The remote-control MVP is complete when:

- Remote Control is disabled by default.
- Pairing works using QR and a one-time token.
- Revoked devices cannot reconnect.
- A paired remote receives a complete state snapshot.
- Live and staged state update in real time.
- Scripture reference lookup works.
- Scripture keyword search works.
- Chapter browsing works.
- Verse preview works.
- Verse Stage works.
- Verse Go Live works transactionally.
- Next and Previous Verse work.
- Add to Service works through the shared schedule path.
- Songs and lower-third lyrics have basic remote control.
- Clear Live, Clear All, and Blackout are clearly separated.
- Stale remotes cannot send live.
- Disconnecting the remote does not alter output.
- The UI is responsive on phone, tablet, and desktop browser.
- Touch targets and text are readable.
- Keyboard focus and accessible names exist.
- Existing desktop live-action tests pass.
- Remote frontend tests pass.
- Rust tests pass.
- `npm run build` passes.
- Manual network verification is recorded.

## 17. Recommended First Build Slice

Start with this narrow but complete vertical slice:

1. Add Rust WebSocket server with pairing disabled by default.
2. Implement authenticated read-only snapshot.
3. Build the responsive remote shell.
4. Add Scripture version selection.
5. Add `John 3:16` style reference lookup.
6. Add verse preview.
7. Add Stage Verse.
8. Add Go Live Verse.
9. Broadcast live/staged updates back to the remote.
10. Add reconnect and stale-state handling.

Only after this slice works end to end should the agent add chapter browsing,
semantic search, service queue, songs, and emergency controls.

This approach proves the most important path first: a remote device can safely
find Scripture, preview it, stage it, send it live, and remain synchronized with
the main Wordlyte console.
