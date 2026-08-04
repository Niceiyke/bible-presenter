import type { DisplayItem } from "./display";
import type { LowerThirdTemplate } from "./lowerThird";
import type { BackgroundSetting } from "./settings";

export type LayerSource = { type: "live-output" } | { type: "lower-third" };

export type LayerContent =
  | { kind: "empty" }
  | { kind: "item"; item: DisplayItem }
  | { kind: "lower-third"; ltData: any; template: LowerThirdTemplate }
  | { kind: "source"; source: LayerSource }
  | { kind: "static-color"; color: string }
  | { kind: "static-image"; path: string };

export interface SceneLayer {
  id: string; name: string;
  content: LayerContent;
  x: number; y: number; w: number; h: number;
  opacity: number; visible: boolean;
}

export interface SceneData {
  id: string; name: string;
  layers: SceneLayer[];
  background?: BackgroundSetting;
}
