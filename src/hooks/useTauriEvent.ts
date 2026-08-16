import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Typed Tauri event channel map. Every event the app emits has a payload type
 * here; the backend's `emit_checked` helper forwards emit failures to
 * `system-log`, whose payload is also typed below.
 */
export interface EventMap {
  "live-item-update": { detected_item: import("../types").DisplayItem | null };
  "item-staged": import("../types").DisplayItem | null;
  "settings-changed": import("../types").PresentationSettings;
  "lower-third-update": { data: any; template: any } | null;
  "props-update": import("../types").PropItem[];
  "media-control": { action: string; volume?: number; currentTime?: number; rate?: number };
  "media-state": { playing: boolean; currentTime: number; duration: number; volume: number; muted: boolean; rate: number } | null;
  "songs-sync": import("../types").Song[];
  "studio-sync": any[];
  "studio-slides-sync": { id: string; slides: any[] };
  "lower-third-template-sync": import("../types").LowerThirdTemplate[];
  "system-log": { level: string; message: string; timestamp: number };
  "operator-warning": { message: string; level?: string };
  "download-progress": { progress: number };
  "phone-camera-offer": { device_id: string; device_name: string; sdp: string; target?: "operator" | "output" };
  "phone-camera-ice": { device_id: string; candidate: string; sdp_mid: string; sdp_m_line_index: number; target?: "operator" | "output" };
  "phone-camera-stop": { device_id: string };
  "phone-cameras-changed": { cameras: { device_id: string; device_name: string; orientation?: "portrait" | "landscape" }[] };
  "remote-device-event": { event: "connected" | "disconnected" | "revoked" | "auto_revoked"; device_name: string };
  "output-config-changed": import("../types").OutputConfig[];
  "output-state-changed": import("../types").OutputState;
}

export type TauriEventName = keyof EventMap;

/**
 * Subscribe to a typed Tauri event for the lifetime of the calling component.
 * The handler is kept in a ref so the listener is registered once and never
 * goes stale on re-render. Returns nothing; cleanup is handled internally.
 */
export function useTauriEvent<K extends TauriEventName>(
  event: K,
  handler: (payload: EventMap[K]) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let cancelled = false;
    listen<any>(event as string, (e) => {
      if (!cancelled) ref.current(e.payload as EventMap[K]);
    }).then((f) => {
      un = f;
      if (cancelled) { f(); un = undefined; }
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [event]);
}
