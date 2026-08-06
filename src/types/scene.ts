import type { PresentationSettings, PropItem, LowerThirdData, LowerThirdTemplate } from "./";

export interface Scene {
  id: string;
  name: string;
  settings: PresentationSettings;
  props: PropItem[];
  lower_third_data?: LowerThirdData;
  lower_third_template?: LowerThirdTemplate;
  created_at: number;
}
