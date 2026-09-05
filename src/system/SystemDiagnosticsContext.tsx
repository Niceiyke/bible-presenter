import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readCaptureFps } from "./captureMetrics";
import { computeCapabilities } from "./capabilities";
import type { SystemChecks, SystemMetrics } from "../types/system";

/**
 * System diagnostics provider (Phase 7).
 *
 * Runs the readiness/check battery once on mount (plus on explicit refresh)
 * and derives `SystemCapabilities` from it. Live metrics are polled ONLY while
 * `monitorActive` is set — the Diagnostics workspace sets it on mount so the
 * polling cost is zero when the operator is anywhere else. Consumed via
 * `useSystemDiagnostics()` (SystemTab for the report, StreamerTab for gating).
 */

interface MonitorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

interface SystemDiagnosticsValue {
  checks: SystemChecks | null;
  metrics: SystemMetrics | null;
  monitorActive: boolean;
  setMonitorActive: (active: boolean) => void;
  loading: boolean;
  refresh: () => Promise<void>;
  lastError: string | null;
}

const SystemDiagnosticsContext = createContext<SystemDiagnosticsValue | null>(null);

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function probeH264(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    const supported = await VideoEncoder.isConfigSupported({
      codec: "avc1.42001f",
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
    });
    return supported.supported ?? false;
  } catch {
    return false;
  }
}

async function runChecks(): Promise<SystemChecks> {
  const [backendInfo, monitorInfo, h264Supported, devices, ndiStatus] = await Promise.all([
    isTauri()
      ? invoke<{
          cpu_model: string;
          physical_cores: number | null;
          total_ram_mb: number;
          total_disk_mb: number;
ffmpeg_available: boolean;
          h264_encoder: string;
          windows_graphics_capture_supported: boolean;
          windows_graphics_capture_reason: string;
        }>("system_info").catch(() => null)
      : Promise.resolve(null),
    isTauri()
      ? invoke<MonitorInfo[]>("get_available_monitors").catch(() => [] as MonitorInfo[])
      : Promise.resolve([] as MonitorInfo[]),
    probeH264(),
    navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? Promise.resolve([] as MediaDeviceInfo[]),
    isTauri()
      ? invoke<{ supported: boolean; reason: string }>("ndi_status").catch(() => ({ supported: false, reason: "Could not query the backend for NDI support." }))
      : Promise.resolve({ supported: false, reason: "NDI output requires the desktop app." }),
  ]);

  const webrtcAvailable = typeof RTCPeerConnection !== "undefined";
  const audioInputPresent = devices.some((d) => d.kind === "audioinput");
  const cameraPresent = devices.some((d) => d.kind === "videoinput");
  const hardwareConcurrency = navigator.hardwareConcurrency ?? 4;
  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;

  const capabilities = computeCapabilities({
    h264Supported,
    ffmpegAvailable: backendInfo?.ffmpeg_available ?? false,
    webrtcAvailable,
    audioInputPresent,
    cameraPresent,
    ndiSupported: ndiStatus.supported,
    ndiReason: ndiStatus.reason,
    monitors: monitorInfo.length,
    hardwareConcurrency,
    deviceMemory,
  });

  return {
    info: backendInfo
      ? {
          cpu_model: backendInfo.cpu_model,
          physical_cores: backendInfo.physical_cores,
          total_ram_mb: backendInfo.total_ram_mb,
          total_disk_mb: backendInfo.total_disk_mb,
ffmpeg_available: backendInfo.ffmpeg_available,
          h264_encoder: backendInfo.h264_encoder,
          windows_graphics_capture_supported: backendInfo.windows_graphics_capture_supported,
          windows_graphics_capture_reason: backendInfo.windows_graphics_capture_reason,
        }
      : null,
    h264Supported,
    webrtcAvailable,
    audioInputPresent,
    cameraPresent,
    monitors: monitorInfo.length,
    hardwareConcurrency,
    deviceMemory,
    capabilities,
    checkedAt: Date.now(),
  };
}

export function SystemDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [checks, setChecks] = useState<SystemChecks | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [monitorActive, setMonitorActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    try {
      const result = await runChecks();
      if (mountedRef.current) setChecks(result);
    } catch (err) {
      if (mountedRef.current) setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live metrics poll — only while the Diagnostics panel is open.
  useEffect(() => {
    if (!monitorActive || !isTauri()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const m = await invoke<SystemMetrics>("system_metrics");
        if (!cancelled) setMetrics(m);
      } catch {
        if (!cancelled) setMetrics(null);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [monitorActive]);

  const value = useMemo<SystemDiagnosticsValue>(
    () => ({
      checks,
      metrics,
      monitorActive,
      setMonitorActive,
      loading,
      refresh,
      lastError,
    }),
    [checks, metrics, monitorActive, loading, refresh, lastError],
  );

  return <SystemDiagnosticsContext.Provider value={value}>{children}</SystemDiagnosticsContext.Provider>;
}

export function useSystemDiagnostics(): SystemDiagnosticsValue {
  const ctx = useContext(SystemDiagnosticsContext);
  if (!ctx) throw new Error("useSystemDiagnostics must be used within SystemDiagnosticsProvider");
  return ctx;
}

/** Convenience: latest compositor capture FPS from the rolling counter. */
export function useCaptureFps(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFps(readCaptureFps()), 1000);
    return () => clearInterval(id);
  }, []);
  return fps;
}
