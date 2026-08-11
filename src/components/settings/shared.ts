import type { PresentationSettings } from "../../types";

export interface SettingsSectionProps {
  onUpdateSettings: (s: PresentationSettings) => Promise<void> | void;
  onUploadMedia: () => Promise<void>;
}

export interface SettingsCategory {
  id: string;
  labelKey: string;
  keywords: string[];
}
