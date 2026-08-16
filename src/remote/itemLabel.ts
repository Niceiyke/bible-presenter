import type { DisplayItem, ScheduleEntry } from "../types/display";

export function itemTitle(item: DisplayItem | null): string {
  if (!item) return "Nothing";
  switch (item.type) {
    case "Verse":
      return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
    case "Song":
      return item.data.title;
    case "Media":
      return item.data.name;
    case "Camera":
      return "Camera";
    case "CustomSlide":
      return item.data.presentation_name ?? "Custom slide";
    case "Timer":
      return item.data.label ?? "Timer";
    case "SceneComposition":
      return item.data.name;
    default:
      return "Item";
  }
}

export function itemSubtitle(item: DisplayItem | null): string {
  if (!item) return "";
  switch (item.type) {
    case "Verse":
      return item.data.text;
    case "Song":
      return `${item.data.section_label}${item.data.total_slides ? ` · ${item.data.slide_index + 1}/${item.data.total_slides}` : ""}`;
    case "CustomSlide":
      return "";
    case "Media":
      return item.data.media_type;
    default:
      return "";
  }
}

export function entryTitle(entry: ScheduleEntry): string {
  return itemTitle(entry.item);
}