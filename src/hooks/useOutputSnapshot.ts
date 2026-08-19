import { useAppStore } from "../store";
import type { PresentationSnapshot, Scene } from "../types";

/**
 * Builds the authoritative presentation snapshot consumed by every output
 * runtime (projection DOM window, stage preview, recorder canvas, streamer
 * canvas) from the operator console's shared store. One builder, so the DOM
 * outputs and the canvas compositors never disagree about live/staged/
 * settings/props/lower-third state — they only differ by which `OutputConfig`
 * they resolve it through.
 *
 * The operator console has no backend revision counter, so `revision` is 0
 * here (matching the pre-existing console behavior); the resolver only uses it
 * as a frame label. Windows that hydrate from the real backend snapshot pass
 * the revision through themselves.
 */
export interface OutputSnapshot {
  snapshot: Pick<
    PresentationSnapshot,
    "live" | "staged" | "settings" | "props" | "lower_third" | "revision"
  >;
  scenes: Scene[];
  appDataDir: string | null;
}

export function useOutputSnapshot(): OutputSnapshot {
  const liveItem = useAppStore((s) => s.liveItem);
  const stagedItem = useAppStore((s) => s.stagedItem);
  const settings = useAppStore((s) => s.settings);
  const propItems = useAppStore((s) => s.propItems);
  const currentLowerThird = useAppStore((s) => s.currentLowerThird);
  const scenes = useAppStore((s) => s.scenes);
  const appDataDir = useAppStore((s) => s.appDataDir);

  return {
    snapshot: {
      live: liveItem,
      staged: stagedItem,
      settings,
      props: propItems,
      lower_third: currentLowerThird,
      revision: 0,
    },
    scenes,
    appDataDir,
  };
}
