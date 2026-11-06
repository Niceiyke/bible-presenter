import type { CustomPresentation, CustomSlide, SlideTheme, Verse } from "../types";
import { newTextElement, stableId } from "../utils";
import { AI_PRESENTATION_THEME, aiTextToDoc } from "../ai/presentations";

export interface PrayerGuideImport {
  sourceName: string;
  days: PrayerDay[];
  warnings: string[];
}

export interface PrayerDay {
  title: string;
  prayers: PrayerPoint[];
}

export interface PrayerPoint {
  number: number;
  text: string;
  reference: string;
  verses: Verse[];
}

function themeForDay(): SlideTheme {
  return {
    ...AI_PRESENTATION_THEME,
    id: stableId(),
    name: "Prayer Guide",
    background: { ...AI_PRESENTATION_THEME.background },
  };
}

function canonicalReference(prayer: PrayerPoint): string {
  const first = prayer.verses[0];
  const last = prayer.verses[prayer.verses.length - 1];
  if (!first) return `Reference requires review: ${prayer.reference || "Missing reference"}`;
  if (last && last.book === first.book && last.chapter === first.chapter && last.verse !== first.verse) {
    return `${first.book} ${first.chapter}:${first.verse}-${last.verse}`;
  }
  return `${first.book} ${first.chapter}:${first.verse}`;
}

function titleSlide(day: PrayerDay, sourceName: string, theme: SlideTheme): CustomSlide {
  return {
    id: stableId(),
    background: { ...theme.background },
    notes: `Imported from ${sourceName}`,
    elements: [
      newTextElement({
        x: 8, y: 26, w: 84, h: 28, z_index: 1,
        role: "title",
        content: aiTextToDoc(day.title, [], theme.accentColor),
        font_size: 64, font_family: "inherit", color: "inherit", bold: true,
        align: "center", v_align: "middle", autoSize: "shrink",
      }),
      newTextElement({
        x: 14, y: 58, w: 72, h: 14, z_index: 2,
        role: "footer",
        content: aiTextToDoc("Covenant Hour of Prayer", [{ text: "Prayer", style: "accent-bold" }], theme.accentColor),
        font_size: 34, font_family: "inherit", color: "inherit",
        align: "center", v_align: "middle", autoSize: "shrink",
      }),
    ],
  };
}

function prayerSlide(prayer: PrayerPoint, theme: SlideTheme): CustomSlide {
  const emphasis = /^Father\b/i.test(prayer.text)
    ? [{ text: prayer.text.match(/^Father\b/i)?.[0] ?? "Father", style: "accent-bold" as const }]
    : [];
  return {
    id: stableId(),
    background: { ...theme.background },
    notes: prayer.text,
    elements: [
      newTextElement({
        x: 9, y: 14, w: 82, h: 72, z_index: 1,
        role: "body",
        content: aiTextToDoc(prayer.text, emphasis, theme.accentColor),
        font_size: 40, font_family: "inherit", color: "inherit",
        align: "center", v_align: "middle", autoSize: "shrink",
      }),
    ],
  };
}

function scriptureSlide(prayer: PrayerPoint, theme: SlideTheme): CustomSlide {
  const verseText = prayer.verses.map((verse) => verse.text).join(" ");
  const reference = canonicalReference(prayer);
  return {
    id: stableId(),
    background: { ...theme.background },
    notes: reference,
    elements: [
      newTextElement({
        x: 10, y: 12, w: 80, h: 12, z_index: 1,
        role: "footer",
        content: aiTextToDoc(reference, [], theme.accentColor),
        font_size: 30, font_family: "inherit", color: theme.accentColor, bold: true,
        align: "center", v_align: "middle", autoSize: "shrink",
      }),
      newTextElement({
        x: 10, y: 28, w: 80, h: 62, z_index: 2,
        content: aiTextToDoc(verseText || "Verify this Scripture reference before projection.", [], theme.accentColor),
        font_size: 34, font_family: "Georgia", color: "inherit", italic: true,
        align: "center", v_align: "middle", autoSize: "shrink",
      }),
    ],
  };
}

export function compilePrayerGuide(imported: PrayerGuideImport): CustomPresentation[] {
  return imported.days.map((day) => {
    const theme = themeForDay();
    return {
      id: stableId(),
      name: `${day.title} — Covenant Hour of Prayer`,
      version: 2,
      theme,
      slides: [
        titleSlide(day, imported.sourceName, theme),
        ...day.prayers.flatMap((prayer) => [
          prayerSlide(prayer, theme),
          scriptureSlide(prayer, theme),
        ]),
      ],
    };
  });
}
