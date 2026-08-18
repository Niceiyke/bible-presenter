import { describe, it, expect } from "vitest";
import { PresentationSync } from "../presentationSync";

/**
 * Phase 2 — stale-event protection. Every production window (operator main,
 * output, stage) runs the same `PresentationSync` guard over the
 * revision-tagged presentation events. These tests exercise the shared guard
 * with the exact event shapes the backend emits so each window's hydration
 * path is covered by the same semantics.
 */

function makeMainWindowModel() {
  return {
    live: null as string | null,
    staged: null as string | null,
    settings: null as string | null,
    lowerThird: null as string | null,
    ltVisible: false,
    props: [] as string[],
  };
}

describe("PresentationSync", () => {
  it("applies newer events and drops stale ones after open", () => {
    const sync = new PresentationSync();
    let live: string | null = null;
    sync.open(); // already hydrated at revision 0

    sync.apply(1, () => (live = "gen-1"));
    expect(live).toBe("gen-1");
    expect(sync.revision).toBe(1);

    // A stale delivery from before gen-1 must not overwrite it.
    sync.apply(0, () => (live = "stale"));
    expect(live).toBe("gen-1");
    expect(sync.revision).toBe(1);
  });

  it("applies every event of one mutation at the same revision (equal applies)", () => {
    const sync = new PresentationSync();
    const m = makeMainWindowModel();
    sync.open();

    // A single backend mutation bumps once then emits several events, all at
    // revision 9 — e.g. op_apply_scene broadcasting live/staged/settings/
    // lower-third/props together.
    sync.apply(9, () => (m.live = "cam"));
    sync.apply(9, () => (m.staged = "composition"));
    sync.apply(9, () => (m.settings = "s9"));
    sync.apply(9, () => {
      m.lowerThird = "lt9";
      m.ltVisible = true;
    });
    sync.apply(9, () => (m.props = ["p9"]));

    expect(m).toEqual({
      live: "cam",
      staged: "composition",
      settings: "s9",
      lowerThird: "lt9",
      ltVisible: true,
      props: ["p9"],
    });
    expect(sync.revision).toBe(9);
  });

  it("buffers pre-open events and replays only at-or-newer than the snapshot", () => {
    const sync = new PresentationSync();
    let live: string | null = null;
    let staged: string | null = null;

    // Events race the snapshot while the window boots.
    sync.apply(3, () => (live = "new"));
    sync.apply(1, () => (staged = "old"));

    // The authoritative snapshot arrives at revision 2.
    sync.applySnapshot(2, () => {
      live = "snap-live";
      staged = "snap-staged";
    });
    expect(live).toBe("snap-live");
    expect(staged).toBe("snap-staged");

    sync.open();

    // The rev-3 live event replays on top; the rev-1 staged event is older
    // than the snapshot and is skipped.
    expect(live).toBe("new");
    expect(staged).toBe("snap-staged");
    expect(sync.revision).toBe(3);
  });

  it("rejects a snapshot older than already-applied state", () => {
    const sync = new PresentationSync();
    let live: string | null = null;
    sync.open();

    sync.apply(5, () => (live = "gen-5"));
    // A late-arriving snapshot captured earlier must be ignored.
    sync.applySnapshot(4, () => (live = "stale-snap"));
    expect(live).toBe("gen-5");

    // Equal revision is fine: the snapshot reflects the same mutation.
    sync.applySnapshot(5, () => (live = "snap-5"));
    expect(live).toBe("snap-5");
  });

  it("converges on window reopen: snapshot plus replay, newest wins", () => {
    const sync = new PresentationSync();
    let live: string | null = null;

    // The window was hidden at rev 4; while hidden the backend moved to rev 6.
    // On reveal the rebroadcast (rev 6) and an in-flight event (rev 5) arrive
    // before the snapshot (rev 4) resolves.
    sync.apply(6, () => (live = "rev6"));
    sync.apply(5, () => (live = "rev5"));
    sync.applySnapshot(4, () => (live = "rev4"));
    expect(live).toBe("rev4"); // snapshot applied over the pre-open buffer

    sync.open();
    expect(live).toBe("rev6"); // newest replayed wins
    expect(sync.revision).toBe(6);
  });

  it("null clear payloads at a newer revision always clear stale state", () => {
    const sync = new PresentationSync();
    let lowerThird: string | null = "stale";
    let props: string[] = ["stale"];
    sync.open();

    sync.apply(4, () => {
      lowerThird = "lt4";
      props = ["p4"];
    });
    // op_clear_all at revision 5 broadcasts null lower-third + empty props.
    sync.apply(5, () => {
      lowerThird = null;
      props = [];
    });
    expect(lowerThird).toBeNull();
    expect(props).toEqual([]);

    // A stale non-null event from the pre-clear revision cannot resurrect.
    sync.apply(4, () => {
      lowerThird = "lt4";
      props = ["p4"];
    });
    expect(lowerThird).toBeNull();
    expect(props).toEqual([]);
  });

  it("output window drops a stale rebroadcast arriving after newer state", () => {
    const sync = new PresentationSync();
    let live: string | null = null;
    let settings: string | null = null;
    sync.open();

    // A newer mutation was already applied.
    sync.apply(4, () => {
      live = "l4";
      settings = "s4";
    });
    // The reveal-time rebroadcast (captured at revision 3) arrives late.
    sync.apply(3, () => {
      live = "l3";
      settings = "s3";
    });
    expect(live).toBe("l4");
    expect(settings).toBe("s4");
  });

  it("stage window applies a same-revision scene update then drops an older one", () => {
    const sync = new PresentationSync();
    let live: string | null = null;
    sync.open();

    // Remote camera.send_live into a live scene at rev 7 (zone patch).
    sync.apply(7, () => (live = "camera-zone"));
    expect(live).toBe("camera-zone");

    // Late rebroadcast captured at rev 6 cannot overwrite it.
    sync.apply(6, () => (live = "scene-6"));
    expect(live).toBe("camera-zone");
  });

  it("open is idempotent and never re-applies a cleared buffer", () => {
    const sync = new PresentationSync();
    let applied = 0;
    sync.apply(2, () => applied++);
    sync.applySnapshot(1, () => applied++);
    sync.open();
    sync.open();
    sync.open();
    expect(applied).toBe(2); // one replay only, no duplicates
    expect(sync.revision).toBe(2);
  });
});