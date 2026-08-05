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
    <div className="flex flex-col gap-6">
      <BibleAssetsSection />
      <DisplaySection onUpdateSettings={onUpdateSettings} onUploadMedia={onUploadMedia} />
    </div>
  );
}
