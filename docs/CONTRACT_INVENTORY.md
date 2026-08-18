# Contract Inventory (Phase 0 freeze, updated for Phase 1 engine)

Status: living inventory — Phase 0 of `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md`
requires recording the current event names, command names, persisted files, and
schema versions BEFORE moving code. This document is that record. Keep it
updated whenever a contract changes.

As of Phase 1, all presentation mutations live in the **broadcast engine**
(`src-tauri/src/engine/presentation.rs`); the `commands/display.rs`,
`commands/props.rs`, `commands/lower_third.rs`, `commands/scenes.rs`, and
`remote/commands.rs` are thin adapters. Command names and return shapes are
unchanged (frontend contract frozen).

## 1. Tauri commands (registered in `src-tauri/src/main.rs`)

All commands are `tauri::command` async functions. Caller-facing names match the
Rust function names unless noted.

### Bible (`commands/bible.rs`)
`get_bible_versions`, `set_bible_version`, `bible_fts_status`, `split_verse`,
`search_semantic_query`, `read_file_base64`, `get_books`, `get_chapters`,
`get_verses_count`, `get_chapter`, `get_verse`, `get_next_verse`, `get_prev_verse`

### Media (`commands/media.rs`)
`list_media`, `add_media`, `add_media_streaming`, `save_camera_snapshot`,
`relink_media`, `delete_media`, `set_media_fit`, `set_media_playback`,
`update_media_metadata`, `bulk_delete_media`, `bulk_update_media`,
`check_media_existence`, `check_media_existence_bulk`, `get_media_references`

### Schedule (`commands/schedule.rs`)
`save_schedule`, `load_schedule`, `save_recovery`, `load_recovery`,
`clear_recovery`, `list_services`, `save_service`, `load_service`,
`delete_service`

### Display / broadcast (`commands/display.rs` — engine adapters)
`stage_item`, `commit_staged`, `go_live` (legacy → `commit_staged`),
`send_live_item`, `go_live_item`, `clear_live`, `clear_staged`, `clear_all`,
`presentation_snapshot` (returns `PresentationSnapshot` incl. `revision`),
`update_timer`, `get_current_item`, `get_staged_item`, `get_settings`,
`save_settings`

Every mutating command delegates to the engine's `op_*` method and returns the
legacy shape: `stage_item`→`()`, `commit_staged`→`Option<DisplayItem>`,
`go_live`→`()`, `send_live_item`→`DisplayItem`, `go_live_item`→`()`,
`clear_*`→`()`, `update_timer`→`()`, `save_settings`→`()`,
`apply_scene`→`ScenePayload`, `presentation_snapshot`→`PresentationSnapshot`
via `engine::snapshot`. `license::ensure_allowed` stays in the broadcast
adapters (`stage_item`, `commit_staged`, `go_live`, `send_live_item`,
`go_live_item`, `apply_scene`) and at the top of remote `dispatch` — not in the
clear ops.

### Studio / presentations (`commands/studio_pres.rs`)
`list_studio_presentations`, `save_studio_presentation`,
`load_studio_presentation`, `delete_studio_presentation`, `list_slide_templates`,
`save_slide_template`, `delete_slide_template`

### Songs (`commands/songs.rs`)
`list_songs`, `save_song`, `delete_song`

### Lower third (`commands/lower_third.rs`)
`show_lower_third`, `hide_lower_third`, `save_lt_templates`, `load_lt_templates`,
`get_current_lower_third`, `list_lt_presets`, `save_lt_preset`,
`delete_lt_preset`, `show_lt_preset`

### Windows (`commands/windows.rs`)
`toggle_output_window`, `toggle_stage_window`, `toggle_studio_window`,
`get_available_monitors`, `show_output_test_pattern`, `hide_output_test_pattern`

### Props (`commands/props.rs`)
`get_props`, `set_props`

### Misc (`commands/misc.rs`)
`get_app_data_dir`, `list_fonts`, `get_hymn_library`, `write_text_file`,
`read_text_file`, `save_workspace`, `load_workspace`

### Scenes (`commands/scenes.rs`)
`list_scenes`, `save_scene`, `delete_scene`, `apply_scene`, `capture_scene`

### Outputs (`commands/outputs.rs`)
`outputs_list`, `outputs_states`, `outputs_update` (replace-all, idempotent),
`outputs_set_visible`

### Recordings (`commands/recordings.rs`)
`recordings_list`, `recording_save`, `recording_delete`, `recordings_open_folder`

### RTMP (`commands/rtmp.rs`)
`rtmp_start`, `rtmp_send`, `rtmp_send_audio`, `rtmp_stop`, `rtmp_status`

### NDI (`commands/ndi.rs`) — SDK-gated `#[cfg(feature = "ndi")]` stubs
`ndi_status`, `ndi_start`, `ndi_send`, `ndi_stop`

### System (`commands/system.rs`)
`system_info`, `system_metrics`

### Assets (`commands/assets.rs`)
`get_startup_status`, `download_bible_db_cmd`

### Remote control (`commands/remote.rs`)
`remote_enable`, `remote_disable`, `remote_status`, `remote_regenerate_pairing`,
`remote_revoke_device`, `remote_revoke_all`, `remote_claim_control`,
`remote_set_role`, `remote_set_permissions`, `remote_set_auto_revoke`,
`remote_rename_device`, `phone_camera_answer`, `phone_camera_ice`,
`list_phone_cameras`

### License (`commands/license.rs`)
`license_status`, `license_activate`, `license_refresh`, `license_deactivate`

## 2. Tauri events

Typed on the frontend in `src/hooks/useTauriEvent.ts` (`EventMap`). The backend
emits through `crate::events::emit_checked` which forwards failures to
`system-log`.

| Event | Payload (frontend type) | Emitter |
| --- | --- | --- |
| `live-item-update` | `{ detected_item: DisplayItem \| null, revision?: number }` | `engine/presentation.rs`, `commands/outputs.rs` |
| `item-staged` | `DisplayItem \| null` | `engine/presentation.rs` |
| `settings-changed` | `PresentationSettings` | `engine/presentation.rs`, `commands/outputs.rs` |
| `lower-third-update` | `{ data, template } \| null` | `engine/presentation.rs` |
| `props-update` | `PropItem[]` | `engine/presentation.rs` |
| `media-control` | `{ action, volume?, currentTime?, rate? }` | frontend → `commands/media.rs` |
| `media-state` | `{ playing, currentTime, duration, volume, muted, rate } \| null` | frontend (media player) |
| `songs-sync` | `Song[]` | songs command layer |
| `studio-sync` | `any[]` | `commands/studio_pres.rs` |
| `studio-slides-sync` | `{ id, slides }` | slide editor |
| `lower-third-template-sync` | `LowerThirdTemplate[]` | lower-third command layer |
| `system-log` | `{ level, message, timestamp }` | everywhere (`store::log_msg`, `emit_checked`) |
| `operator-warning` | `{ message, level? }` | `src/hooks/useAppInitialization.ts` helper |
| `download-progress` | `{ progress }` | `commands/assets.rs`, `commands/media.rs` |
| `phone-camera-offer` | `{ device_id, device_name, sdp, target? }` | `remote/server.rs` |
| `phone-camera-ice` | `{ device_id, candidate, sdp_mid, sdp_m_line_index, target? }` | `remote/server.rs` |
| `phone-camera-stop` | `{ device_id }` | `remote/server.rs`, `remote/commands.rs` |
| `phone-cameras-changed` | `{ cameras: [...] }` | `remote/server.rs`, `remote/commands.rs` |
| `remote-device-event` | `{ event, device_name }` | `commands/remote.rs` |
| `output-config-changed` | `OutputConfig[]` (replace-all) | `commands/outputs.rs` |
| `output-state-changed` | `OutputState` | `commands/outputs.rs` |
| `license-updated` | `LicenseInfo` | `commands/license.rs` |
| `search-index-status` | `{ state: "indexing" \| "ready" }` | `store/mod.rs` |
| `bible-db-ready` | path string | `commands/assets.rs` |
| `download-error` | error string | `commands/assets.rs` |
| `media-probed` / `media-updated` | `MediaItem` | `store/media_schedule.rs`, `commands/media.rs` |
| `monitor-test` | `{ active }` | `commands/windows.rs` |

### Remote protocol (WebSocket, `remote/protocol.rs` ↔ `src/types/remote.ts`)
`REMOTE_PROTOCOL_VERSION` must match between `protocol.rs` and `remote.ts`. All
mutating commands route through `remote/commands.rs` → the shared broadcast
engine (`engine/presentation.rs`), never a separate state owner.

## 2b. Broadcast engine (`engine/presentation.rs`, Phase 1)

Every presentation mutation (desktop command or remote dispatch) runs through
`Engine<'a> { state: &AppState, emit: &EmitFn }` where `EmitFn` is the window
event sink (`app_emit_sink(&AppHandle)` in production, an `EventRecorder` in
tests). Contract:

- One acquisition of the presentation mutation lock and exactly ONE revision
  bump per logical mutation; every mutation returns `MutationResult`
  (`snapshot` = post-mutation `PresentationSnapshot`, `committed` =
  `Option<DisplayItem>`, `scene` = `Option<ScenePayload>`).
- Mutations that persist first are transactional: a persistence failure aborts
  before any in-memory state or event is touched, and multi-write operations
  compensate the earlier writes (`op_clear_all`, `op_set_props`,
  `op_save_settings`, `op_apply_scene`).
- `op_commit_staged` is a true no-op when nothing is staged (no bump, no
  events). `op_toggle_timer` returns `Result<(MutationResult, bool), String>`.
- Scene-zone bus primitives live here: `zone_source_for` + `patch_scene_zones`
  (Phase 5) are free functions; `op_apply_scene` is one logical transaction.
- `op_get_props` and `snapshot` are free functions (reads, no lock/emit).
- `PRESENTATION_SCHEMA_VERSION` and `PresentationSnapshot` moved here from
  `commands/display.rs`.

## 3. Persisted files under the app data dir

### SQLite
- `wordlyte_data.db` — the data database (`MediaScheduleStore`, opened via
  `DataDb::open` in `store/data_db.rs`). Corrupt DBs are quarantined as
  timestamped `corrupt-*` sidecars and recreated. Startup failures surface via
  `get_startup_status`.
- `bible_data/wordlyte_bible.db` — bundled/downloadable Bible database (read at
  startup; replaces the placeholder store only after a process restart today —
  see plan §2.5). `bible_data/hymns.json` — bundled hymn data.

### JSON / text
| File | Contents | Writer |
| --- | --- | --- |
| `outputs.json` | `OutputConfig[]` (schema_version 1) | `outputs.rs` (temp+rename atomic) |
| `settings.json` | presentation settings | `media_schedule.rs` |
| `schedule.json` | service schedule entries | `media_schedule.rs` |
| `props.json` | prop items | `media_schedule.rs` |
| `lt_templates.json` | lower-third templates | `media_schedule.rs` |
| `lt_presets.json` | lower-third presets | `media_schedule.rs` |
| `recovery.json` | schedule recovery state | `commands/schedule.rs`, `remote/snapshot.rs` |
| `remote_devices.json` | paired remote devices (hashed secrets) | `remote/mod.rs` |
| `remote_prefs.json` | remote preferences | `remote/mod.rs` |
| `remote_tls.json` | self-signed TLS cert/private key | `remote/tls.rs` |
| `remote_port.txt` | last bound remote port | `remote/mod.rs` |
| `license.json` | license record (machine-bound) | `license.rs` |
| `songs/`, `studio/`, `services/` | per-item JSON payloads | `media_schedule.rs` |
| `recordings/` | saved WebM recordings | `commands/recordings.rs` |

`app.log` lives in the app data dir logs directory; `panic.log` under
`io.wordlyte.app` local-app path.

## 4. Schema versions (Phase 0)

| Document | Constant | Current | Location |
| --- | --- | --- | --- |
| `PresentationSnapshot` | `PRESENTATION_SCHEMA_VERSION` | 1 | `engine/presentation.rs`, `src/types/display.ts` |
| `OutputConfig` | `OUTPUT_SCHEMA_VERSION` | 1 | `outputs.rs`, `src/types/output.ts` |
| Remote protocol | `REMOTE_PROTOCOL_VERSION` | — | `remote/protocol.rs`, `src/types/remote.ts` |

Rule (plan §7): never change a persisted field's meaning in place; add
`schema_version` to new documents; read the previous version before writing the
new one; migrate through a pure function; write atomically; back up before
destructive migration.

## 5. Experimental / unfinished surface

- **Design Hub window** (`design`) and **Audio Studio window** (`studio`):
  declared in `tauri.conf.json`, hidden by default, not reachable from
  `LeftNav`. `App.tsx` renders an explicit "not implemented yet" placeholder in
  those windows. Treat as experimental.
- **NDI**: `ndi_status`/`ndi_start`/`ndi_send`/`ndi_stop` are SDK-gated stubs
  behind the `ndi` cargo feature. The Streaming hub's NDI destination is
  gated on the `ndiAvailable` capability and shows an experimental warning.
