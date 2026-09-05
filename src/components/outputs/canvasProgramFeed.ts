import type {
  DisplayItem,
  PresentationSettings,
  BackgroundSetting,
} from "../../types";

/**
 * Camera-resolution helpers for the program feed.
 *
 * This file originally held the Phase 2 canvas 2D compositor (`drawProgramFrame`
 * and friends) that rasterized the program for the recorder/streamer. That path
 * was superseded by native Windows Graphics Capture of the off-screen `capture`
 * window (which renders the DOM `OutputWindow` surface), and the DOM
 * `ProgramSurface`/`ProgramSurfacePreview` is the single authoritative renderer.
 * The canvas compositor, its `useCanvasCapture` loop, and the legacy streaming
 * hooks were all removed as dead code. What remains here is the camera-feed
 * resolution the DOM path still depends on.
 */

/** Resolve the effective background for a live item, honoring the per-item
 *  overrides (bible/song/media) the DOM renderers use. */
export function getEffectiveBg(
  settings: PresentationSettings,
  item: DisplayItem | null
): BackgroundSetting {
  if (item?.type === "Verse" && settings.bible_background?.type !== "None" && settings.bible_background) {
    return settings.bible_background;
  }
  if (item?.type === "Media" && settings.media_background?.type !== "None" && settings.media_background) {
    return settings.media_background;
  }
  if (item?.type === "Song") {
    if (item.data.background?.type !== "None" && item.data.background) return item.data.background;
    if (settings.song_background?.type !== "None" && settings.song_background) return settings.song_background;
  }
  return settings.background;
}

/** Collect every camera device id the current program references — the
 *  effective background (which may be a camera), a live Camera item, or
 *  cameras pinned inside scene-composition zones. Consumers use this to
 *  pre-open the needed streams before rendering. */
export function collectCameraDeviceIds(
  item: DisplayItem | null,
  settings: PresentationSettings
): string[] {
  const ids = new Set<string>();
  const bg = getEffectiveBg(settings, item);
  if (bg.type === "Camera" && bg.value.deviceId) ids.add(bg.value.deviceId);
  if (item?.type === "Camera" && item.data.deviceId) ids.add(item.data.deviceId);
  if (item?.type === "SceneComposition") {
    for (const zone of item.data.zones) {
      if (zone.item.type === "Camera" && zone.item.data.deviceId) ids.add(zone.item.data.deviceId);
    }
  }
  return [...ids];
}
