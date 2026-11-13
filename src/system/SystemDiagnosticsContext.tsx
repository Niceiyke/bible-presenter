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
import { computeCapabilities } from "./capabilities";
import type {
  ReleaseCheck,
  ReleaseReadiness,
  SystemChecks,
  SystemMetrics,
} from "../types/system";

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
  readiness: ReleaseReadiness | null;
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
      ? invoke<{ supported: boolean; reason: string }>("ndi_status").catch(() => ({ supported: false, reason: "Could not check NDI support." }))
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

interface StartupStatus {
  db_ok: boolean;
  issues: string[];
}

interface ManagedAiStatus {
  available: boolean;
  addonActive: boolean;
  availableUnitsRemaining: number;
  message: string;
}

interface OutputConfigProbe {
  id: string;
  enabled: boolean;
  visible: boolean;
  window_label?: string;
}

interface OutputStateProbe {
  id: string;
  rendering: boolean;
  error?: string;
}

interface RecordingStatusProbe {
  active: boolean;
  error?: string | null;
}

interface StreamingStatusProbe {
  active: boolean;
  destinations: Array<{ label: string; active: boolean; error?: string | null }>;
}

function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function createReadinessCheck(
  id: string,
  label: string,
  status: ReleaseCheck["status"],
  detail: string,
): ReleaseCheck {
  return { id, label, status, detail };
}

async function runReadinessChecks(systemChecks: SystemChecks | null): Promise<ReleaseReadiness> {
  if (!isTauri()) {
    return {
      checkedAt: Date.now(),
      checks: [createReadinessCheck("desktop", "Wordlyte desktop", "warn", "Run this check inside the Wordlyte desktop app.")],
    };
  }

  const results = await Promise.allSettled([
    invoke<StartupStatus>("get_startup_status"),
    invoke<string[]>("get_bible_versions"),
    invoke<string[]>("audio_devices"),
    invoke<ManagedAiStatus>("ai_presentation_status"),
    invoke<OutputConfigProbe[]>("outputs_list"),
    invoke<OutputStateProbe[]>("outputs_states"),
    invoke<RecordingStatusProbe>("recording_status"),
    invoke<StreamingStatusProbe>("stream_rtmp_status"),
  ]);

  const startup = fulfilled(results[0]);
  const versions = fulfilled(results[1]);
  const audioDevices = fulfilled(results[2]);
  const managedAi = fulfilled(results[3]);
  const outputConfigs = fulfilled(results[4]);
  const outputStates = fulfilled(results[5]);
  const recording = fulfilled(results[6]);
  const streaming = fulfilled(results[7]);
  const checks: ReleaseCheck[] = [];

  checks.push(startup
    ? startup.db_ok && startup.issues.length === 0
      ? createReadinessCheck("storage", "Saved Wordlyte data", "pass", "Your Wordlyte data opened successfully.")
      : createReadinessCheck("storage", "Saved Wordlyte data", "fail", startup.issues.join(" ") || "Wordlyte could not open your saved Bible data.")
    : createReadinessCheck("storage", "Saved Wordlyte data", "fail", "Could not verify your saved Wordlyte data."));

  checks.push(versions
    ? versions.length > 0
      ? createReadinessCheck("bible", "Bible library", "pass", `${versions.length} Bible version${versions.length === 1 ? "" : "s"} available.`)
      : createReadinessCheck("bible", "Bible library", "fail", "No Bible versions are available. Download or restore the Bible library before service.")
    : createReadinessCheck("bible", "Bible library", "fail", "Could not check Bible versions."));

  checks.push(audioDevices
    ? audioDevices.length > 0
      ? createReadinessCheck("audio", "Audio input", "pass", `${audioDevices.length} audio input${audioDevices.length === 1 ? "" : "s"} detected.`)
      : createReadinessCheck("audio", "Audio input", "warn", "No audio input detected. AI Scripture, recording, and stream audio need a selected device.")
    : createReadinessCheck("audio", "Audio input", "warn", "Could not check audio inputs."));

  checks.push(managedAi?.available
    ? createReadinessCheck("ai-provider", "Wordlyte AI", "pass", `${managedAi.availableUnitsRemaining.toLocaleString()} AI Units available for transcription and drafting.`)
    : createReadinessCheck("ai-provider", "Wordlyte AI", "warn", managedAi?.message || "AI features are unavailable until your organization has AI Units or an active AI Add-on."));

  const outputIds = new Set((outputConfigs ?? []).map((output) => output.id));
  const outputStateErrors = (outputStates ?? []).filter((state) => state.error).map((state) => `${state.id}: ${state.error}`);
  const outputConfigured = outputIds.has("output") && outputIds.has("stage");
  const outputVisible = outputConfigs?.find((output) => output.id === "output")?.visible === true;
  checks.push(outputConfigured && outputStateErrors.length === 0
    ? createReadinessCheck("output", "Audience output", outputVisible ? "pass" : "warn", outputVisible ? "The audience output and stage monitor are configured and the output window is open." : "The audience output and stage monitor are configured. Open the output window before service.")
    : createReadinessCheck("output", "Audience output", "fail", outputStateErrors.join(" ") || "The audience output or stage monitor is not configured."));

  const captureReady = systemChecks?.info?.ffmpeg_available && systemChecks.info.windows_graphics_capture_supported;
  checks.push(captureReady
    ? createReadinessCheck("capture", "Recording and streaming", "pass", "Recording and streaming are ready on this computer.")
    : createReadinessCheck("capture", "Recording and streaming", "fail", systemChecks?.info?.windows_graphics_capture_reason || "Recording or streaming is unavailable on this computer."));

  const recordingError = recording?.error;
  checks.push(recordingError
    ? createReadinessCheck("recording", "Recording", "fail", `Recording reported an error: ${recordingError}`)
    : createReadinessCheck("recording", "Recording", "pass", recording?.active ? "Recording is active." : "Recording is ready."));

  const streamErrors = streaming?.destinations?.filter((destination) => destination.error || (streaming.active && !destination.active)).map((destination) => `${destination.label}: ${destination.error || "not connected"}`) ?? [];
  checks.push(streamErrors.length > 0
    ? createReadinessCheck("streaming", "Streaming", "fail", streamErrors.join(" "))
    : createReadinessCheck("streaming", "Streaming", "pass", streaming?.active ? "The broadcast is active and destinations are healthy." : "Streaming is ready."));

  return { checks, checkedAt: Date.now() };
}

export function SystemDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [checks, setChecks] = useState<SystemChecks | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [readiness, setReadiness] = useState<ReleaseReadiness | null>(null);
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
      if (mountedRef.current) {
        setChecks(result);
        setReadiness(await runReadinessChecks(result));
      }
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
      readiness,
      monitorActive,
      setMonitorActive,
      loading,
      refresh,
      lastError,
    }),
    [checks, metrics, readiness, monitorActive, loading, refresh, lastError],
  );

  return <SystemDiagnosticsContext.Provider value={value}>{children}</SystemDiagnosticsContext.Provider>;
}

export function useSystemDiagnostics(): SystemDiagnosticsValue {
  const ctx = useContext(SystemDiagnosticsContext);
  if (!ctx) throw new Error("useSystemDiagnostics must be used within SystemDiagnosticsProvider");
  return ctx;
}
