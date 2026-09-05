import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store";
import { resolveOutputFrame } from "../../outputs/resolveOutputFrame";
import { ProgramSurface } from "./ProgramSurface";
import { collectCameraDeviceIds } from "./canvasProgramFeed";
import { usePhoneCameraStreams } from "../../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStreams } from "../../hooks/useSharedLocalCameraStream";

/**
 * `ProgramSurfacePreview` — operator-facing DOM preview of the broadcast
 * program, rendered by the SAME `ProgramSurface` that drives the output
 * window (mode="preview", silent). This replaces the Phase 2 canvas compositor
 * preview in the Cockpit: there is now a single DOM renderer for program
 * pixels, and no second canvas renderer for the operator console.
 */
export function ProgramSurfacePreview({
  className,
}: {
  className?: string;
}) {
  const liveItem = useAppStore((s) => s.liveItem);
  const stagedItem = useAppStore((s) => s.stagedItem);
  const settings = useAppStore((s) => s.settings);
  const propItems = useAppStore((s) => s.propItems);
  const currentLowerThird = useAppStore((s) => s.currentLowerThird);
  const appDataDir = useAppStore((s) => s.appDataDir);
  const license = useAppStore((s) => s.license);

  // Camera feeds: relayed phone streams (live in the provider context) plus
  // native local streams for every camera the frame references.
  const phoneStreams = usePhoneCameraStreams();
  const cameraIds = useMemo(() => collectCameraDeviceIds(liveItem, settings), [liveItem, settings]);
  const localStreams = useSharedLocalCameraStreams(cameraIds, "program-surface-preview");
  const cameraStreams = useMemo(() => {
    const out: Record<string, MediaStream> = { ...localStreams };
    for (const [deviceId, s] of Object.entries(phoneStreams)) out[deviceId] = s;
    return out;
  }, [localStreams, phoneStreams]);

  const frame = useMemo(
    () =>
      resolveOutputFrame({
        live: liveItem,
        staged: stagedItem,
        settings,
        lowerThird: currentLowerThird,
        propItems,
        config: null,
        license,
      }),
    [liveItem, stagedItem, settings, propItems, currentLowerThird, license],
  );

  // Compute the DOM scale from this preview's own height relative to the
  // effective reference height, so authored proportions match the output
  // regardless of the cockpit's resizable width/height.
  const hostRef = useRef<HTMLDivElement>(null);
  const referenceHeight = frame.referenceOutputHeight;
  const [previewHeight, setPreviewHeight] = useState(0);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setPreviewHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const windowScale = previewHeight > 0 ? previewHeight / referenceHeight : 0.25;

  // Throwaway transports: the preview is visual-only (silent), so it never
  // wires real playback or audio.
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const bgAudioRef = useRef<HTMLAudioElement>(null);

  const liveCameraId = liveItem?.type === "Camera" ? liveItem.data.deviceId : null;
  const mainCameraStream = liveCameraId ? (cameraStreams[liveCameraId] ?? null) : null;
  const cameraStream = frame.backgrounds.camera?.deviceId
    ? (cameraStreams[frame.backgrounds.camera.deviceId] ?? null)
    : null;

  return (
    <div ref={hostRef} className={className ?? "relative w-full h-full"}>
      <ProgramSurface
        mode="preview"
        silent
        frame={frame}
        runtime={{
          windowScale,
          appDataDir,
          monitorTest: false,
          videoRef,
          bgVideoRef,
          bgAudioRef,
          cameraStream,
          mainCameraStream,
          phoneStreams: cameraStreams,
        }}
      />
    </div>
  );
}
