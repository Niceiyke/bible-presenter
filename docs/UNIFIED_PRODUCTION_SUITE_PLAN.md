# Unified Production Suite Implementation Plan

Status: implementation plan
Audience: coding agents and maintainers
Scope: turn Wordlyte into a reliable, simple, church-focused production suite

This document is an implementation plan, not a feature wishlist. Every phase
must leave the application buildable and usable. Agents must implement one
phase or one vertical slice at a time, run the verification commands for that
slice, and update this document and `CLAUDE.md` when a contract changes.

## 1. Product Goal

Wordlyte should provide one simple service workflow for churches:

```text
Prepare content and service plan
        -> Stage and preview
        -> Take content live
        -> Control scenes, cameras, lyrics, timers, and overlays
        -> Send the same program to projection, stage, recording, and streaming
        -> Recover safely from device, network, or storage failures
```

The product is a church-first unified production suite. It is not required to
implement every advanced broadcast feature. It must make the common church
workflow reliable and easy before adding advanced features.

### 1.1 Initial supported production scope

The supported core must include:

- Bible lookup, Bible versions, and Scripture presentation.
- Songs, lyrics, hymn library, and service plans.
- Custom slides and slide templates.
- Images, videos, and audio media.
- Basic local camera sources.
- Phone camera sources over the existing remote-control connection.
- Scene compositions with multiple zones.
- Timers, logos, props, and lower thirds.
- Projection output and stage/confidence output.
- Local recording.
- One or more streaming destinations.
- Remote operation with pairing, permissions, and one active controller.
- Recovery after a window restart, output failure, or temporary network failure.

### 1.2 Explicit non-goals for the first unified release

Do not block the first reliable release on:

- Full NDI input and output.
- Advanced replay or clip servers.
- Complex multi-room routing.
- Full digital audio console features.
- Arbitrary third-party plugin execution.
- Distributed multi-computer rendering.
- Automatic cloud synchronization of all church content.

These may be added later because the architecture below provides extension
points for them. They must not create special cases in the core broadcast
engine.

## 2. Current Problems To Resolve

The current repository has useful foundations, but the following problems must
be treated as architectural work, not isolated bug fixes.

### 2.1 Two output renderers are not equivalent

The projection path primarily uses DOM renderers in
`src/windows/OutputWindow.tsx` and `src/components/shared/Renderers.tsx`.
Recording and streaming use the canvas path in
`src/components/outputs/ProgramFeedCanvas.tsx` and
`src/components/outputs/canvasProgramFeed.ts`.

Rich text, animations, lower thirds, media playback, and audio can differ
between those paths. The operator can therefore see a result that is not the
same as the recorded or streamed result.

### 2.2 The Output Manager is currently mostly a registry

`src-tauri/src/outputs.rs` persists output configuration and runtime status, but
recording and streaming lifecycles are still primarily owned by React hooks and
workspace components. Window outputs already resolve `presentation` overrides and
overlay masks (`OutputWindow.tsx`, `StageWindow.tsx`), but the canvas path used by
recording and streaming (`ProgramFeedPreview.tsx`) ignores both, so resolution is
still not consistent across every output. Recording already survives tab
navigation through the App-level `RecordingProvider`, but streamer lifecycles
still live in workspace components.

### 2.3 Presentation mutations are split across multiple services

The live/stage helpers in `src-tauri/src/remote/commands.rs` use a presentation
lock, while settings, props, and scene application have separate mutation
paths. A scene can therefore be persisted or published as several operations
instead of one authoritative transaction.

### 2.4 Revision metadata is not enforced everywhere

The backend emits presentation revisions, but windows and some event consumers
apply payloads without rejecting an older revision. Hydration and live events
must use one consistent revision rule.

### 2.5 The Bible asset lifecycle is incomplete

The Bible database is opened during backend startup. After downloading the
database, the current process does not replace the open `BibleStore`; the UI
reload is only a frontend reload. A fresh install should become usable without
restarting the application process.

### 2.6 Streaming currently duplicates encoding work

Each streaming destination creates its own WebCodecs encoder and IPC feed
(`DestinationCard` mounts `useRtmpEncoder`/`useStreamer`/`useNdiSender` per
destination). The compositor feed is captured once and cloned, but the encode is
repeated per destination. The target architecture must encode the program once
and distribute encoded packets to compatible destinations.

### 2.7 Persistence needs explicit transaction and recovery rules

The application uses SQLite, JSON files, and temporary-file replacement. These
paths need Windows-safe atomic replacement, serialized writes, schema versions,
and visible recovery errors.

## 3. Target Architecture

The target architecture has six layers. Each layer has one responsibility.

```text
Content and Service Layer
  Bible, songs, media, presentations, scenes, services
                |
                v
Broadcast Engine
  live/staged state, scene application, overlays, revisions, commands
                |
                v
Source and Program Layer
  source registry, scene graph, resolved ProgramFrame, audio policy
                |
                v
Compositor and Transport Layer
  one visual compositor, one encoder pipeline, packet/audio distribution
                |
                v
Output Layer
  projection, stage, recorder, RTMP, WHIP, future NDI/SRT
                |
                v
Control Clients
  operator UI, remote UI, keyboard, automation, diagnostics
```

The operator UI and remote UI are clients. They do not become alternative
owners of live state.

### 3.1 Broadcast Engine

Create a backend module at `src-tauri/src/engine/`.

The engine owns:

- The current live item.
- The current staged item.
- The previous live item.
- Active scene and scene composition state.
- Presentation settings relevant to output.
- Props and lower-third state.
- Blackout and emergency state.
- A monotonic presentation revision.
- The serialized mutation lock.
- The authoritative event publication path.

The engine exposes commands, not mutable fields. All callers use the same
commands.

Required command families:

```text
stage(item)
take_staged_live()
send_live(item)
clear_live()
clear_staged()
clear_all()
apply_scene(scene_id)
set_settings(settings_patch)
set_props(props)
show_lower_third(payload)
hide_lower_third()
set_blackout(enabled)
update_timer(timer_update)
get_snapshot()
```

Existing Tauri commands map directly onto these families (`stage_item`,
`commit_staged`, `go_live`, `clear_all`, `apply_scene`, `save_settings`,
`update_timer`). `set_blackout` is a consolidation of the current desktop
`save_settings({ is_blanked })` path and the remote `display.blackout` protocol
command, not a net-new capability.

Each mutating command must:

1. Acquire the engine mutation lock.
2. Validate license, item references, and required resources.
3. Build the complete next state in memory.
4. Persist required durable state transactionally.
5. Commit the in-memory state.
6. Increment the revision once for the logical operation.
7. Publish one authoritative event containing the resulting state or delta.
8. Return the resulting snapshot or affected object to the caller.

No caller may mutate `PresentationState` directly after this migration.

### 3.2 Presentation snapshot contract

Define a typed snapshot shared by Rust and TypeScript. It should be versioned
and should contain complete presentation-critical state.

```ts
interface PresentationSnapshot {
  schema_version: number;
  revision: number;
  live: DisplayItem | null;
  staged: DisplayItem | null;
  previous: DisplayItem | null;
  settings: PresentationSettings;
  props: PropItem[];
  lower_third: LowerThirdPayload | null;
  blackout: boolean;
  active_scene_id: string | null;
  updated_at: number;
}
```

`active_scene_id` is a new field introduced by this migration. Today a live scene
is just the `DisplayItem::SceneComposition` in the live slot with no separate
backend "active scene" state; the migration adds an explicit active-scene id
while keeping the live slot for content.

The first migration may continue to use full `DisplayItem` values. Later, large
items may be changed to references plus resolved payloads. That migration must
be additive and must preserve old saved services.

### 3.3 Source registry

Create a source abstraction that is independent from React component lifecycles.

```ts
type SourceKind =
  | "media"
  | "local_camera"
  | "phone_camera"
  | "slide"
  | "bible"
  | "song"
  | "timer"
  | "screen"
  | "color"
  | "future_network";

interface SourceDescriptor {
  id: string;
  kind: SourceKind;
  label: string;
  capabilities: {
    video: boolean;
    audio: boolean;
    navigation: boolean;
  };
}
```

Source lifecycle must provide:

```text
discover()
connect(source_id)
disconnect(source_id)
get_status(source_id)
get_video_track(source_id)
get_audio_track(source_id)
```

Renderers must never call `getUserMedia` directly. They request a source from
the source registry. This prevents duplicate camera streams and allows future
capture devices, phone cameras, and network sources to behave consistently.

### 3.4 Scene graph

Scenes must become a general composition graph, not only a saved bundle of
settings and props.

```ts
interface SceneComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  zones: SceneZone[];
  audio_bus?: string;
}

interface SceneZone {
  id: string;
  source: SourceBinding;
  rect: { x: number; y: number; width: number; height: number };
  crop?: { x: number; y: number; width: number; height: number };
  fit: "contain" | "cover" | "fill";
  z_index: number;
  visible: boolean;
  style?: ZoneStyle;
}
```

`SourceBinding` must support static content and dynamic classes:

```ts
type SourceBinding =
  | { type: "fixed_item"; item: DisplayItem }
  | { type: "live_class"; class: "verse" | "song" | "slide" | "media" | "camera" | "timer" }
  | { type: "source"; source_id: string };
```

The existing pinned-zone behavior should be migrated into this model rather
than expanded with more special-case conditionals.

### 3.5 ProgramFrame

Create one resolved frame model. An output never independently reconstructs
live state.

```ts
interface ProgramFrame {
  revision: number;
  timestamp: number;
  canvas: { width: number; height: number; fps: number };
  scene: SceneComposition | null;
  layers: ProgramLayer[];
  background: ResolvedBackground;
  overlays: {
    props: PropItem[];
    lower_third: LowerThirdPayload | null;
    logo: LogoState | null;
  };
  blackout: boolean;
  audio: AudioProgramDescriptor;
}
```

The `ProgramFrameResolver` must:

1. Resolve the configured output source.
2. Apply output presentation overrides.
3. Apply output overlay masks.
4. Resolve scene zones and source bindings.
5. Resolve media paths safely.
6. Report missing source resources.
7. Produce the same frame for projection, stage preview, recording, and stream.

### 3.6 Compositor strategy

Use a shared declarative scene graph and a single authoritative compositor for
production output.

The recommended order is:

1. Keep DOM previews for operator editing and accessibility.
2. Make the compositor renderer feature-complete for production output.
3. Add fixture-based parity tests between expected frame data and rendered
   compositor output.
4. Do not add a new visual feature unless it is represented in the shared
   scene graph and supported by the production compositor.

The compositor must support:

- Text with the same style rules as slides.
- Images and video.
- Shapes.
- Backgrounds.
- Scenes and zones.
- Lower thirds.
- Props.
- Logos.
- Timers.
- Blackout.
- Transitions.
- Safe missing-media fallback.

### 3.7 Output runtime

Extend `OutputManager` into a lifecycle coordinator. Configuration and runtime
status must remain separate.

```ts
interface OutputRuntime {
  start(config: OutputConfig): Promise<void>;
  stop(reason?: string): Promise<void>;
  apply(config: OutputConfig): Promise<void>;
  get_status(): OutputState;
}
```

Output types:

```text
window_projection
window_stage
window_overflow
recorder
stream_whip
stream_rtmp
stream_ndi
stream_srt_future
```

`stream_ndi` builds on the existing SDK-gated NDI scaffold
(`src-tauri/src/commands/ndi.rs` behind the `ndi` cargo feature and
`src/hooks/useNdiSender.ts`) rather than starting from scratch.

Each output must subscribe to `ProgramFrame` and must never write to the
broadcast engine. A failed output may report an error and stop itself, but it
must not clear or alter live content.

### 3.8 Audio architecture

Add a basic audio graph owned by one application-level provider, not by each
destination card.

```ts
interface AudioSource {
  id: string;
  kind: "input" | "media" | "microphone" | "line_in";
  label: string;
  enabled: boolean;
  volume: number;
  muted: boolean;
}

interface AudioBus {
  id: string;
  sources: string[];
  volume: number;
  muted: boolean;
}
```

The first audio release needs:

- Input-device selection.
- Per-source volume and mute.
- Program mix selection.
- Independent monitor mute.
- Audio permission and device-loss errors.
- Audio/video synchronization metadata.

Use Web Audio and shared `MediaStreamTrack` objects inside the application. Do
not send raw audio samples through Tauri IPC. The existing RTMP audio path
(`rtmp_send_audio` -> backend loopback TCP -> ffmpeg ADTS input) predates this
graph and must be migrated onto the shared audio bus in Phase 6 so the app does
not keep two audio pipelines.

### 3.9 Recording and streaming transport

The visual program must be encoded once per configured profile.

```text
ProgramFrame compositor
        -> one video encoder
        -> encoded packet bus
        -> recorder writer
        -> RTMP muxer 1
        -> RTMP muxer 2
        -> WHIP sender
        -> future NDI/SRT sender
```

The packet bus must include:

- Codec description.
- Width and height.
- Frame rate.
- Keyframe markers.
- Presentation timestamps.
- Monotonic sequence number.
- Dropped-packet counters.

The backend transport must report:

- Connecting.
- Live.
- Reconnecting.
- Stopped.
- Failed.
- Bytes sent.
- Packets dropped.
- Last error.
- Process exit code.

### 3.10 Remote control

Remote control must call the same engine commands as the desktop UI. It must
not duplicate scene, live, or overlay mutation logic.

Required improvements:

- Publish permission changes to the affected device immediately.
- Apply revision checks to every mutation.
- Rate-limit expensive read operations as well as mutation operations.
- Keep camera signaling as a transport concern, separate from camera source
  registration.
- Keep pairing and device secrets hashed or protected.
- Add an operator-visible trust and certificate explanation.

## 4. Backend Module Layout

Create the following target structure incrementally:

```text
src-tauri/src/
  engine/
    mod.rs
    state.rs
    commands.rs
    snapshot.rs
    events.rs
    validation.rs
  sources/
    mod.rs
    registry.rs
    local_camera.rs
    phone_camera.rs
    media.rs
  compositor/
    mod.rs
    frame.rs
    resolver.rs
    capabilities.rs
  outputs/
    mod.rs
    manager.rs
    config.rs
    state.rs
    window.rs
    recorder.rs
    streaming.rs
  audio/
    mod.rs
    graph.rs
    devices.rs
  transport/
    mod.rs
    packet_bus.rs
    rtmp.rs
    whip.rs
  persistence/
    mod.rs
    migrations.rs
    atomic_file.rs
    transactions.rs
```

Existing modules may be moved only when tests preserve behavior. Do not create
duplicate `engine` and `remote` implementations. Move shared operations into
the engine, then make Tauri commands and remote commands thin adapters.

## 5. Frontend Module Layout

Create these frontend boundaries:

```text
src/
  broadcast/
    types.ts
    useBroadcastSnapshot.ts
    useBroadcastCommands.ts
    revisionGuard.ts
  sources/
    sourceRegistry.ts
    useSources.ts
    useCameraSource.ts
  compositor/
    ProgramFrame.ts
    ProgramFrameResolver.ts
    ProgramCompositor.tsx
    renderers/
  outputs/
    useOutputManager.ts
    OutputRuntime.ts
    outputAdapters/
  audio/
    AudioGraphProvider.tsx
    useAudioGraph.ts
  transport/
    usePacketBus.ts
    useStreamTransport.ts
```

`src/components/outputs/` (`ProgramFeedCanvas`, `canvasProgramFeed`,
`ProgramFeedPreview`) is the baseline for the `compositor/` boundary above.
Phase 3 must extend or relocate that code, not create a second canvas compositor.

Existing workspace components remain responsible for UI presentation and
editing. They must call `useBroadcastCommands()` rather than invoking display
commands directly.

## 6. Implementation Phases

### Phase 0: Baseline and contract freeze

Tasks:

- Add this plan to project documentation.
- Record current event names, command names, persisted files, and schema
  versions.
- Add a `schema_version` field to presentation snapshots and output configs.
- Add tests for current stage, live, clear, scene, and output behavior before
  moving code.
- Add a test fixture directory for representative Bible, song, slide, media,
  camera, timer, scene, and lower-third frames.
- Mark unfinished Design Hub, Audio Studio, and NDI features as experimental or
  hide them from the default operator navigation.

Acceptance criteria:

- `npm run build` passes.
- `npm run test` has no new failures.
- `cargo check` passes.
- Existing persisted data can still load.
- A written event and command inventory exists.

### Phase 1: Broadcast Engine extraction

Tasks:

- Create `src-tauri/src/engine/`.
- Move live/stage/clear/overlay/settings/props mutations into engine commands.
- Make `display.rs`, `props.rs`, `lower_third.rs`, `scenes.rs`, and remote
  commands call the engine.
- Remove direct writes to `state.presentation` from command adapters.
- Make scene application one logical transaction.
- Return `PresentationSnapshot` from every mutating command.
- Emit one event with one revision per logical mutation.
- Preserve old Tauri command names as thin adapters during migration.

Acceptance criteria:

- Desktop and remote calls cannot interleave stage and take-live operations.
- `clear_all` clears live, staged, props, and lower thirds atomically.
- Scene application either fully succeeds or leaves the previous state intact.
- All mutation tests cover success and persistence failure.

### Phase 2: Snapshot and revision synchronization

Tasks:

- Add revision fields to every presentation event.
- Add a frontend revision guard shared by main, stage, and output windows.
- Apply a snapshot only if its revision is not older than the local revision.
- Buffer events during hydration and replay only newer events.
- Replace untyped critical event payloads with shared TypeScript types.
- Add stale-event tests for every window.

Acceptance criteria:

- A stale event cannot overwrite a newer live, staged, settings, props, or
  lower-third state.
- A window that closes and reopens converges to the current snapshot.
- Null clear payloads always remove stale local state.

### Phase 3: ProgramFrame and compositor parity

Tasks:

- [x] Define `ProgramFrame` and `ProgramLayer` types in TypeScript and Rust where
  serialization is required. (Implemented in `src/compositor/ProgramFrame.ts`.
  TypeScript only today — the frame is not persisted and never crosses IPC, so
  no Rust mirror is required yet.)
- [x] Implement `ProgramFrameResolver` from `OutputConfig` plus the authoritative
  snapshot. (`src/compositor/ProgramFrameResolver.ts` — pure
  `resolveProgramFrame`.)
- [x] Resolve output source, output overrides, overlays, scene zones, and blackout.
- [x] Move all production visual features into the shared compositor renderer.
  (The canvas compositor is complete for every DisplayItem + overlay. The DOM
  outputs `OutputWindow`/`StageWindow` now resolve the SAME `ProgramFrame` via
  `resolveProgramFrame` — consuming its colors, effective background, blackout,
  masked overlays, and resolved source — so the DOM renderers draw from the
  frame instead of re-deriving presentation state. The DOM renderers themselves
  remain authoritative for rich text and animations.)
- [x] Add a shared lower-third renderer model rather than separate simplified data
  paths. (`resolveLowerThird` in `src/compositor/LowerThirdResolver.ts` is the
  single normalized descriptor — content→style slots, background, accent,
  border/shadow/outline tokens, geometry, animation, scroll — consumed by BOTH
  the canvas `drawLowerThird` and the DOM `LowerThirdOverlay`, so they can no
  longer drift apart. The canvas path gained the kicker slot, slot mapping,
  borders, box shadows, and text outlines it was missing.)
- [x] Add fixture tests for each DisplayItem type and each overlay combination.
  (`src/compositor/__tests__/ProgramFrameResolver.test.ts`; the Phase 0
  fixture suite in `src/test/fixtures/` now draws resolved `ProgramFrame`s.)
- [x] Add a missing-media fallback that renders a safe frame and reports an error.
  (`drawMissingPanel` + `CanvasResources.failedPaths` +
  `ProgramFeedCanvas.onMissingMedia`.)

Acceptance criteria:

- [x] Projection, stage preview, recording preview, and streaming preview resolve
  the same `ProgramFrame`. (`OutputWindow` and `StageWindow` resolve through
  `resolveProgramFrame` exactly like `ProgramFeedPreview`/`ProgramFeedCanvas`;
  fixture + resolver test suites cover the resolution logic.)
- [x] Output-specific overlay masks work.
- [x] `staged`, `item`, `scene`, and `blank` output sources work.
- [ ] Rich text, animation state, media, timers, props, and lower thirds have
  documented compositor behavior. (Media, timers, props, lower thirds, and
  scene zones are documented; rich text/ProseMirror approximation and
  animation behavior are the follow-up.)

### Phase 4: Real Output Manager lifecycle

Tasks:

- [x] Split `OutputConfig` from `OutputState` completely. (`OutputState` gained
  the lifecycle fields — `phase` ∈ configured/starting/live/stopping/failed/
  stopped, `reason`, `started_at` — in `src-tauri/src/outputs.rs` + the mirror
  in `src/types/output.ts`. Windows derive their phase from visibility;
  recorder/streamer adapters report transitions through the new
  `report_output_state` command. `started_at` is owned by the backend
  `OutputManager` — stamped on entering `live`, kept across repeated live
  reports, cleared on leaving.)
- [x] Add output runtime adapters for projection, stage, recorder, and streamer.
  (Projection/stage: `OutputWindow`/`StageWindow` resolve `ProgramFrame`s.
  Recorder: the `RecordingProvider` app-scoped adapter. Streamer: the new
  app-scoped `StreamingProvider` in `src/hooks/useStreamingProvider.tsx`.
  Shared helpers in `src/hooks/outputRuntime.ts` — `reportOutputState` and
  `setOutputVisible`.)
- [x] Move recorder and streamer lifecycle ownership out of workspace components.
  (`RecordingProvider` already owned the recorder/compositor; the streaming hub
  pipeline — compositor, destinations, shared audio, master transport, per-card
  handles — now lives in `StreamingProvider`, and `StreamerTab` is a thin view
  over it that previews the provider's live stream via a `<video>` element. A
  broadcast survives navigating away.)
- [x] Make `outputs_set_visible` call the correct runtime adapter. (For window
  outputs it still toggles the bound window; for recorders/streamers it is the
  persisted operator-intent flag that adapters flip before reporting a phase.)
- [x] Add start/stop/apply/status transitions. (Recorder: starting → live /
  failed → stopping → stopped. Streamer: master Go Live reports starting, then
  live once any enabled destination is up (all-error → failed), Stop All reports
  stopping → stopped. Per-destination statuses flow through `reportStatus`.)
- [x] Use unique temporary files and a Windows-safe atomic replacement helper.
- [x] Roll back a window visibility change if persistence fails.
- [x] Broadcast output state changes with error and lifecycle reason.
- [x] Enforce license tier caps (Free = 1 on-air window) on the runtime adapter path
  in addition to the existing `outputs_set_visible` guard.

Acceptance criteria:

- [x] The output manager knows whether an output is configured, starting, live,
  stopping, failed, or stopped.
- [x] Navigating between workspaces cannot stop an active recording or stream.
- [x] A failed output does not change live program state.
- [x] A failed persistence operation does not leave disk and runtime contradictory.

### Phase 5: Source registry and camera lifecycle

Tasks:

- [x] Absorb the existing shared camera plumbing (`useSharedLocalCameraStream`
  ref-counted cache, `usePhoneCameraHost`/`usePhoneCameraStreams`) as the
  baseline instead of starting greenfield. (The ref-counted local cache and the
  phone WebRTC relay are the substrate; both now feed one registry.)
- [x] Add a source registry and source status model. (`src/system/sourceRegistry.ts`
  — per-device `SourceState` with a unified `SourceStatus` ∈ idle/opening/
  connected/error/reconnecting/disconnected + `SourceKind` local/phone/native/
  ndi + classified `errorKind`. External store consumed via
  `useSyncExternalStore`.)
- [x] Move local camera acquisition into a shared source manager. (The registry
  opens each local device once via `getUserMedia`, ref-counted across every
  consumer, and auto-reconnects once on device loss. Scene zones no longer open
  their own `getUserMedia` — `ZoneCamera` shares the registry stream.)
- [x] Keep phone camera signaling separate from source registration. (The WebRTC
  relay stays in `usePhoneCameraHost`; it only *registers* phone sources/status
  into the registry via `setPhoneSource`/`removePhoneSource`.)
- [x] Make camera feeds reusable by preview, scene zones, projection, recording,
  and streaming. (All consumers resolve through the registry; the compositor
  bulk path and DOM previews share one opened camera.)
- [x] Add source permission, unavailable, reconnecting, and disconnected states.
  (Unified `SourceStatus` + `describeSourceError`; safe fallbacks in
  `ZoneCamera` and `CameraFeed`.)
- [x] Add a source picker that works with synthetic phone-camera IDs without calling
  `getUserMedia` for them. (`src/components/sources/SourcePicker.tsx` + the
  non-acquiring `useSourceStatus` hook; wired into the SceneBuilder camera
  source. `phone-camera-`/`native:`/`ndi:` ids are never sent to
  `getUserMedia`.)
- [x] Add a future-compatible capture-device interface, even if the first backend
  implementation supports browser cameras only. (`SourceKind` reserves
  `native:`/`ndi:` ids; `resolveSourceKind` classifies them and acquisition
  refuses to open non-local sources.)

Acceptance criteria:

- [x] A camera is opened once and shared by all consumers.
- [x] Removing or losing a camera produces a safe visual fallback.
- [x] Multiple camera sources can exist without replacing each other.
- [x] A camera source can be placed into a scene zone and taken live.

### Phase 6: Basic audio graph

Tasks:

- Add `AudioGraphProvider` at application scope.
- Enumerate and select input devices.
- Create shared audio source tracks.
- Add volume, mute, and bus routing.
- Add program audio and monitor audio policies.
- Attach the selected program audio track to recording and streaming outputs.
- Migrate the existing IPC-fed RTMP AAC loopback (`rtmp_send_audio`) onto the
  shared audio graph so the app does not keep two audio pipelines.
- Gate shared audio input behind the premium tier capability, matching the
  existing StreamerTab gate.
- Surface device permission and device-loss errors.
- Add timestamps and an A/V synchronization policy.

Acceptance criteria:

- The same selected audio policy is used by recording and streaming.
- Enabling a destination does not create duplicate audio captures.
- Audio can be muted without altering visual output.
- Audio device loss is visible and recoverable.

### Phase 7: One encoder and transport packet bus

Tasks:

- Create one compositor capture stream for the program output.
- Create one encoder per visual profile, not one encoder per destination.
- Add packet metadata: timestamps, sequence, keyframe, codec, dimensions, FPS.
- Fan encoded packets to recorder, RTMP, WHIP, and future transports.
- Pass the selected FPS to the backend transport.
- Report dropped packet counts and queue pressure.
- Add reconnect behavior with bounded retries and clear operator status.
- Make ffmpeg process lifecycle explicit and observable.
- Enforce destination-count caps (Free = none, pro = 1) on the shared encoder
  path, not only in the UI.

Acceptance criteria:

- Two destinations do not create two video encoders.
- A destination can fail without stopping other destinations.
- Stream timing matches the configured FPS.
- Encoder, transport, and process failures are visible to the operator.
- Stop always closes tracks, encoders, queues, sockets, and child processes.

### Phase 8: Church operator workflow

Tasks:

- Define three primary operator modes: Prepare, Service, and System.
- Make Service mode the default live workspace.
- Keep content browsers available without making them the live engine.
- Improve Cockpit labels for staged, live, next, program, preview, and output.
- Add a simple service setup wizard for first use.
- Add output and source readiness indicators before service start.
- Add an emergency control strip with blackout, clear live, clear all, and
  restore.
- Keep advanced configuration behind Settings and System workspaces.
- Remove or hide unfinished workspace entries from normal operation.

Acceptance criteria:

- A new operator can import content, create a service, stage an item, take it
  live, operate a scene, and start recording without reading documentation.
- The live operator does not need to understand output internals.
- Every destructive action has clear text, confirmation, and recovery behavior.

### Phase 9: Persistence, migration, and recovery

Tasks:

- Add explicit database migration versions.
- Add transactions for bulk media, service, scene, and template updates.
- Separate searchable metadata from flexible JSON presentation payloads.
- Add a durable settings repository abstraction.
- Add atomic-file replacement with Windows-specific tests.
- Add startup validation for each data store.
- Implement Bible database install, reopen, and FTS rebuild without process
  restart.
- Add automatic backup before schema migration.
- Add operator-visible recovery status and backup location.

Acceptance criteria:

- A power loss during a write does not leave truncated configuration.
- A failed migration preserves the previous database.
- Malformed individual content records are reported instead of silently making
  the entire workspace appear empty.
- Bible installation is usable without restarting the application.

### Phase 10: Remote and extensibility contracts

Tasks:

- Make remote commands call engine commands only.
- Generate or centrally define remote protocol schemas where practical.
- Broadcast permission changes immediately.
- Add read-query rate limits for expensive search operations.
- Add source, scene, output, and transport events to the remote snapshot only
  when needed by the remote UI.
- Add capability negotiation for future clients.
- Add extension registries for source kinds, output kinds, and transport kinds.
- Keep unknown future enum values safely ignorable on the frontend.

Acceptance criteria:

- An old remote client can receive a clear unsupported-feature response.
- A revoked or permission-reduced client updates without reconnecting.
- New source or output types can be added without editing the broadcast engine.

## 7. Persistence Migration Rules

Agents must follow these rules:

- Never change an existing persisted field meaning in place.
- Add `schema_version` to new persisted documents.
- Support reading the previous version before writing the new version.
- Migrate through a pure function where possible.
- Write migrated data atomically.
- Keep a timestamped backup before destructive migration.
- Do not silently replace a failed store with an empty store without surfacing a
  startup issue.
- Do not store secrets such as stream keys or private keys in logs.
- Do not put high-frequency runtime state into the content database.

## 8. Event and Command Rules

All mutating commands must have:

- A stable command name.
- Typed input.
- Typed result.
- Error code and operator-safe message.
- Source/client identifier when relevant.
- Expected revision for remote mutations.
- Resulting revision.
- Idempotency behavior documented.

All authoritative events must have:

- Event name.
- Schema version.
- Revision when related to presentation state.
- Timestamp.
- Complete clear/null semantics.
- Typed frontend and backend definitions.

Do not use fire-and-forget calls for operations that change what the audience
sees. The caller must receive success or failure.

## 9. Testing Strategy

### 9.1 Unit tests

Cover:

- Engine command transitions.
- Revision ordering.
- Scene transactions and rollback.
- Source binding resolution.
- ProgramFrame resolution.
- Output source and overlay masks.
- Timer calculations.
- Packet bus ordering and backpressure.
- FPS and timestamp conversion.
- Persistence migrations.
- Windows-safe atomic replacement.
- License capability enforcement.

### 9.2 Integration tests

Cover:

- Main window hydration.
- Stage window hydration.
- Output window hydration.
- Remote command to engine command flow.
- Phone camera registration and disconnect.
- Media loss during a live scene.
- Recording while changing workspaces.
- One encoder feeding multiple transports.
- ffmpeg failure and restart.
- Bible download and store replacement.

### 9.3 Manual acceptance tests

Test at:

- 1280x720.
- 1920x1080.
- 125% Windows scaling.
- 150% Windows scaling.
- One monitor.
- Two monitors.
- Three output surfaces.
- Missing Bible database.
- Missing media file.
- Camera permission denial.
- Camera disconnect.
- Audio device disconnect.
- Network loss during stream.
- App restart while output windows are configured.
- Forced process termination during persistence.

## 10. Agent Execution Rules

Every implementation agent must:

1. Read this plan and the relevant current files before editing.
2. State the phase and exact task being implemented.
3. Avoid unrelated refactors.
4. Preserve existing persisted data unless the task includes a migration.
5. Route new mutations through the Broadcast Engine.
6. Avoid adding a second renderer or second source lifecycle.
7. Add tests for the failure path, not only the success path.
8. Run `npm run build` for frontend changes.
9. Run `npm run build` and `cargo check` for Tauri contract changes.
10. Run `npm run test` for state, event, renderer, or UI changes.
11. Update `CLAUDE.md` when architecture, windows, commands, or persistence
    changes.
12. Report files changed, tests run, failures, and remaining risks.

An agent must not claim a phase is complete if an acceptance criterion is
missing. If implementation is blocked by hardware, a vendor SDK, or a manual
release action, the agent must leave a tested capability gate and document the
blocked path.

## 11. Definition Of Unified Production Suite

The product is ready for the unified-suite release when all of the following
are true:

- One Broadcast Engine owns every audience-visible mutation.
- All windows converge through typed snapshots and revisions.
- Projection and recorded/streamed program frames are equivalent for supported
  features.
- Output configuration is consumed by real output runtimes.
- Sources have a shared lifecycle and can be reused across previews and outputs.
- Basic audio routing works for recording and streaming.
- One encoder can feed multiple compatible destinations.
- Output failures do not change live state.
- Bible installation works without restarting the process.
- Persistence failures are visible and recoverable.
- Remote clients use the same engine commands as the desktop.
- The default operator workflow is understandable without technical training.
- All unfinished capabilities are hidden, explicitly experimental, or complete.
- The manual acceptance matrix passes on supported Windows configurations.

The architectural test is simple: adding a new source, output, transport, or
scene effect should require implementing that capability's adapter and tests,
not editing every workspace, window, and live-state switch in the application.
