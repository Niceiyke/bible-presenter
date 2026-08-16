import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  HardDrive,
  Mic,
  Monitor,
  Radio,
  RefreshCw,
  Video,
  XCircle,
  MemoryStick,
} from "lucide-react";
import { useCaptureFps, useSystemDiagnostics } from "../system/SystemDiagnosticsContext";
import type { SystemChecks, SystemMetrics } from "../types/system";

/**
 * `SystemTab` — System → Diagnostics workspace (Phase 7).
 *
 * Readiness checklist + hardware summary + live performance monitor. The check
 * battery runs once on app start (provider); this panel re-runs it on demand
 * and — while mounted — activates the metrics poll (CPU / RAM / disk / compositor
 * capture FPS / active RTMP sessions).
 */
export function SystemTab() {
  const { checks, metrics, monitorActive, setMonitorActive, loading, refresh, lastError } =
    useSystemDiagnostics();
  const captureFps = useCaptureFps();

  React.useEffect(() => {
    setMonitorActive(true);
    return () => setMonitorActive(false);
  }, [setMonitorActive]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <Gauge size={12} /> System Diagnostics
        </h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[10px] font-bold uppercase tracking-wider border border-slate-700 transition-all"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} /> Run checks
        </button>
      </div>

      {lastError && (
        <p className="text-[11px] text-red-400 p-2 rounded-lg border border-red-800 bg-red-950/40">
          {lastError}
        </p>
      )}

      {!checks ? (
        <p className="text-[11px] text-slate-500 p-3 rounded-lg border border-dashed border-slate-700">
          Running system checks… (H.264 encode probe can take a moment)
        </p>
      ) : (
        <>
          <HardwareSummary checks={checks} />
          <ReadinessChecklist checks={checks} />
          <CapabilityReport checks={checks} />
          <PerformanceMonitor checks={checks} metrics={metrics} captureFps={captureFps} monitoring={monitorActive} />
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
      <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">{title}</h3>
      {children}
    </div>
  );
}

function HardwareSummary({ checks }: { checks: SystemChecks }) {
  const info = checks.info;
  return (
    <Card title="Hardware">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryItem icon={Cpu} label="CPU" value={info ? info.cpu_model : "Unknown"} detail={info?.physical_cores ? `${info.physical_cores} cores` : undefined} />
        <SummaryItem icon={MemoryStick} label="RAM" value={info ? `${(info.total_ram_mb / 1024).toFixed(1)} GB` : "Unknown"} />
        <SummaryItem icon={HardDrive} label="Disk" value={info ? `${(info.total_disk_mb / 1024).toFixed(0)} GB` : "Unknown"} />
        <SummaryItem
          icon={Radio}
          label="ffmpeg"
          value={info?.ffmpeg_available ? "Available" : "Missing"}
          ok={info?.ffmpeg_available}
        />
      </div>
      {!info && (
        <p className="text-[10px] text-slate-600 mt-2">
          Backend unavailable (running in a browser) — hardware details not collected.
        </p>
      )}
    </Card>
  );
}

function SummaryItem({
  icon: Icon,
  label,
  value,
  detail,
  ok,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  detail?: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <Icon size={14} className="mt-0.5 shrink-0 text-slate-500" />
      <div className="min-w-0">
        <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
        <p className={`text-[11px] font-bold truncate ${ok === undefined ? "text-slate-200" : ok ? "text-green-400" : "text-red-400"}`}>
          {value}
        </p>
        {detail && <p className="text-[10px] text-slate-600 truncate">{detail}</p>}
      </div>
    </div>
  );
}

function ReadinessChecklist({ checks }: { checks: SystemChecks }) {
  const rows = [
    { label: "WebCodecs H.264 encode", ok: checks.h264Supported, detail: checks.h264Supported ? "VideoEncoder + avc1 supported" : "Unavailable in this WebView2 build" },
    { label: "ffmpeg on PATH", ok: checks.info?.ffmpeg_available ?? false, detail: "Required for RTMP destinations" },
    { label: "WebRTC (WHIP)", ok: checks.webrtcAvailable, detail: checks.webrtcAvailable ? "RTCPeerConnection available" : "Unavailable" },
    { label: "Audio input", ok: checks.audioInputPresent, detail: checks.audioInputPresent ? "Microphone / line-in detected" : "No microphone / line-in detected" },
    { label: "Camera", ok: checks.cameraPresent, detail: checks.cameraPresent ? "Camera detected" : "No camera detected" },
    { label: "Displays", ok: checks.monitors >= 1, detail: checks.monitors >= 1 ? `${checks.monitors} monitor(s) for output/stage` : "No external displays detected" },
    { label: "Web assets", ok: true, detail: `${checks.hardwareConcurrency} threads, ${checks.deviceMemory} GB device memory` },
  ];
  return (
    <Card title="Readiness Checklist">
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.ok ? (
              <CheckCircle2 size={14} className="text-green-500 shrink-0" />
            ) : (
              <XCircle size={14} className="text-red-500 shrink-0" />
            )}
            <span className={`text-[11px] font-bold ${r.ok ? "text-slate-300" : "text-red-400"}`}>{r.label}</span>
            <span className="text-[10px] text-slate-600 truncate">{r.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CapabilityReport({ checks }: { checks: SystemChecks }) {
  const c = checks.capabilities;
  const services: { name: string; available: boolean; reason: string }[] = [
    { name: "RTMP streaming", available: c.rtmpAvailable, reason: c.rtmpReason },
    { name: "WHIP streaming", available: c.whipAvailable, reason: c.whipAvailable ? "WebRTC available — sub-second latency." : "WebRTC unavailable in this build." },
    { name: "Shared audio input", available: c.audioAvailable, reason: c.audioReason },
    { name: "Camera sources", available: c.cameraAvailable, reason: c.cameraReason },
    { name: "Output / stage windows", available: c.monitorsAvailable, reason: c.monitorsAvailable ? "At least one display is available." : "No display detected for output/stage windows." },
  ];
  return (
    <Card title="Capabilities & Service Gating">
      <p className="text-[10px] text-slate-500 mb-2">
        Services are gated by these checks — disabled ones stay visible in their workspaces but can't be started, so the
        operator always knows <em>why</em>.
      </p>
      <ul className="flex flex-col gap-1.5">
        {services.map((s) => (
          <li key={s.name} className="flex items-start gap-2">
            {s.available ? (
              <CheckCircle2 size={14} className="text-green-500 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
            )}
            <div>
              <p className={`text-[11px] font-bold ${s.available ? "text-slate-300" : "text-amber-400"}`}>{s.name}</p>
              <p className="text-[10px] text-slate-600">{s.reason}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2 p-2 rounded-md border border-slate-800 bg-slate-950/50">
        <Radio size={13} className="text-slate-500 shrink-0" />
        <span className="text-[10px] text-slate-500">
          Estimated capacity:{" "}
          <span className="font-bold text-slate-300">
            {c.streamingCapacityTier.toUpperCase()} tier
          </span>{" "}
          — about <span className="font-bold text-slate-300">{c.recommendedMaxStreams} simultaneous</span>{" "}
          RTMP stream(s){" "}
          {c.hwAccelLikely ? "with hardware-accelerated encoding likely" : "(software encoding)"}.
        </span>
      </div>
    </Card>
  );
}

function PerformanceMonitor({
  checks,
  metrics,
  captureFps,
  monitoring,
}: {
  checks: SystemChecks;
  metrics: SystemMetrics | null;
  captureFps: number;
  monitoring: boolean;
}) {
  const bars = metrics
    ? [
        { label: "CPU", value: metrics.cpu_usage_percent },
        { label: "RAM", value: metrics.used_ram_percent },
        { label: "Disk", value: metrics.used_disk_percent },
      ]
    : [];
  return (
    <Card title="Live Performance">
      <div className="flex flex-col gap-1.5">
        {monitoring && metrics ? (
          <>
            {bars.map((b) => (
              <div key={b.label} className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-400 w-8">{b.label}</span>
                <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      b.value > 90 ? "bg-red-500" : b.value > 70 ? "bg-amber-500" : "bg-cyan-500"
                    }`}
                    style={{ width: `${Math.min(100, b.value)}%` }}
                  />
                </div>
                <span className="text-[10px] text-slate-500 w-10 text-right">{b.value.toFixed(0)}%</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 w-8">FPS</span>
              <div className="flex-1 flex items-center gap-2">
                <span className={`text-[11px] font-bold ${captureFps >= 25 ? "text-green-400" : captureFps > 0 ? "text-amber-400" : "text-slate-600"}`}>
                  {captureFps > 0 ? captureFps.toFixed(1) : "—"} / 30
                </span>
                <span className="text-[10px] text-slate-600">
                  compositor capture {captureFps > 0 && captureFps < 25 ? "— behind target, consider lowering previews" : "— on target"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 w-8">RTMP</span>
              <span className="text-[11px] font-bold text-slate-300">
                {metrics.active_rtmp_sessions > 0 ? (
                  <span className="text-red-400">{metrics.active_rtmp_sessions} live session(s)</span>
                ) : (
                  "idle"
                )}
              </span>
            </div>
          </>
        ) : (
          <p className="text-[10px] text-slate-600 flex items-center gap-1.5">
            <Activity size={11} /> Polling is active while this panel is open — CPU / RAM / disk / capture FPS update every 3s.
          </p>
        )}
      </div>
    </Card>
  );
}