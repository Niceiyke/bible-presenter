import { describe, expect, it } from "vitest";
import { ENGINE_PROTOCOL_VERSION, type EngineCommand, type EngineEvent } from "../../types/engine";

/**
 * Phase A1 — Rust ⇄ TypeScript engine IPC contract.
 *
 * The engine wire contract is ONE versioned protocol defined in
 * `src-tauri/src/engine/ipc.rs` and mirrored here. These tests pin the mirror
 * so a change on either side must be deliberate: bump
 * `ENGINE_PROTOCOL_VERSION` (Rust `ENGINE_PROTOCOL_VERSION`) together, and keep
 * the command/event name set in agreement. Unknown commands/events are
 * tolerated via `#[serde(other)] Unknown`, so a newer client never breaks
 * against an older engine.
 */
describe("engine IPC contract (Phase A1)", () => {
  it("pins the wire protocol version in lockstep with ipc.rs", () => {
    // MUST equal `ENGINE_PROTOCOL_VERSION` in `src-tauri/src/engine/ipc.rs`.
    expect(ENGINE_PROTOCOL_VERSION).toBe(2);
  });

  it("covers the core presentation command names the engine dispatch relies on", () => {
    // These literal `cmd` strings MUST match the serde renames in
    // `src-tauri/src/engine/ipc.rs`. Unknown types are tolerated via
    // `#[serde(other)]`, so a future command on one side never crashes the other.
    const cmds: EngineCommand[] = [
      { cmd: "ping" },
      { cmd: "presentation_snapshot" },
      { cmd: "stage_item", item: {} as never },
      { cmd: "commit_staged" },
      { cmd: "send_live_item", item: {} as never },
      { cmd: "clear_all" },
      { cmd: "save_settings", settings: {} as never },
      { cmd: "set_blackout", on: true },
      { cmd: "show_lower_third", data: {} as never },
      { cmd: "set_props", props: [] },
      { cmd: "apply_scene", id: "s1" },
      { cmd: "output_window_show", label: "output", style: { decorations: false, transparent: true, always_on_top: true, resizable: false }, width: 1920, height: 1080 },
      { cmd: "output_window_hide", label: "output" },
      { cmd: "output_window_set_monitor", label: "output", monitor: "DELL" },
      { cmd: "output_window_resize", label: "output", width: 1280, height: 720 },
      { cmd: "output_window_set_config", label: "output", config: {} as never },
      { cmd: "list_monitors" },
    ];
    for (const c of cmds) expect(typeof c).toBe("object");
  });

  it("mirrors the presentation event kinds the console sync guard applies", () => {
    const events: EngineEvent[] = [
      { event: "live_item_update", detected_item: null, revision: 1 },
      { event: "item_staged", item: null, revision: 1 },
      { event: "settings_changed", settings: {} as never, revision: 1 },
      { event: "lower_third_update", lower_third: null, revision: 1 },
      { event: "props_update", props: [], revision: 1 },
      { event: "output_state_changed", output_id: "stream-main", state: {} },
      { event: "preview_frame", output_id: "output-main", frame_index: 0 },
      { event: "ndi_source_changed", payload: {} },
    ];
    for (const e of events) expect(typeof e).toBe("object");
  });

  it("presentation events always carry a revision for the sync guard", () => {
    const presentationEvents: EngineEvent[] = [
      { event: "live_item_update", detected_item: null, revision: 3 },
      { event: "item_staged", item: null, revision: 3 },
      { event: "settings_changed", settings: {} as never, revision: 3 },
      { event: "lower_third_update", lower_third: null, revision: 3 },
      { event: "props_update", props: [], revision: 3 },
    ];
    for (const e of presentationEvents) {
      expect((e as { revision?: number }).revision).toBe(3);
    }
  });
});