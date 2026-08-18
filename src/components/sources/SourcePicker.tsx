import { Camera as CameraIcon } from "lucide-react";
import { useAppStore } from "../../store";
import { useSourceStatus } from "../../hooks/useCameraSource";
import type { SourceKind, SourceStatus } from "../../system/sourceRegistry";

const STATUS_STYLES: Record<SourceStatus, string> = {
  idle: "bg-slate-800 border-slate-700 text-slate-400",
  opening: "bg-amber-500/20 border-amber-600 text-amber-300",
  connected: "bg-emerald-500/20 border-emerald-600 text-emerald-300",
  error: "bg-red-900/40 border-red-800 text-red-400",
  reconnecting: "bg-amber-500/20 border-amber-600 text-amber-300",
  disconnected: "bg-slate-800 border-slate-700 text-slate-400",
};

const STATUS_LABELS: Record<SourceStatus, string> = {
  idle: "Available",
  opening: "Opening…",
  connected: "Live",
  error: "Unavailable",
  reconnecting: "Reconnecting…",
  disconnected: "Offline",
};

function StatusBadge({ status }: { status: SourceStatus }) {
  return (
    <span
      className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wider ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Unified camera source picker (Phase 5). Lists phone cameras (relayed over
 * WebRTC) and local webcams side by side with each source's live unified
 * status from the source registry. Synthetic `phone-camera-` / `native:` /
 * `ndi:` ids are listed but never sent to `getUserMedia` — only local sources
 * are acquired, and only when a consumer actually watches them.
 */
export function SourcePicker({
  onPick,
  selectedDeviceId,
}: {
  onPick: (deviceId: string, kind: SourceKind) => void;
  selectedDeviceId?: string | null;
}) {
  const availableCameras = useAppStore((s) => s.availableCameras);
  const phoneCameras = useAppStore((s) => s.phoneCameras);

  const phone = phoneCameras.map((c) => ({ deviceId: c.deviceId, label: c.label || "Phone Camera" }));
  const local = availableCameras.map((c) => ({
    deviceId: c.deviceId,
    label: c.label || "Local Camera",
  }));

  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
      <p className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Phone cameras</p>
      {phone.length === 0 && (
        <p className="text-xs text-console-text-subtle">No connected phones streaming a camera.</p>
      )}
      {phone.map((c) => (
        <SourceRow
          key={c.deviceId}
          deviceId={c.deviceId}
          label={c.label}
          kind="phone"
          iconClass="text-red-400"
          selected={selectedDeviceId === c.deviceId}
          onPick={onPick}
        />
      ))}
      <p className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle mt-2">Local cameras</p>
      {local.length === 0 && (
        <p className="text-xs text-console-text-subtle">No local cameras detected.</p>
      )}
      {local.map((c) => (
        <SourceRow
          key={c.deviceId}
          deviceId={c.deviceId}
          label={c.label}
          kind="local"
          iconClass="text-slate-400"
          selected={selectedDeviceId === c.deviceId}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function SourceRow({
  deviceId,
  label,
  kind,
  iconClass,
  selected,
  onPick,
}: {
  deviceId: string;
  label: string;
  kind: SourceKind;
  iconClass: string;
  selected: boolean;
  onPick: (deviceId: string, kind: SourceKind) => void;
}) {
  const status = useSourceStatus(deviceId);
  return (
    <button
      onClick={() => onPick(deviceId, kind)}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md bg-console-surface-raised border text-left transition-all ${
        selected ? "border-action-primary" : "border-console-border hover:border-action-primary"
      }`}
    >
      <CameraIcon size={13} className={iconClass} />
      <span className="text-xs text-console-text truncate">{label}</span>
      <StatusBadge status={status} />
    </button>
  );
}
