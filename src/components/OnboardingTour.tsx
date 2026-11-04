import React, { useState } from "react";
import { Archive, ArrowRight, Check, MonitorUp, Radio, Sparkles, X } from "lucide-react";
import { Button } from "./ui";

const STORAGE_KEY = "wordlyte_onboarding_v1";

const steps = [
  {
    icon: Sparkles,
    title: "Welcome to Wordlyte",
    body: "Prepare Scripture, songs, media, and presentations before the service, then operate everything from one staged-to-live console.",
  },
  {
    icon: MonitorUp,
    title: "Connect and test displays",
    body: "Open Settings → Monitors, choose the projector and confidence display, then run the test pattern before people arrive.",
  },
  {
    icon: Radio,
    title: "Stage first, then go live",
    body: "Click content once to stage it in cyan. Check the preview, then press Go Live. Red controls affect what the congregation currently sees.",
  },
  {
    icon: Archive,
    title: "Protect your preparation",
    body: "Use Settings → Data & Backup after major service preparation. Keep a copy outside the presentation computer.",
  },
];

export function shouldShowOnboarding(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "done"; } catch { return false; }
}

export function OnboardingTour() {
  const [open, setOpen] = useState(shouldShowOnboarding);
  const [step, setStep] = useState(0);
  if (!open) return null;
  const current = steps[step];
  const Icon = current.icon;
  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, "done"); } catch { /* in-memory session only */ }
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-6" role="dialog" aria-modal="true" aria-label="Welcome to Wordlyte">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-console-border-strong bg-console-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-console-border px-5 py-3">
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-action-primary">Getting started · {step + 1}/{steps.length}</span>
          <button onClick={finish} className="rounded p-1 text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text" aria-label="Skip onboarding"><X size={15} /></button>
        </div>
        <div className="p-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-action-primary/15 text-action-primary"><Icon size={26} /></div>
          <h2 className="text-xl font-black text-console-text">{current.title}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-console-text-muted">{current.body}</p>
          <div className="mt-6 flex justify-center gap-1.5" aria-label="Onboarding progress">
            {steps.map((_, index) => <span key={index} className={`h-1.5 rounded-full ${index === step ? "w-7 bg-action-primary" : "w-2 bg-console-border-strong"}`} />)}
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-console-border px-5 py-3">
          <Button variant="bare" size="md" disabled={step === 0} onClick={() => setStep((v) => Math.max(0, v - 1))}>Back</Button>
          {step < steps.length - 1 ? (
            <Button variant="primary" size="md" onClick={() => setStep((v) => v + 1)}>Next <ArrowRight size={13} /></Button>
          ) : (
            <Button variant="primary" size="md" onClick={finish}><Check size={13} /> Start Preparing</Button>
          )}
        </div>
      </div>
    </div>
  );
}
