import React from "react";
import type { DisplayItem, Song, CustomSlide, Verse, PresentationSettings } from "../types";
import { buildCustomSlideItem } from "../utils";

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
  if (song.arrangement && song.arrangement.length > 0) {
    const out: { label: string; lines: string[] }[] = [];
    for (const lbl of song.arrangement) {
      const sec = song.sections.find((s) => s.label === lbl);
      if (sec) out.push(sec);
    }
    return out;
  }
  return song.sections;
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
    if (i.data.elements && i.data.elements.length > 0) {
      return i.data.elements.filter((e) => e.kind === "text").map((e) => e.content).join("\n");
    }
    return i.data.body?.text || "";
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
    <p className="text-pink-400 text-[10px] font-bold uppercase truncate">SONG: {item.data.title} ({item.data.section_label})</p>
  ),
  nextLive: (i, lookup) => {
    const song = lookup.songs.find((s) => s.id === i.data.song_id);
    if (!song) return null;
    const flat = songFlatSections(song);
    const idx = i.data.slide_index + 1;
    if (idx < flat.length) {
      return { type: "Song", data: { ...i.data, section_label: flat[idx].label, lines: flat[idx].lines, slide_index: idx } };
    }
    return null;
  },
  nav: (i, lookup) => {
    const song = lookup.songs.find((s) => s.id === i.data.song_id);
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
  label: (i) => `Camera Feed: ${i.data.deviceId.slice(0, 8)}...`,
  describe: () => "Live Camera",
  accent: "slate",
  stageDetail: () => "Live Camera Feed",
  ScheduleTile: ({ item }) => (
    <p className="text-slate-400 text-[10px] font-bold uppercase truncate">CAMERA: {item.data.deviceId.slice(0, 12)}</p>
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

// ─── Registry ──────────────────────────────────────────────────────────────

export const ITEM_KINDS: { Verse: typeof verseKind; CustomSlide: typeof customSlideKind; Song: typeof songKind; Media: typeof mediaKind; Camera: typeof cameraKind; Timer: typeof timerKind } = {
  Verse: verseKind,
  CustomSlide: customSlideKind,
  Song: songKind,
  Media: mediaKind,
  Camera: cameraKind,
  Timer: timerKind,
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
