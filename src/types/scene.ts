import type { PresentationSettings, PropItem, LowerThirdData, LowerThirdTemplate, DisplayItem } from "./";

/**
 * A single composited "zone" inside a scene layout. Zones are positioned and
 * sized in normalized 0..1 coordinates over the reference output canvas
 * (1920×1080 by default) and stacked by `z`. Each zone renders one
 * `DisplayItem` (camera, media, bible verse, custom slide, song, timer)
 * through the same renderers the single-item output path uses.
 */
export interface SceneZone {
  id: string;
  /** Content rendered inside this zone. */
  item: DisplayItem;
  /** Normalized rect (0..1) on the reference canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Object-fit for media/camera zones. */
  fit: "cover" | "contain" | "fill";
  /** 0..1 zone opacity. */
  opacity: number;
  /** Stacking order — higher renders on top. */
  z: number;
  /** Mute the zone's audio (media with audio). */
  muted?: boolean;
  /** Optional operator-facing label shown in the builder. */
  label?: string;
}

/** A scene's multi-zone split-screen composition. */
export interface SceneLayout {
  zones: SceneZone[];
}

/**
 * On-wire payload for a live `SceneComposition` display item. Carried by the
 * normal DisplayItem stage/commit pipeline so a composition is staged,
 * previewed, and cleared exactly like any other content.
 */
export interface SceneCompositionData {
  scene_id: string;
  name: string;
  zones: SceneZone[];
}

export interface Scene {
  id: string;
  name: string;
  settings: PresentationSettings;
  props: PropItem[];
  lower_third_data?: LowerThirdData;
  lower_third_template?: LowerThirdTemplate;
  camera?: DisplayItem | null;
  /** Optional multi-zone split-screen composition. */
  layout?: SceneLayout;
  created_at: number;
}
