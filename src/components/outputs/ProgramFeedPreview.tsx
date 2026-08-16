import { useMemo } from "react";
import { useAppStore } from "../../store";
import { THEMES } from "../../types";
import { ProgramFeedCanvas } from "./ProgramFeedCanvas";
import type { ProgramFeedFrame } from "./canvasProgramFeed";

/**
 * `ProgramFeedPreview` — operator-facing verification surface for the Phase 2
 * compositor. Subscribes to the shared store's authoritative program state
 * (live item, settings, props, lower third, phone camera streams) and rasterizes
 * the same composition the recorder/streamer surfaces will capture. This is the
 * "single render path" validation point: what the DOM `PreviewCard` shows and
 * what this canvas produces must match.
 */
export function ProgramFeedPreview({
  geometry = { width: 1920, height: 1080 },
  fps = 30,
  className,
  onStream,
}: {
  geometry?: { width: number; height: number };
  fps?: number;
  className?: string;
  onStream?: (stream: MediaStream | null) => void;
}) {
  const liveItem = useAppStore((s) => s.liveItem);
  const settings = useAppStore((s) => s.settings);
  const propItems = useAppStore((s) => s.propItems);
  const currentLowerThird = useAppStore((s) => s.currentLowerThird);
  const phoneCameras = useAppStore((s) => s.phoneCameras);
  const appDataDir = useAppStore((s) => s.appDataDir);

  // Phone camera streams hosted by the operator window's "operator" peer.
  const cameraStreams = useMemo(() => {
    const out: Record<string, MediaStream> = {};
    for (const cam of phoneCameras) {
      if (cam.stream) out[cam.deviceId] = cam.stream;
    }
    return out;
  }, [phoneCameras]);

  const frame: ProgramFeedFrame = useMemo(() => {
    const colors = (THEMES[settings.theme] ?? THEMES.dark).colors;
    return {
      item: liveItem,
      settings,
      colors,
      res: { appDataDir },
      propItems,
      lowerThird: currentLowerThird,
    };
  }, [liveItem, settings, propItems, currentLowerThird, appDataDir]);

  return (
    <ProgramFeedCanvas
      geometry={geometry}
      frame={frame}
      cameraStreams={cameraStreams}
      fps={fps}
      className={className}
      onStream={onStream}
    />
  );
}