import type { PresentationSettings, PropItem, LowerThirdData, LowerThirdTemplate, DisplayItem } from "./";

export interface Scene {
  id: string;
  name: string;
  settings: PresentationSettings;
  props: PropItem[];
  lower_third_data?: LowerThirdData;
  lower_third_template?: LowerThirdTemplate;
  camera?: DisplayItem | null;
  created_at: number;
}
