import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath } from "./index";
import type { MediaItem } from "../types";

/**
 * Centralized media path resolution. Media paths are persisted relativized;
 * every preview, thumbnail, and output view resolves them consistently
 * against the app data directory before `convertFileSrc`.
 */
export function resolveMediaPath(path: string | undefined, appDataDir: string | null): string {
  return resolvePath(path, appDataDir);
}

/** Resolves a stored media path to a loadable Tauri asset URL. */
export function resolveMediaSrc(path: string | undefined, appDataDir: string | null): string {
  const resolved = resolveMediaPath(path, appDataDir);
  return resolved ? convertFileSrc(resolved) : "";
}

/** Resolves the display media of a media item (thumbnail fallback to file). */
export function mediaItemSrc(item: MediaItem, appDataDir: string | null): string {
  return resolveMediaSrc(item.thumbnail_path || item.path, appDataDir);
}