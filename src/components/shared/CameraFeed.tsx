import { useEffect, useId, useState } from "react";
import type { RefObject } from "react";
import PhoneCameraVideo from "./PhoneCameraVideo";
import { useAppStore } from "../../store";
import { usePhoneCameraStreams, usePhoneCameraStates } from "../../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStream } from "../../hooks/useSharedLocalCameraStream";
import type { PhoneCameraOrientation } from "../../types/remote";

interface FeedStatus {
  connected: boolean;
  error: string | null;
}

/**
 * Renders the live feed for ANY camera: phone cameras read the WebRTC relayed
 * stream (never getUserMedia), local webcams share one cached stream per device
 * across every surface. Orientation override only applies to phone feeds (local
 * webcams are already natively oriented); look/mirror/backdrop apply to both.
 */
export function CameraFeed({
  deviceId,
  objectFit = "cover",
  reportedOrientation,
  onMetadata,
  onStatus,
  videoRef,
}: {
  deviceId: string;
  objectFit?: "contain" | "cover";
  reportedOrientation?: PhoneCameraOrientation;
  onMetadata?: (w: number, h: number) => void;
  onStatus?: (s: FeedStatus) => void;
  videoRef?: (el: HTMLVideoElement | null) => void;
}) {
  const uid = useId();
  const isPhone = deviceId.startsWith("phone-camera-");
  const phoneStreams = usePhoneCameraStreams();
  const phoneStates = usePhoneCameraStates();
  const { cameraOrientations, cameraLook, cameraDefaults, cameraChroma } = useAppStore();
  const local = useSharedLocalCameraStream(isPhone ? null : deviceId, uid);

  const stream = isPhone ? (phoneStreams[deviceId] ?? null) : local.stream;
  const state = phoneStates[deviceId];
  const connected = isPhone ? state === "connected" || (state == null && !!stream) : local.connected;
  const orientation = isPhone ? (cameraOrientations[deviceId] ?? reportedOrientation ?? "portrait") : null;
  const look = cameraLook[deviceId] ?? null;
  const mirrored = cameraDefaults[deviceId]?.mirrored ?? false;
  const backdrop = cameraDefaults[deviceId]?.backdropColor;
  const chroma = cameraChroma[deviceId] ?? null;

  useEffect(() => {
    onStatus?.({ connected, error: isPhone ? null : local.error });
  }, [connected, isPhone, local.error, onStatus]);

  return (
    <div className="relative w-full h-full">
      {backdrop ? <div className="absolute inset-0" style={{ background: backdrop }} /> : null}
      <div className="absolute inset-0">
        <PhoneCameraVideo
          stream={stream}
          orientation={orientation}
          look={look}
          mirrored={mirrored}
          objectFit={objectFit}
          onMetadata={onMetadata}
          videoRef={videoRef}
          chromaKey={chroma}
        />
      </div>
    </div>
  );
}

/**
 * Samples fps + resolution from a camera <video> element (WebRTC-free feeds,
 * i.e. local webcams). Re-runs whenever `dep` changes (e.g. the selected
 * camera id). Falls back to requestAnimationFrame where
 * requestVideoFrameCallback is unavailable.
 */
export function useLocalFeedStats(
  videoRef: RefObject<HTMLVideoElement | null>,
  dep: unknown
): { fps: number | null; width: number | null; height: number | null } {
  const [stats, setStats] = useState<{ fps: number | null; width: number | null; height: number | null }>({
    fps: null,
    width: null,
    height: null,
  });

  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      setStats({ fps: null, width: null, height: null });
      return;
    }
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    setStats({ fps: null, width: el.videoWidth || null, height: el.videoHeight || null });

    const tick = (now: number) => {
      frames++;
      const dt = now - last;
      if (dt >= 1000) {
        setStats((prev) => ({
          fps: Math.round((frames * 1000) / dt),
          width: el.videoWidth || prev.width,
          height: el.videoHeight || prev.height,
        }));
        frames = 0;
        last = now;
      }
      if (el.isConnected) {
        raf = el.requestVideoFrameCallback?.(tick) ?? window.requestAnimationFrame(tick);
      }
    };
    raf = el.requestVideoFrameCallback?.(tick) ?? window.requestAnimationFrame(tick);
    return () => {
      if (raf) {
        if (el.cancelVideoFrameCallback) el.cancelVideoFrameCallback(raf);
        else cancelAnimationFrame(raf);
      }
    };
  }, [dep]);

  return stats;
}
