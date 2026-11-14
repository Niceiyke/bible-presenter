import { useEffect, useState } from "react";
import { AlertTriangle, CloudDownload, RefreshCw, X } from "lucide-react";
import type { ScheduleEntry } from "../types";
import {
  buildCloudPlanEntries,
  pullCloudSync,
  type CloudServicePlan,
  type CloudSyncResult,
} from "../platform/cloudSync";
import { Button, IconButton } from "./ui";

type CloudSyncPanelProps = {
  defaultBibleVersion: string;
  onClose: () => void;
  onImport: (entries: ScheduleEntry[], plan: CloudServicePlan) => Promise<void> | void;
};

export function CloudSyncPanel({ defaultBibleVersion, onClose, onImport }: CloudSyncPanelProps) {
  const [result, setResult] = useState<CloudSyncResult | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const next = await pullCloudSync();
      setResult(next);
      setSelectedPlanId((current) => current || next.servicePlans[0]?.id || "");
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedPlan = result?.servicePlans.find((plan) => plan.id === selectedPlanId) ?? null;

  async function importSelected() {
    if (!selectedPlan || !result) return;
    setImporting(true);
    setError(null);
    setWarnings([]);
    try {
      const imported = await buildCloudPlanEntries(selectedPlan, result, {
        defaultBibleVersion,
      });
      setWarnings(imported.warnings);
      if (imported.entries.length > 0) {
        await onImport(imported.entries, selectedPlan);
      }
    } catch (importError) {
      setError(messageOf(importError));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="rounded-lg border border-console-border bg-console-surface p-3">
      <div className="flex items-center gap-2">
        <CloudDownload size={13} className="text-action-primary" />
        <p className="flex-1 text-[10px] font-black uppercase tracking-widest text-console-text-muted">
          Pull from Dashboard
        </p>
        <IconButton label="Refresh cloud plans" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </IconButton>
        <IconButton label="Close cloud sync" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-console-text-muted">Checking the platform for published service plans...</p>
      ) : null}

      {error ? (
        <div className="mt-3 rounded border border-state-live/35 bg-state-live/10 px-2.5 py-2 text-xs text-state-live">
          {error}
        </div>
      ) : null}

      {!loading && result ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-console-text-subtle">
            <span>{result.organization.name}</span>
            <span>·</span>
            <span>{result.servicePlans.length} published plan{result.servicePlans.length === 1 ? "" : "s"}</span>
            <span>·</span>
            <span>Token expires {new Date(result.expiresAt * 1000).toLocaleTimeString()}</span>
          </div>

          {result.servicePlans.length === 0 ? (
            <p className="mt-3 text-xs text-console-text-muted">
              No published service plans are available for this organization.
            </p>
          ) : (
            <div className="mt-3 grid gap-1.5">
              {result.servicePlans.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => {
                    setSelectedPlanId(plan.id);
                    setWarnings([]);
                  }}
                  className={`flex items-center justify-between gap-3 rounded border px-2.5 py-2 text-left transition-colors ${
                    plan.id === selectedPlanId
                      ? "border-action-primary/45 bg-action-primary/10"
                      : "border-console-border bg-console-surface-raised hover:bg-console-surface-strong"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold text-console-text">{plan.title}</span>
                    <span className="block text-[10px] text-console-text-subtle">
                      {new Date(plan.serviceAt * 1000).toLocaleString()} · revision {plan.revision} · {plan.items.length} item{plan.items.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[9px] font-black uppercase tracking-wider text-console-text-muted">
                    {plan.status}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedPlan ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<CloudDownload size={12} />}
                loading={importing}
                onClick={() => void importSelected()}
              >
                Append to current service
              </Button>
              <span className="text-[10px] text-console-text-subtle">
                Presentation, Scripture, note, and custom items are supported.
              </span>
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="mt-3 rounded border border-state-stage/35 bg-state-stage/10 px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-state-stage">
                <AlertTriangle size={11} /> Sync warnings
              </p>
              <ul className="mt-1 grid gap-1 text-[11px] leading-relaxed text-console-text-muted">
                {warnings.map((warning) => (
                  <li key={warning}>• {warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Cloud sync failed. Try again.";
}
