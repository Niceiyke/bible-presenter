import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, BookOpen, CalendarDays, Radio, CircleDot, ArrowRight } from "lucide-react";
import { useAppStore } from "../store";
import { stableId } from "../utils";

const FIRST_RUN_KEY = "pref_firstRunDismissed";

/**
 * `FirstRunWizard` — Phase 8 "simple service setup wizard for first use".
 *
 * A lightweight, non-blocking onboarding modal shown on a fresh install. It
 * walks a new operator through the primary workflow (build content → create a
 * service plan → go live → record) and offers a single action that creates a
 * service and drops them into the Service Plan, so a first-time operator can
 * stage an item and take it live without reading documentation.
 */
export function FirstRunWizard({ onClose }: { onClose: () => void }) {
  const setServices = useAppStore((s) => s.setServices);
  const setActiveServiceId = useAppStore((s) => s.setActiveServiceId);
  const setScheduleEntries = useAppStore((s) => s.setScheduleEntries);
  const setOperatorMode = useAppStore((s) => s.setOperatorMode);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setToast = useAppStore((s) => s.setToast);
  const [creating, setCreating] = useState(false);

  const dismiss = () => {
    localStorage.setItem(FIRST_RUN_KEY, "1");
    onClose();
  };

  const createService = async () => {
    setCreating(true);
    try {
      const id = stableId();
      await invoke("save_service", { schedule: { id, name: "My First Service", items: [] } });
      const list = (await invoke("list_services")) as { id: string; name: string }[];
      setServices(list as never);
      setActiveServiceId(id);
      setScheduleEntries([]);
      localStorage.setItem("activeServiceId", id);
      setToast("Service created — add Scripture, songs, and media to your plan.");
    } catch (e: any) {
      setToast(`Could not create the service: ${e?.message ?? e}`);
    }
    setCreating(false);
    setOperatorMode("service");
    setActiveTab("schedule");
    dismiss();
  };

  const steps = [
    { icon: BookOpen, title: "Build your service", text: "Add Scripture, songs, media, and presentations in Prepare mode." },
    { icon: CalendarDays, title: "Create a service plan", text: "Create a service and order its items in the Service Plan." },
    { icon: Radio, title: "Stage & go live", text: "Tap Go Live to take staged content to the audience output." },
    { icon: CircleDot, title: "Record or stream", text: "Capture the program from System → Recordings / Streaming." },
  ];

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="Get started with Wordlyte">
      <div className="w-full max-w-md rounded-xl border border-console-border bg-console-surface shadow-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-console-border flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-black text-console-text">Welcome to Wordlyte</h2>
            <p className="text-[11px] text-console-text-muted mt-0.5">Everything you need to run your service, in four steps.</p>
          </div>
          <button onClick={dismiss} aria-label="Dismiss"
            className="shrink-0 p-1.5 rounded text-console-text-subtle hover:text-console-text hover:bg-console-surface-raised transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          {steps.map((s, i) => (
            <div key={s.title} className="flex items-start gap-3">
              <div className="shrink-0 w-7 h-7 rounded-md bg-console-surface-raised border border-console-border flex items-center justify-center">
                <s.icon size={14} className="text-action-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-black text-console-text">
                  {i + 1}. {s.title}
                </p>
                <p className="text-[10px] text-console-text-muted leading-snug">{s.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-console-border flex items-center justify-between gap-2 bg-console-surface-strong/40">
          <button onClick={dismiss} className="text-[11px] font-bold text-console-text-subtle hover:text-console-text transition-colors px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">
            Not now
          </button>
          <button onClick={createService} disabled={creating}
            className="px-3.5 py-2 rounded-md bg-action-primary text-black text-[11px] font-black uppercase tracking-wider hover:opacity-90 transition-all flex items-center gap-1.5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">
            {creating ? "Creating…" : "Create service & start"} <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

export { FIRST_RUN_KEY };
