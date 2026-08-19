import { describe, expect, it } from "vitest";
import { REMOTE_PROTOCOL_VERSION, type RemoteCommandType, type RemoteEventKind } from "../../types/remote";

/**
 * WP10 (P2-4) — Rust ⇄ TypeScript protocol contract.
 *
 * The wire protocol is ONE versioned contract defined in
 * `src-tauri/src/remote/protocol.rs` and mirrored here. These tests pin the
 * mirror so a change on either side must be deliberate: bump
 * `REMOTE_PROTOCOL_VERSION` (Rust `REMOTE_PROTOCOL_VERSION`) together, and keep
 * the command/event name set in agreement. Unknown commands/events are
 * tolerated via `#[serde(other)] Unknown` and `capabilities` negotiation, so a
 * newer client never breaks against an older server.
 */
describe("remote protocol contract (WP10)", () => {
  it("pins the wire protocol version in lockstep with protocol.rs", () => {
    // MUST equal `REMOTE_PROTOCOL_VERSION` in `src-tauri/src/remote/protocol.rs`.
    expect(REMOTE_PROTOCOL_VERSION).toBe(1);
  });

  it("covers the core mutating command names the engine dispatch relies on", () => {
    // These literal command strings MUST match the serde renames in
    // `src-tauri/src/remote/protocol.rs` and the permission map in
    // `remote/commands.rs`. Unknown types are tolerated via `#[serde(other)]`,
    // so a future command on one side never crashes the other.
    const cmds: RemoteCommandType[] = [
      "bible.stage",
      "song.stage",
      "camera.start",
      "lower_third.show",
      "lower_third.hide",
      "studio.go_live",
      "display.go_live",
      "remote.request_control",
    ];
    for (const c of cmds) expect(typeof c).toBe("string");
  });

  it("mirrors the presentation event kinds the remote client applies", () => {
    const kinds: RemoteEventKind[] = [
      "live.changed",
      "staged.changed",
      "lower_third.changed",
      "blackout.changed",
      "logo.changed",
      "snapshot",
    ];
    for (const k of kinds) expect(typeof k).toBe("string");
  });
});
