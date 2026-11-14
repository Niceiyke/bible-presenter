import { invoke } from "@tauri-apps/api/core";
import type {
  CustomSlide,
  DisplayItem,
  ScheduleEntry,
  SlideElement,
  Verse,
} from "../types";
import { buildCustomSlideItem } from "../utils";

export type CloudSyncOrganization = { id: string; name: string };
export type CloudSyncDevice = { machineId: string };

export type CloudSyncItem = {
  id: string;
  type: "scripture" | "song" | "media" | "presentation" | "note" | "custom";
  title: string;
  reference?: string | null;
  sourceId?: string | null;
  position: number;
  durationMinutes?: number | null;
  notes?: string | null;
  payload?: Record<string, unknown>;
};

export type CloudServicePlan = {
  id: string;
  organizationId: string;
  title: string;
  serviceAt: number;
  status: "draft" | "published" | "archived";
  revision: number;
  items: CloudSyncItem[];
  createdAt: number;
  updatedAt: number;
};

export type CloudPresentation = {
  id: string;
  organizationId: string;
  name: string;
  slideCount: number;
  slides: Array<{
    id: string;
    background: {
      type: "color" | "image" | "video" | "gradient";
      value?: string;
      from?: string;
      to?: string;
      angle?: number;
      opacity?: number;
    };
    elements: SlideElement[];
    notes?: string;
    section?: string;
  }>;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type CloudSyncResult = {
  organization: CloudSyncOrganization;
  device: CloudSyncDevice;
  expiresAt: number;
  servicePlans: CloudServicePlan[];
  planCursor: number;
  presentations: Array<{
    id: string;
    organizationId: string;
    name: string;
    slideCount: number;
    revision: number;
    createdAt: number;
    updatedAt: number;
  }>;
  presentationCursor: number;
  presentationDetails: Record<string, CloudPresentation>;
};

export type CloudImportResult = {
  entries: ScheduleEntry[];
  warnings: string[];
};

export type CloudImportOptions = {
  defaultBibleVersion?: string;
  resolveScripture?: (reference: string, version: string) => Promise<Verse[]>;
};

export function platformApiUrl(): string {
  const configured = import.meta.env.VITE_PLATFORM_API_URL?.trim();
  if (configured) return configured;
  if (import.meta.env.DEV) return "http://localhost:8787";
  throw new Error(
    "Dashboard sync is not configured in this build. Set VITE_PLATFORM_API_URL when packaging Wordlyte.",
  );
}

export async function pullCloudSync(apiUrl = platformApiUrl()): Promise<CloudSyncResult> {
  return invoke<CloudSyncResult>("platform_sync_pull", { apiUrl });
}

export async function buildCloudPlanEntries(
  plan: CloudServicePlan,
  sync: CloudSyncResult,
  options: CloudImportOptions = {},
): Promise<CloudImportResult> {
  const warnings: string[] = [];
  const entries: ScheduleEntry[] = [];
  const version = options.defaultBibleVersion ?? "KJV";
  const resolveScripture = options.resolveScripture ?? defaultResolveScripture;

  const items = [...plan.items].sort((left, right) => left.position - right.position);
  for (const item of items) {
    if (item.type === "presentation") {
      const sourceId = item.sourceId;
      const detail = sourceId ? sync.presentationDetails[sourceId] : undefined;
      const slideIndex = Number(item.payload?.slideIndex ?? 0);
      const slide = detail?.slides[slideIndex];
      if (!detail || !slide) {
        warnings.push(`${item.title}: the referenced cloud presentation is unavailable.`);
        continue;
      }
      entries.push({
        id: item.id,
        item: buildCustomSlideItem(
          { id: detail.id, name: detail.name, slide_count: detail.slides.length },
          [detail.slides[slideIndex] as CustomSlide],
          0,
        ),
      });
      continue;
    }

    if (item.type === "scripture") {
      const reference = item.reference?.trim();
      if (!reference) {
        warnings.push(`${item.title}: no Scripture reference was provided.`);
        continue;
      }
      const itemVersion =
        typeof item.payload?.version === "string" ? item.payload.version : version;
      try {
        const verses = await resolveScripture(reference, itemVersion);
        if (verses.length === 0) {
          warnings.push(`${item.title}: ${reference} was not found in ${itemVersion}.`);
          continue;
        }
        for (const verse of verses) {
          entries.push({
            id: verses.length > 1 ? `${item.id}:${verse.verse}` : item.id,
            item: { type: "Verse", data: verse },
          });
        }
      } catch (error) {
        warnings.push(
          `${item.title}: ${error instanceof Error ? error.message : "Scripture could not be resolved."}`,
        );
      }
      continue;
    }

    if (item.type === "note" || item.type === "custom") {
      const body = item.notes ?? (typeof item.payload?.text === "string" ? item.payload.text : "");
      entries.push({
        id: item.id,
        item: buildTextSlide(item.title, body),
      });
      continue;
    }

    warnings.push(`${item.title}: ${item.type} items are not available in the first cloud sync.`);
  }

  return { entries, warnings };
}

async function defaultResolveScripture(reference: string, version: string): Promise<Verse[]> {
  const parsed = parseReference(reference);
  if (!parsed) throw new Error(`Unsupported Scripture reference "${reference}".`);

  if (parsed.endVerse === undefined) {
    const verse = await invoke<Verse | null>("get_verse", {
      book: parsed.book,
      chapter: parsed.chapter,
      verse: parsed.startVerse,
      version,
    });
    return verse ? [verse] : [];
  }

  const chapter = await invoke<Verse[]>("get_chapter", {
    book: parsed.book,
    chapter: parsed.chapter,
    version,
  });
  return chapter.filter(
    (verse) => verse.verse >= parsed.startVerse && verse.verse <= parsed.endVerse!,
  );
}

function parseReference(reference: string): {
  book: string;
  chapter: number;
  startVerse: number;
  endVerse?: number;
} | null {
  const match = reference
    .trim()
    .match(/^(.+?)\s+(\d+):(\d+)(?:\s*[-\u2013]\s*(\d+))?$/u);
  if (!match) return null;
  const [, book, chapter, startVerse, endVerse] = match;
  if (!book || !chapter || !startVerse) return null;
  return {
    book: book.trim(),
    chapter: Number(chapter),
    startVerse: Number(startVerse),
    ...(endVerse ? { endVerse: Number(endVerse) } : {}),
  };
}

function buildTextSlide(title: string, body: string): DisplayItem {
  const slide: CustomSlide = {
    id: crypto.randomUUID(),
    background: { type: "color", value: "#0b1117" },
    elements: [
      textElement(1, 8, 22, 84, 18, title, 48, true),
      textElement(2, 14, 44, 72, 30, body, 26, false),
    ],
  };
  return buildCustomSlideItem(
    { id: `cloud-${slide.id}`, name: title, slide_count: 1 },
    [slide],
    0,
  );
}

function textElement(
  zIndex: number,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  fontSize: number,
  bold: boolean,
): SlideElement {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    x,
    y,
    w,
    h,
    z_index: zIndex,
    content: textDoc(text),
    font_size: fontSize,
    font_family: "Inter",
    color: "#f5f5f7",
    align: "center",
    v_align: "middle",
    bold,
    italic: false,
    shadow: false,
  };
}

function textDoc(text: string) {
  return {
    type: "doc",
    content: [{
      type: "paragraph",
      ...(text.trim() ? { content: [{ type: "text", text }] } : {}),
    }],
  };
}
