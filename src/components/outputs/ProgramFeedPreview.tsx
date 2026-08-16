import { useMemo } from "react";
import { useAppStore } from "../../store";
import { THEMES } from "../../types";
import { ProgramFeedCanvas } from "./ProgramFeedCanvas";
import { collectCameraDeviceIds } from "./canvasProgramFeed";
import type { ProgramFeedFrame } from "./canvasProgramFeed";
import { usePhoneCameraStreams } from "../../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStreams } from "../../hooks/useSharedLocalCameraStream";

/**
 * `ProgramFeedPreview` — operator-facing verification surface for the Phase 2
 * compositor. Subscribes to the shared store's authoritative program state
 * (live item, settings, props, lower third) and rasterizes the same
 * composition the recorder/streamer surfaces will capture. Camera feeds come
 * from the WebRTC phone relay (context) merged with native local camera
 * streams opened through the ref-counted shared cache. This is the "single
 * render path" validation point: what the DOM `PreviewCard` shows and what
 * this canvas produces must match.
 */
export function ProgramFeedPreview({
  geometry = { width: 1920, height: 1080 },
  fps = 30,
  className,
  onStream,
  active = true,
}: {
  geometry?: { width: number; height: number };
  fps?: number;
  className?: string;
  onStream?: (stream: MediaStream | null) => void;
  active?: boolean;
}) {
  const liveItem = useAppStore((s) => s.liveItem);
  const settings = useAppStore((s) => s.settings);
  const propItems = useAppStore((s) => s.propItems);
  const currentLowerThird = useAppStore((s) => s.currentLowerThird);
  const appDataDir = useAppStore((s) => s.appDataDir);

  // Camera feeds: relayed phone streams (live in the provider context) plus
  // native local streams for every camera device id the frame references.
  const phoneStreams = usePhoneCameraStreams();
  const cameraIds = useMemo(() => collectCameraDeviceIds(liveItem, settings), [liveItem, settings]);
  const localStreams = useSharedLocalCameraStreams(cameraIds, "program-feed-preview");

  const cameraStreams = useMemo(() => {
    const out: Record<string, MediaStream> = { ...localStreams };
    for (const [deviceId, s] of Object.entries(phoneStreams)) out[deviceId] = s;
    return out;
  }, [localStreams, phoneStreams]);

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
      active={active}
    />
  );
}