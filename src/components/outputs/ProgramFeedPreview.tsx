import { useMemo } from "react";
import { useAppStore } from "../../store";
import { OUTPUT_SCHEMA_VERSION } from "../../types";
import type { OutputConfig } from "../../types";
import { ProgramFeedCanvas } from "./ProgramFeedCanvas";
import { collectCameraDeviceIds } from "./canvasProgramFeed";
import { resolveProgramFrame } from "../../compositor/ProgramFrameResolver";
import { usePhoneCameraStreams } from "../../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStreams } from "../../hooks/useSharedLocalCameraStream";

/**
 * `ProgramFeedPreview` — operator-facing verification surface for the Phase 2/3
 * compositor. Subscribes to the shared store's authoritative program state
 * (live item, settings, props, lower third) and resolves it through
 * `resolveProgramFrame` into the SAME `ProgramFrame` shape the recorder/
 * streamer surfaces will capture. Camera feeds come from the WebRTC phone
 * relay (context) merged with native local camera streams opened through the
 * ref-counted shared cache. This is the "single render path" validation
 * point: what the DOM `PreviewCard` shows and what this canvas produces must
 * match.
 */
export function ProgramFeedPreview({
  geometry = { width: 1920, height: 1080 },
  fps = 30,
  className,
  onStream,
  active = true,
  onMissingMedia,
}: {
  geometry?: { width: number; height: number };
  fps?: number;
  className?: string;
  onStream?: (stream: MediaStream | null) => void;
  active?: boolean;
  onMissingMedia?: (failedPaths: string[]) => void;
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

  // The preview is the program bus itself, so it subscribes as the default
  // live source with every overlay unmasked.
  const config: OutputConfig = useMemo(
    () => ({
      schema_version: OUTPUT_SCHEMA_VERSION,
      id: "program-preview",
      kind: "window",
      label: "Program Preview",
      enabled: true,
      visible: true,
      source: { type: "live" },
      geometry: { width: geometry.width, height: geometry.height },
      capture_fps: fps,
      overlays: { props: true, lower_third: true, logo: true },
    }),
    [geometry.width, geometry.height, fps]
  );

  const frame = useMemo(() => {
    const frame = resolveProgramFrame({
      config,
      snapshot: {
        live: liveItem,
        staged: null,
        settings,
        props: propItems,
        lower_third: currentLowerThird,
        revision: 0,
      },
      fps,
    });
    frame.appDataDir = appDataDir;
    return frame;
  }, [config, liveItem, settings, propItems, currentLowerThird, appDataDir, fps]);

  return (
    <ProgramFeedCanvas
      geometry={geometry}
      frame={frame}
      cameraStreams={cameraStreams}
      fps={fps}
      className={className}
      onStream={onStream}
      active={active}
      onMissingMedia={onMissingMedia}
    />
  );
}