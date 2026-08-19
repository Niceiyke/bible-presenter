import { useMemo } from "react";
import { useAppStore } from "../../store";
import { OUTPUT_SCHEMA_VERSION } from "../../types";
import type { OutputConfig } from "../../types";
import { ProgramFeedCanvas } from "./ProgramFeedCanvas";
import { collectCameraDeviceIds } from "./canvasProgramFeed";
import { resolveProgramFrame } from "../../compositor/ProgramFrameResolver";
import { usePhoneCameraStreams } from "../../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStreams } from "../../hooks/useSharedLocalCameraStream";
import { useOutputSnapshot } from "../../hooks/useOutputSnapshot";

/**
 * `ProgramFeedPreview` — operator-facing verification surface for the Phase 2/3
 * compositor. Resolves an `OutputConfig` against the authoritative
 * presentation snapshot through the SAME `resolveProgramFrame` path the
 * recorder/streamer surfaces capture, so changing an output's source,
 * presentation override, or overlay mask changes what the preview paints.
 *
 * Callers that own a persisted output (recording/streaming providers) pass the
 * actual `record-main`/`stream-main` `OutputConfig`. Callers that just want the
 * full unmasked live program (the Cockpit PGM toggle) pass no config and get
 * the legacy default live-source preview.
 *
 * Camera feeds come from the WebRTC phone relay (context) merged with native
 * local camera streams opened through the ref-counted shared cache. This is the
 * "single render path" validation point: what the DOM `PreviewCard` shows and
 * what this canvas produces must match.
 */
export function ProgramFeedPreview({
  config,
  geometry,
  fps,
  className,
  onStream,
  active = true,
  onMissingMedia,
}: {
  /** The authoritative output config this preview resolves. When absent the
   *  preview falls back to the full unmasked live program. */
  config?: OutputConfig;
  /** Legacy override — only used when no `config` is supplied. */
  geometry?: { width: number; height: number };
  /** Legacy override — only used when no `config` is supplied. */
  fps?: number;
  className?: string;
  onStream?: (stream: MediaStream | null) => void;
  active?: boolean;
  onMissingMedia?: (failedPaths: string[]) => void;
}) {
  const { snapshot, scenes, appDataDir } = useOutputSnapshot();

  // The preview is the program bus itself, so without an explicit config it
  // subscribes as the default live source with every overlay unmasked.
  const resolvedConfig: OutputConfig = useMemo(() => {
    if (config) return config;
    return {
      schema_version: OUTPUT_SCHEMA_VERSION,
      id: "program-preview",
      kind: "window",
      label: "Program Preview",
      enabled: true,
      visible: true,
      source: { type: "live" },
      geometry: { width: geometry?.width ?? 1920, height: geometry?.height ?? 1080 },
      capture_fps: fps ?? 30,
      overlays: { props: true, lower_third: true, logo: true },
    };
  }, [config, geometry?.width, geometry?.height, fps]);

  const effGeometry = resolvedConfig.geometry;
  const effFps = resolvedConfig.capture_fps ?? 30;

  // Camera feeds: relayed phone streams (live in the provider context) plus
  // native local streams for every camera device id the frame references.
  const phoneStreams = usePhoneCameraStreams();
  const cameraIds = useMemo(
    () => collectCameraDeviceIds(snapshot.live, snapshot.settings),
    [snapshot.live, snapshot.settings]
  );
  const localStreams = useSharedLocalCameraStreams(cameraIds, "program-feed-preview");

  const cameraStreams = useMemo(() => {
    const out: Record<string, MediaStream> = { ...localStreams };
    for (const [deviceId, s] of Object.entries(phoneStreams)) out[deviceId] = s;
    return out;
  }, [localStreams, phoneStreams]);

  const frame = useMemo(() => {
    const frame = resolveProgramFrame({
      config: resolvedConfig,
      snapshot,
      scenes,
      fps: effFps,
    });
    frame.appDataDir = appDataDir;
    return frame;
  }, [resolvedConfig, snapshot, scenes, effFps, appDataDir]);

  return (
    <ProgramFeedCanvas
      geometry={effGeometry}
      frame={frame}
      cameraStreams={cameraStreams}
      fps={effFps}
      className={className}
      onStream={onStream}
      active={active}
      onMissingMedia={onMissingMedia}
    />
  );
}
