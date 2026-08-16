import type { PresentationSettings, PropItem, LowerThirdData, LowerThirdTemplate, DisplayItem } from "./";

/**
 * A zone's content source (Phase 5 — zones as bus primitives).
 *
 * A zone can hold a frozen snapshot (`{ type: "item" }`, the default and the
 * only mode before Phase 5) or be *pinned* to a live content class. When
 * pinned, sending that class of content live while the scene composition is on
 * air updates the zone in place instead of replacing the whole scene — e.g. a
 * `verse` zone in a camera+verse scene advances as the operator steps through
 * the Bible, and a `timer` zone follows the live countdown.
 */
export type SceneZoneSource =
  | { type: "item" } // static snapshot (default)
  | { type: "verse" } // follow the on-air verse
  | { type: "camera" } // follow the on-air camera
  | { type: "timer" } // follow the live timer
  | { type: "song" } // follow the on-air song
  | { type: "media" } // follow the on-air media
  | { type: "slide" }; // follow the on-air custom slide

/**
 * A single composited "zone" inside a scene layout. Zones are positioned and
 * sized in normalized 0..1 coordinates over the reference output canvas
 * (1920×1080 by default) and stacked by `z`. Each zone renders one
 * `DisplayItem` (camera, media, bible verse, custom slide, song, timer)
 * through the same renderers the single-item output path uses.
 */
export interface SceneZone {
  id: string;
  /** Content rendered inside this zone. When `source` is pinned to a live
   *  class, this item is the zone's *current* content (refreshed on take). */
  item: DisplayItem;
  /** Optional live source the zone follows (default: static `item`). */
  source?: SceneZoneSource;
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
