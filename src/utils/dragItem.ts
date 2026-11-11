import type { DragEvent } from "react";
import type { DisplayItem } from "../types";

/** Custom drag MIME so media, songs, verses, and slides share one queue target. */
export const DISPLAY_ITEM_DRAG_TYPE = "application/x-wordlyte-item";

export function setDisplayItemDragData<T extends HTMLElement>(event: DragEvent<T>, item: DisplayItem): void {
  event.dataTransfer.setData(DISPLAY_ITEM_DRAG_TYPE, JSON.stringify(item));
  event.dataTransfer.setData("text/plain", item.type);
  event.dataTransfer.effectAllowed = "copy";
}

export function hasDisplayItemDrag<T extends HTMLElement>(event: DragEvent<T>): boolean {
  return Array.from(event.dataTransfer.types).includes(DISPLAY_ITEM_DRAG_TYPE);
}

export function readDisplayItemDrop<T extends HTMLElement>(event: DragEvent<T>): DisplayItem | null {
  const raw = event.dataTransfer.getData(DISPLAY_ITEM_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DisplayItem;
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string" && parsed.data) {
      return parsed;
    }
  } catch {
    // Ignore malformed or foreign drag payloads.
  }
  return null;
}
