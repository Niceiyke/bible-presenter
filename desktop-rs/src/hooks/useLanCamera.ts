/**
 * Compatibility shim — wraps the new modular `useCameraManager` and maps its
 * API to the legacy shape expected by App.tsx, MediaTab.tsx, and ContentBrowser.tsx.
 *
 * Migration path:
 *   - New code should import directly from `../features/camera`
 *   - Old consumers can continue using this hook unchanged
 */
import { useMemo, useRef, useCallback } from "react";
import { useCameraManager } from "../features/camera";
import type { CameraSource as NewCameraSource } from "../features/camera/types";
import type { CameraSource } from "../types";

/** Map new (camelCase) CameraSource → legacy (snake_case) CameraSource. */
function toLegacySource(s: NewCameraSource): CameraSource {
  return {
    device_id: s.deviceId,
    device_name: s.deviceName,
    previewStream: s.previewStream,
    previewPc: null,          // internal to usePublisherPc; not exposed
    status: s.status,
    connectedAt: s.connectedAt,
    battery: s.quality.batteryPct,
    lastTelemetryAt: s.quality.updatedAtMs || undefined,
    enabled: s.status === "connected",
  };
}

export function useLanCamera(pin: string | null, label: string) {
  const {
    sources,
    attachPreview,
    setProgram,
    registerSceneHandler,
    unregisterSceneHandler,
  } = useCameraManager({ pin, windowLabel: label });

  // Derive legacy-typed Map from new sources.
  // useMemo keeps the reference stable across renders when sources don't change.
  const cameraSources = useMemo<Map<string, CameraSource>>(
    () => new Map([...sources.entries()].map(([id, s]) => [id, toLegacySource(s)])),
    [sources],
  );

  // Legacy refs expected by MediaTab: a Map<deviceId, HTMLVideoElement>.
  // We intercept .set() via a Proxy so that attaching a video element also
  // calls attachPreview, ensuring new tracks auto-flow to the element.
  const rawVideoMapRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const previewVideoMapRef = useRef<Map<string, HTMLVideoElement>>(
    new Proxy(rawVideoMapRef.current, {
      get(target, prop) {
        if (prop === "set") {
          return (deviceId: string, el: HTMLVideoElement | null) => {
            if (el) {
              target.set(deviceId, el);
            } else {
              target.delete(deviceId);
            }
            // Wire the video element into the new system
            attachPreview(deviceId, el);
          };
        }
        const val = (target as any)[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    }),
  );
  const previewObserverMapRef = useRef<Map<string, IntersectionObserver>>(new Map());

  // Legacy enable/disable — in the new system all preview PCs are managed
  // automatically, so enable is a no-op and disable detaches the video element.
  const enableCameraPreview = useCallback((_deviceId: string) => {
    // Preview PCs are auto-managed by useCameraManager on offer receipt.
  }, []);

  const disableCameraPreview = useCallback((deviceId: string) => {
    attachPreview(deviceId, null);
  }, [attachPreview]);

  const removeCameraSource = useCallback((deviceId: string) => {
    attachPreview(deviceId, null);
    // The source will be removed from `sources` when the mobile disconnects.
  }, [attachPreview]);

  /** Legacy setLiveCamera → setProgram in new API. */
  const setLiveCamera = useCallback(
    (deviceId: string | null, slot: "A" | "B" = "A") => {
      setProgram(deviceId, slot);
    },
    [setProgram],
  );

  return {
    cameraSources,
    enableCameraPreview,
    disableCameraPreview,
    removeCameraSource,
    previewVideoMapRef,
    previewObserverMapRef,
    setLiveCamera,
    // Expose new-API extras for consumers that want to migrate gradually
    registerSceneHandler,
    unregisterSceneHandler,
  };
}
