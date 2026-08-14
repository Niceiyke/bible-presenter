import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PhoneCameraOrientation } from "../../types/remote";

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

  const transform = rotate
    ? `rotate(90deg) scale(${scale}) scaleX(${mirrored ? -1 : 1})`
    : mirrored
      ? "scaleX(-1)"
      : "none";

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
        }}
        className={"absolute inset-0 w-full h-full " + (className ?? "")}
        style={{ objectFit: rotate ? "contain" : objectFit, ...style, transform }}
      />
    </div>
  );
}