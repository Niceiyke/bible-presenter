import React from "react";
import type { PresentationSettings } from "../types";
import { BibleAssetsSection } from "./settings/BibleAssetsSection";
import { DisplaySection } from "./settings/DisplaySection";

interface SettingsTabProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUploadMedia: () => Promise<void>;
}

export function SettingsTab({
  onUpdateSettings,
  onUploadMedia,
}: SettingsTabProps) {
  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-sm font-display font-black uppercase tracking-[0.18em] text-slate-300">Settings</h1>
        <span className="h-px flex-1 bg-gradient-to-r from-indigo-400/40 to-transparent" />
        <span className="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Output &amp; Scripture</span>
      </div>
      <BibleAssetsSection />
      <DisplaySection onUpdateSettings={onUpdateSettings} onUploadMedia={onUploadMedia} />
    </div>
  );
}