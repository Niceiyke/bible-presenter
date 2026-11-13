import type { CustomPresentation, PresentationSummary, SlideElement, SlideMaster } from "../types";
import { newDefaultSlide, stableId } from "../utils";

export type PresentationSort = "updated" | "name" | "slides";
export type PresentationView = "grid" | "list";

export interface PresentationLibraryPreferences {
  sort: PresentationSort;
  view: PresentationView;
  favorites: string[];
}

export const PRESENTATION_LIBRARY_PREFERENCES_KEY = "pref_presentationLibraryV1";

export const DEFAULT_PRESENTATION_LIBRARY_PREFERENCES: PresentationLibraryPreferences = {
  sort: "updated",
  view: "grid",
  favorites: [],
};

export function loadPresentationLibraryPreferences(): PresentationLibraryPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESENTATION_LIBRARY_PREFERENCES_KEY) ?? "null") as Partial<PresentationLibraryPreferences> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PRESENTATION_LIBRARY_PREFERENCES;
    return {
      sort: parsed.sort === "name" || parsed.sort === "slides" ? parsed.sort : "updated",
      view: parsed.view === "list" ? "list" : "grid",
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return DEFAULT_PRESENTATION_LIBRARY_PREFERENCES;
  }
}

export function savePresentationLibraryPreferences(preferences: PresentationLibraryPreferences): void {
  try {
    localStorage.setItem(PRESENTATION_LIBRARY_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Workspace preferences are a progressive enhancement; library operation
    // must not depend on browser storage being available.
  }
}

export function filterAndSortPresentations(
  presentations: PresentationSummary[],
  query: string,
  sort: PresentationSort,
  favorites: string[],
): PresentationSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const favoriteIds = new Set(favorites);
  const filtered = normalizedQuery
    ? presentations.filter((presentation) => presentation.name.toLocaleLowerCase().includes(normalizedQuery))
    : presentations;

  return [...filtered].sort((a, b) => {
    const favoriteDifference = Number(favoriteIds.has(b.id)) - Number(favoriteIds.has(a.id));
    if (favoriteDifference !== 0) return favoriteDifference;
    if (sort === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (sort === "slides") return b.slide_count - a.slide_count || b.updated_at - a.updated_at;
    return b.updated_at - a.updated_at;
  });
}

export function formatPresentationUpdatedAt(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Update time unavailable";
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "Updated just now";
  if (elapsed < hour) return `Updated ${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `Updated ${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `Updated ${Math.floor(elapsed / day)}d ago`;
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp)}`;
}

export function createBlankPresentation(name = "Untitled Presentation"): CustomPresentation {
  return {
    id: stableId(),
    name,
    slides: [newDefaultSlide()],
    version: 2,
    theme: {
      id: stableId(),
      name: "Modern Dark",
      defaultFontFamily: "Arial",
      defaultFontSize: 32,
      titleStyle: { font_family: "Arial", font_size: 60, color: "#ffffff", bold: true },
      bodyStyle: { font_family: "Arial", font_size: 32, color: "#ffffff" },
      textColor: "#ffffff",
      accentColor: "#f7b500",
      background: { type: "color", value: "#101722" },
    },
  };
}

function cloneElements(elements: SlideElement[]): SlideElement[] {
  const groupIds = new Map<string, string>();
  return elements.map((element) => {
    const next = structuredClone(element);
    next.id = stableId();
    if (next.groupId) {
      const existing = groupIds.get(next.groupId);
      const replacement = existing ?? stableId();
      groupIds.set(next.groupId, replacement);
      next.groupId = replacement;
    }
    return next;
  });
}

function cloneMaster(master: SlideMaster): SlideMaster {
  return {
    ...structuredClone(master),
    id: stableId(),
    elements: cloneElements(master.elements),
  };
}

/** Creates an independent editable copy while preserving media references. */
export function duplicatePresentation(source: CustomPresentation): CustomPresentation {
  const masterIds = new Map<string, string>();
  const masters = source.masters?.map((master) => {
    const duplicate = cloneMaster(master);
    masterIds.set(master.id, duplicate.id);
    return duplicate;
  });

  return {
    ...structuredClone(source),
    id: stableId(),
    name: `${source.name} Copy`,
    version: Math.max(2, source.version ?? 2),
    theme: source.theme ? { ...structuredClone(source.theme), id: stableId() } : undefined,
    masters,
    slides: source.slides.map((slide) => ({
      ...structuredClone(slide),
      id: stableId(),
      masterRef: slide.masterRef ? masterIds.get(slide.masterRef) : undefined,
      elements: cloneElements(slide.elements),
    })),
  };
}
