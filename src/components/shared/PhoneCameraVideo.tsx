import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PhoneCameraOrientation, CameraLook } from "../../types/remote";

const STORAGE_KEY = "cameraOrientations";

function readStoredOrientation(deviceId: string | null | undefined): PhoneCameraOrientation {
  if (!deviceId) return "portrait";
  try {
    const map = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, PhoneCameraOrientation>;
    return map?.[deviceId] ?? "portrait";
  } catch {
    return "portrait";
  }
}

/**
 * Reads the persisted per-phone-camera orientation. The operator windows
 * (main, output, stage) share the same WebView2 origin and localStorage, and
 * the main window writes this map on every change, so listening to the
 * `storage` event keeps auxiliary windows (which do not mount the operator
 * store) in sync.
 */
export function usePhoneCameraOrientation(deviceId: string | null | undefined): PhoneCameraOrientation {
  const [orientation, setOrientation] = useState<PhoneCameraOrientation>(() => readStoredOrientation(deviceId));
  useEffect(() => {
    setOrientation(readStoredOrientation(deviceId));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === STORAGE_KEY) {
        setOrientation(readStoredOrientation(deviceId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [deviceId]);
  return orientation;
}

const LOOK_STORAGE_KEY = "cameraLook";

function readStoredLook(deviceId: string | null | undefined): CameraLook | null {
  if (!deviceId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}") as Record<string, CameraLook>;
    return map?.[deviceId] ?? null;
  } catch {
    return null;
  }
}

/** Same localStorage + storage-event sync as `usePhoneCameraOrientation`, but
 *  for the per-feed color/crop tuning map. Used by windows that do not mount
 *  the operator store (output, stage). */
export function usePhoneCameraLook(deviceId: string | null | undefined): CameraLook | null {
  const [look, setLook] = useState<CameraLook | null>(() => readStoredLook(deviceId));
  useEffect(() => {
    setLook(readStoredLook(deviceId));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === LOOK_STORAGE_KEY) {
        setLook(readStoredLook(deviceId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [deviceId]);
  return look;
}

interface Props {
  /** Relayed MediaStream to show. When omitted, srcObject is managed by the
   *  caller through `videoRef` (e.g. PreviewCard's own getUserMedia flow). */
  stream?: MediaStream | null;
  orientation: PhoneCameraOrientation;
  mirrored?: boolean;
  /** object-fit used when NOT rotating. "landscape" always uses `contain` on
   *  the pre-rotation step so the whole frame is shown before being rotated
   *  and scaled to cover the container. */
  objectFit?: "contain" | "cover";
  /** Per-feed color/crop tuning (CSS filter + pan/zoom transform). */
  look?: CameraLook | null;
  /** Fires with the video frame dimensions once known (used for feed status). */
  onMetadata?: (w: number, h: number) => void;
  className?: string;
  style?: CSSProperties;
  /** Forwards the underlying <video> element so existing refs keep working. */
  videoRef?: (el: HTMLVideoElement | null) => void;
}

/**
 * Renders a camera feed with a per-camera display orientation. Phone cameras
 * stream whatever orientation the sensor produces (portrait when the phone is
 * held portrait); we can't re-orient the frames themselves, so "landscape"
 * rotates the video 90deg and scales it to cover the container. Used by the
 * operator preview (Cockpit, Camera tab) and the projected output window.
 */
export default function PhoneCameraVideo({
  stream,
  orientation,
  mirrored,
  objectFit = "cover",
  look,
  onMetadata,
  className,
  style,
  videoRef,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = localVideoRef.current;
    if (!el || stream === undefined) return;
    el.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rotate = orientation === "landscape";
  const scale =
    rotate && box && box.w > 0 && box.h > 0
      ? Math.max(box.w / box.h, videoSize && videoSize.h > 0 && videoSize.w > 0 ? videoSize.h / videoSize.w : 1.78)
      : 1;

  const base = rotate
    ? `rotate(90deg) scale(${scale}) scaleX(${mirrored ? -1 : 1})`
    : mirrored
      ? "scaleX(-1)"
      : "none";

  // User color/crop tuning: pan/zoom is prepended so it applies in the already
  // oriented frame's coordinate space; the filter is a plain CSS filter.
  const zoomT = look && look.zoom > 0 ? `translate(${look.panX ?? 0}%, ${look.panY ?? 0}%) scale(${look.zoom}) ` : "";
  const transform = zoomT ? `${zoomT}${base}` : base;
  const filter = look
    ? `brightness(${look.brightness}) contrast(${look.contrast}) saturate(${look.saturation})`
    : undefined;

  return (
    <div ref={boxRef} className="relative w-full h-full overflow-hidden">
      <video
        ref={(el) => {
          localVideoRef.current = el;
          videoRef?.(el);
        }}
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          setVideoSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
          if (e.currentTarget.videoWidth > 0 && e.currentTarget.videoHeight > 0) {
            onMetadata?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
          }
        }}
        className={"absolute inset-0 w-full h-full " + (className ?? "")}
        style={{ objectFit: rotate ? "contain" : objectFit, ...style, transform, filter }}
      />
    </div>
  );
}