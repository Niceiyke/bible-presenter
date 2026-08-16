import React from "react";
import type { DisplayItem, Song, CustomSlide, Verse, PresentationSettings } from "../types";
import { buildCustomSlideItem, displayItemLabel } from "../utils";
import { getSongSequence } from "../utils/song";

/**
 * Item-kind registry.
 *
 * Each variant of `DisplayItem` is described by an `ItemKind` providing the
 * per-type behaviour that was previously scattered across 6 files as switch
 * statements (OutputWindow render, StageWindow summary/detail, ScheduleTab
 * preview tile, useKeyboardShortcuts prev/next/home/end, useItemActions
 * next-item, utils displayItemLabel/getItemUid/describeDisplayItem).
 *
 * Adding a new item type now means: add a variant to `DisplayItem` (types/
 * display.ts + Rust enum) and register one `ItemKind` here. No more editing
 * five switches.
 *
 * `next()` receives a `Lookup` so kinds can resolve sibling slides (studio
 * slides by presentation_id, song sections by song_id) without depending on
 * the global store — the caller passes the lookup in.
 */

export interface ItemLookup {
  studioSlides: Record<string, CustomSlide[]>;
  songs: Song[];
  /** Hymn-library songs — navigation must resolve live hymns even though
   *  they are not part of the operator's saved `songs` collection. */
  hymns: Song[];
  nextVerse: Verse | null;
  verseSplits: Record<string, Verse[]>;
  verseSplitThreshold: number;
}

export interface NavResult {
  prev: DisplayItem | null;
  next: DisplayItem | null;
  first: DisplayItem | null;
  last: DisplayItem | null;
}

export interface ItemKind<T extends DisplayItem = DisplayItem> {
  /** Stable identifier for transitions and highlight equality. */
  uid: (item: T) => string;
  /** Short operator-facing label (e.g. "John 3:16"). */
  label: (item: T) => string;
  /** Longer human description (logs, stage summary). */
  describe: (item: T) => string;
  /** Accent colour token used in schedule/stage UI. */
  accent: string;
  /** Compute prev/next/first/last for keyboard navigation. */
  nav?: (item: T, lookup: ItemLookup) => NavResult;
  /** "Up Next" computation — what follows this item when sent live. */
  nextLive?: (item: T, lookup: ItemLookup) => DisplayItem | null;
  /** Compact schedule-list tile body (JSX). */
  ScheduleTile: React.FC<{ item: T }>;
  /** Stage-monitor detail (text or element). */
  stageDetail: (item: T) => string;
}

const verseKey = (v: Verse, threshold: number) =>
  `${v.book}-${v.chapter}-${v.verse}-${v.version}-${threshold}`;

function songFlatSections(song: Song): { label: string; lines: string[] }[] {
  return getSongSequence(song);
}

/** Find a song by id across both the user collection and the hymn library. */
function lookupSong(lookup: ItemLookup, id: string): Song | undefined {
  return (
    lookup.songs.find((s) => s.id === id) ??
    (lookup.hymns ?? []).find((s) => s.id === id)
  );
}

// ─── Verse ────────────────────────────────────────────────────────────────

const verseKind: ItemKind<Extract<DisplayItem, { type: "Verse" }>> = {
  uid: (i) => `verse-${i.data.book}-${i.data.chapter}-${i.data.verse}-${i.data.version}-${i.data.text.slice(0, 16)}`,
  label: (i) => `${i.data.book} ${i.data.chapter}:${i.data.verse}`,
  describe: (i) => `${i.data.book} ${i.data.chapter}:${i.data.verse}`,
  accent: "amber",
  stageDetail: (i) => i.data.text,
  ScheduleTile: ({ item }) => (
    <>
      <p className="text-amber-500 text-[10px] font-bold uppercase truncate">{item.data.book} {item.data.chapter}:{item.data.verse}</p>
      <p className="text-slate-400 text-[10px] truncate">{item.data.text}</p>
    </>
  ),
  nextLive: (i, lookup) => {
    const d = i.data;
    if (d.split_index !== undefined && d.total_splits !== undefined && d.split_index + 1 < d.total_splits) {
      const splits = lookup.verseSplits[verseKey(d, lookup.verseSplitThreshold)];
      if (splits && splits[d.split_index + 1]) return { type: "Verse", data: splits[d.split_index + 1] };
    }
    if (lookup.nextVerse) return { type: "Verse", data: lookup.nextVerse };
    return null;
  },
  nav: (i, lookup) => {
    const d = i.data;
    const splits = lookup.verseSplits[verseKey(d, lookup.verseSplitThreshold)];
    let prev: DisplayItem | null = null;
    let next: DisplayItem | null = null;
    if (d.split_index !== undefined && d.total_splits !== undefined) {
      if (d.split_index + 1 < d.total_splits && splits && splits[d.split_index + 1]) {
        next = { type: "Verse", data: splits[d.split_index + 1] };
      }
      if (d.split_index > 0 && splits && splits[d.split_index - 1]) {
        prev = { type: "Verse", data: splits[d.split_index - 1] };
      }
    }
    return { prev, next, first: null, last: null };
  },
};

// ─── CustomSlide ───────────────────────────────────────────────────────────

const customSlideKind: ItemKind<Extract<DisplayItem, { type: "CustomSlide" }>> = {
  uid: (i) => `custom-${i.data.presentation_id}-${i.data.slide_index}`,
  label: (i) => `${i.data.presentation_name} – Slide ${i.data.slide_index + 1}`,
  describe: (i) => `${i.data.presentation_name} (S${i.data.slide_index + 1})`,
  accent: "purple",
  stageDetail: (i) => {
    const els = (i.data.elements ?? []).filter((e) => e.kind === "text");
    // P2.2: text content is a ProseMirror JSON doc; fall back to the
    // sanitized HTML render for label purposes. For elements whose
    // content is still a string (mid-migration), it degrades to the
    // stripped plain text on its own.
    return els
      .map((e) => {
        const c = (e as { content: unknown }).content;
        if (typeof c === "string") return c;
        // Lightweight text extraction from the JSON doc — no need to
        // round-trip through generateHTML just to label a tile.
        try {
          const json = c as { content?: unknown };
          const walk = (node: any): string => {
            if (!node) return "";
            if (typeof node === "string") return node;
            if (Array.isArray(node.content)) return node.content.map(walk).join("");
            return (node.text ?? "") as string;
          };
          return walk(json) || "";
        } catch {
          return "";
        }
      })
      .join("\n");
  },
  ScheduleTile: ({ item }) => (
    <p className="text-purple-400 text-[10px] font-bold uppercase truncate">
      STUDIO: {item.data.presentation_name} — Slide {item.data.slide_index + 1}
    </p>
  ),
  nextLive: (i, lookup) => {
    const slides = lookup.studioSlides[i.data.presentation_id];
    const idx = i.data.slide_index + 1;
    if (slides && idx < slides.length) {
      return buildCustomSlideItem(
        { id: i.data.presentation_id, name: i.data.presentation_name, slide_count: slides.length },
        slides, idx
      );
    }
    return null;
  },
  nav: (i, lookup) => {
    const slides = lookup.studioSlides[i.data.presentation_id];
    if (!slides || slides.length === 0) return { prev: null, next: null, first: null, last: null };
    const cur = i.data.slide_index;
    const build = (idx: number) =>
      buildCustomSlideItem(
        { id: i.data.presentation_id, name: i.data.presentation_name, slide_count: slides.length },
        slides, idx
      );
    return {
      prev: cur > 0 ? build(cur - 1) : null,
      next: cur < slides.length - 1 ? build(cur + 1) : null,
      first: build(0),
      last: build(slides.length - 1),
    };
  },
};

// ─── Song ──────────────────────────────────────────────────────────────────

const songKind: ItemKind<Extract<DisplayItem, { type: "Song" }>> = {
  uid: (i) => `song-${i.data.song_id}-${i.data.slide_index}`,
  label: (i) => `Song: ${i.data.title} (${i.data.section_label})`,
  describe: (i) => `${i.data.title} (${i.data.section_label})`,
  accent: "pink",
  stageDetail: (i) => i.data.lines.join("\n"),
  ScheduleTile: ({ item }) => (
    <p className="text-pink-400 text-[10px] font-bold uppercase truncate">
      {item.data.style === "FullSlide" ? "FULL" : "OVR"} · {item.data.title} ({item.data.section_label})
    </p>
  ),
  nextLive: (i, lookup) => {
    const song = lookupSong(lookup, i.data.song_id);
    if (!song) return null;
    const flat = songFlatSections(song);
    const idx = i.data.slide_index + 1;
    if (idx < flat.length) {
      return { type: "Song", data: { ...i.data, section_label: flat[idx].label, lines: flat[idx].lines, slide_index: idx } };
    }
    return null;
  },
  nav: (i, lookup) => {
    const song = lookupSong(lookup, i.data.song_id);
    if (!song) return { prev: null, next: null, first: null, last: null };
    const flat = songFlatSections(song);
    if (flat.length === 0) return { prev: null, next: null, first: null, last: null };
    const cur = i.data.slide_index;
    const build = (idx: number) =>
      ({ type: "Song", data: { ...i.data, section_label: flat[idx].label, lines: flat[idx].lines, slide_index: idx } }) as DisplayItem;
    return {
      prev: cur > 0 ? build(cur - 1) : null,
      next: cur < flat.length - 1 ? build(cur + 1) : null,
      first: build(0),
      last: build(flat.length - 1),
    };
  },
};

// ─── Media ─────────────────────────────────────────────────────────────────

const mediaKind: ItemKind<Extract<DisplayItem, { type: "Media" }>> = {
  uid: (i) => `media-${i.data.id}`,
  label: (i) => i.data.name,
  describe: (i) => i.data.name,
  accent: "blue",
  stageDetail: (i) => `Media: ${i.data.name} (${i.data.media_type})`,
  ScheduleTile: ({ item }) => (
    <p className="text-blue-400 text-[10px] font-bold uppercase truncate">{item.data.media_type}: {item.data.name}</p>
  ),
};

// ─── Camera ────────────────────────────────────────────────────────────────

const cameraKind: ItemKind<Extract<DisplayItem, { type: "Camera" }>> = {
  uid: (i) => `camera-${i.data.deviceId}`,
  label: (i) => (i.data.deviceId.startsWith("phone-camera-") ? "Phone Camera" : `Camera Feed: ${i.data.deviceId.slice(0, 8)}...`),
  describe: () => "Live Camera",
  accent: "slate",
  stageDetail: () => "Live Camera Feed",
  ScheduleTile: ({ item }) => (
    <p className="text-slate-400 text-[10px] font-bold uppercase truncate">CAMERA: {item.data.deviceId.startsWith("phone-camera-") ? "PHONE" : item.data.deviceId.slice(0, 12)}</p>
  ),
};

// ─── Timer ─────────────────────────────────────────────────────────────────

const timerKind: ItemKind<Extract<DisplayItem, { type: "Timer" }>> = {
  uid: (i) => `timer-${i.data.timer_type}-${i.data.started_at ?? "idle"}`,
  label: (i) => `Timer: ${i.data.timer_type}`,
  describe: (i) => `Timer: ${i.data.timer_type}`,
  accent: "cyan",
  stageDetail: () => "",
  ScheduleTile: ({ item }) => (
    <p className="text-cyan-400 text-[10px] font-bold uppercase truncate">
      TIMER: {item.data.timer_type}{item.data.label ? ` · ${item.data.label}` : ""}
    </p>
  ),
};

// ─── SceneComposition ──────────────────────────────────────────────────────

const compositionKind: ItemKind<Extract<DisplayItem, { type: "SceneComposition" }>> = {
  uid: (i) => `scene-${i.data.scene_id}-${i.data.zones.map((z) => z.id).join(",")}`,
  label: (i) => `Scene: ${i.data.name}`,
  describe: (i) => `Scene "${i.data.name}" (${i.data.zones.length} zones)`,
  accent: "emerald",
  stageDetail: (i) =>
    i.data.zones
      .map((z) => {
        const label = displayItemLabel(z.item);
        return z.label ? `${z.label}: ${label}` : label;
      })
      .join("\n"),
  ScheduleTile: ({ item }) => (
    <p className="text-emerald-400 text-[10px] font-bold uppercase truncate">
      SCENE: {item.data.name} · {item.data.zones.length} zone{item.data.zones.length !== 1 ? "s" : ""}
    </p>
  ),
};

// ─── Registry ──────────────────────────────────────────────────────────────

export const ITEM_KINDS: { Verse: typeof verseKind; CustomSlide: typeof customSlideKind; Song: typeof songKind; Media: typeof mediaKind; Camera: typeof cameraKind; Timer: typeof timerKind; SceneComposition: typeof compositionKind } = {
  Verse: verseKind,
  CustomSlide: customSlideKind,
  Song: songKind,
  Media: mediaKind,
  Camera: cameraKind,
  Timer: timerKind,
  SceneComposition: compositionKind,
};

export function kindOf(item: DisplayItem): ItemKind {
  return (ITEM_KINDS as Record<string, ItemKind>)[item.type];
}

export function itemUid(item: DisplayItem | null): string {
  if (!item) return "empty";
  return kindOf(item).uid(item as any);
}

export function itemLabel(item: DisplayItem): string {
  return kindOf(item).label(item as any);
}

export function itemDescribe(item: DisplayItem): string {
  return kindOf(item).describe(item as any);
}

export function itemNextLive(item: DisplayItem, lookup: ItemLookup): DisplayItem | null {
  const k = kindOf(item);
  return k.nextLive ? k.nextLive(item as any, lookup) : null;
}

export function itemNav(item: DisplayItem, lookup: ItemLookup): NavResult {
  const k = kindOf(item);
  return k.nav ? k.nav(item as any, lookup) : { prev: null, next: null, first: null, last: null };
}

export function ScheduleTile({ item }: { item: DisplayItem }) {
  const K = kindOf(item);
  return <K.ScheduleTile item={item as any} />;
}

export function stageDetail(item: DisplayItem): string {
  return kindOf(item).stageDetail(item as any);
}

// ─── Cockpit metadata helpers (Phase 4) ──────────────────────────────────────

export interface ItemMeta {
  /** Operator-facing kind label, e.g. "Bible Verse", "Song", "Slide". */
  kindLabel: string;
  /** Primary reference / title (e.g. "John 3:16" or song title). */
  title: string;
  /** Secondary detail (e.g. "NIV" version or section label). */
  detail: string | null;
  /** Fractional progress (0..1) when the item has an intrinsic span. */
  progress: number | null;
  /** Progress text when available, e.g. "Slide 3/10". */
  progressLabel: string | null;
  /** Runtime hint, e.g. media duration. */
  durationLabel: string | null;
}

const TYPE_LABELS: Record<DisplayItem["type"], string> = {
  Verse: "Bible Verse",
  Media: "Media",
  Camera: "Camera",
  CustomSlide: "Slide",
  Timer: "Timer",
  Song: "Song",
  SceneComposition: "Scene",
};

export function itemMeta(item: DisplayItem): ItemMeta {
  return itemMetaAt(item, Date.now());
}

export function itemMetaAt(item: DisplayItem, now: number): ItemMeta {
  const base: ItemMeta = {
    kindLabel: TYPE_LABELS[item.type] ?? "Content",
    title: displayItemLabel(item),
    detail: null,
    progress: null,
    progressLabel: null,
    durationLabel: null,
  };

  switch (item.type) {
    case "Verse": {
      const { book, chapter, verse, version, split_index, total_splits } = item.data;
      base.title = `${book} ${chapter}:${verse}`;
      base.detail = version;
      if (total_splits && total_splits > 1) {
        const idx = (split_index ?? 0) + 1;
        base.progress = idx / total_splits;
        base.progressLabel = `Verse ${idx}/${total_splits}`;
      }
      return base;
    }
    case "CustomSlide": {
      const { presentation_name, slide_index, slide_count } = item.data;
      base.title = presentation_name;
      base.detail = null;
      if (slide_count > 0) {
        const idx = slide_index + 1;
        base.progress = idx / slide_count;
        base.progressLabel = `Slide ${idx}/${slide_count}`;
      }
      return base;
    }
    case "Song": {
      const { title, section_label, slide_index, total_slides } = item.data;
      base.title = title;
      base.detail = section_label;
      if (total_slides > 0) {
        const idx = slide_index + 1;
        base.progress = idx / total_slides;
        base.progressLabel = `Section ${idx}/${total_slides}`;
      }
      return base;
    }
    case "Media": {
      base.title = item.data.name;
      base.detail = item.data.media_type;
      if (item.data.duration) {
        const m = Math.floor(item.data.duration / 60);
        const s = Math.floor(item.data.duration % 60);
        base.durationLabel = `${m}:${s.toString().padStart(2, "0")}`;
      }
      return base;
    }
    case "Timer": {
      base.title = item.data.label || (item.data.timer_type === "clock" ? "Clock" : `Timer: ${item.data.timer_type}`);
      base.detail = item.data.timer_type;
      if (item.data.timer_type === "countdown" && item.data.duration_secs && item.data.started_at) {
        const remaining = Math.max(0, item.data.started_at + item.data.duration_secs * 1000 - now);
        const frac = remaining === 0 ? 0 : Math.max(0, Math.min(1, (item.data.duration_secs * 1000 - remaining) / (item.data.duration_secs * 1000)));
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        base.progress = frac;
        base.progressLabel = `${mins}:${secs.toString().padStart(2, "0")} left`;
        base.durationLabel = `${mins}:${secs.toString().padStart(2, "0")}`;
      } else if (item.data.timer_type === "countdown" && item.data.duration_secs) {
        const m = Math.floor(item.data.duration_secs / 60);
        const s = Math.floor(item.data.duration_secs % 60);
        base.durationLabel = `${m}:${s.toString().padStart(2, "0")}`;
      }
      return base;
    }
    case "Camera":
      base.title = "Live Camera";
      base.detail = item.data.deviceId.startsWith("native:") || item.data.deviceId.startsWith("ndi:")
        ? item.data.deviceId.split(":")[1] ?? item.data.deviceId.slice(0, 12)
        : null;
      return base;
    case "SceneComposition":
      base.title = item.data.name;
      base.detail = `${item.data.zones.length} zone${item.data.zones.length !== 1 ? "s" : ""}`;
      return base;
    default:
      return base;
  }
}
