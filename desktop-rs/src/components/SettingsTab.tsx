import React from "react";
import type { PresentationSettings } from "../types";
import { AudioSection } from "./settings/AudioSection";
import { BibleAssetsSection } from "./settings/BibleAssetsSection";
import { DisplaySection } from "./settings/DisplaySection";
import { TranscriptionSection } from "./settings/TranscriptionSection";

interface SettingsTabProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUploadMedia: () => Promise<void>;
}

export function SettingsTab({
  onUpdateSettings,
  onUploadMedia,
}: SettingsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <AudioSection onUpdateSettings={onUpdateSettings} />
      <BibleAssetsSection />
      <DisplaySection onUpdateSettings={onUpdateSettings} onUploadMedia={onUploadMedia} />
      <TranscriptionSection />
    </div>
  );
}
