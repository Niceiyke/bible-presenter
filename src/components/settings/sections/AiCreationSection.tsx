import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

interface AiPresentationStatus {
  available: boolean;
  addonActive: boolean;
  monthlyUnitsRemaining: number;
  topupUnitsRemaining: number;
  availableUnitsRemaining: number;
  standardLlmRequestUnits: number;
  message: string;
}

const EMPTY_STATUS: AiPresentationStatus = {
  available: false,
  addonActive: false,
  monthlyUnitsRemaining: 0,
  topupUnitsRemaining: 0,
  availableUnitsRemaining: 0,
  standardLlmRequestUnits: 10,
  message: "Checking Wordlyte AI…",
};

export function AiCreationSection() {
  const [status, setStatus] = useState<AiPresentationStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setStatus(await invoke<AiPresentationStatus>("ai_presentation_status"));
    } catch (error) {
      setStatus({
        ...EMPTY_STATUS,
        message: `Could not check AI availability: ${error}`,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const drafts = Math.floor(status.availableUnitsRemaining / Math.max(1, status.standardLlmRequestUnits));

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <p className="text-xs text-console-text-muted font-bold uppercase mb-1 flex items-center gap-1.5"><Sparkles size={13} /> AI Presentation Creation</p>
        <p className="text-[10px] text-console-text-subtle">Generate editable Studio drafts from a topic or pasted notes. AI creation never stages slides or changes the live program feed.</p>
      </div>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><ShieldCheck size={12} /> Wordlyte AI</p>
          <span className={`text-[10px] font-bold ${status.available ? "text-state-success" : "text-state-warning"}`}>
            {status.available ? "Ready" : status.addonActive ? "Needs Units" : "Add-on required"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-console-border bg-console-surface p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-console-text-subtle">Available Units</p>
            <p className="mt-1 text-lg font-black text-console-text">{status.availableUnitsRemaining.toLocaleString()}</p>
          </div>
          <div className="rounded-md border border-console-border bg-console-surface p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-console-text-subtle">Drafts available</p>
            <p className="mt-1 text-lg font-black text-console-text">{drafts.toLocaleString()}</p>
          </div>
        </div>

        <p className="text-[10px] text-console-text-subtle">
          {status.available
            ? `Each standard AI draft uses ${status.standardLlmRequestUnits} Units. ${status.monthlyUnitsRemaining.toLocaleString()} monthly and ${status.topupUnitsRemaining.toLocaleString()} top-up Units remain.`
            : status.message}
        </p>
        <p className="text-[10px] text-console-text-subtle">
          No external API keys are needed. AI creation cannot change the live output.
        </p>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-console-border px-2.5 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/30 p-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">AI Add-on and Units</p>
        <p className="mt-1 text-[10px] leading-relaxed text-console-text-subtle">
          AI is a separate organization add-on and can be used on Free, Pro, or Premium. Manage the add-on, Units, and billing in the Wordlyte Dashboard under your church organization. Live presentation remains available if AI is unavailable.
        </p>
      </section>
    </div>
  );
}
