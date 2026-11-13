import type { CustomPresentation, CustomSlide, SlideElement } from "../types";

export type SmartLayout = "balanced" | "hero" | "split-left" | "split-right" | "stack";

export interface PresentationBrandKit {
  name: string;
  fontFamily: string;
  textColor: string;
  accentColor: string;
  backgroundColor: string;
}

export const DEFAULT_BRAND_KIT: PresentationBrandKit = {
  name: "Church Brand",
  fontFamily: "Arial",
  textColor: "#ffffff",
  accentColor: "#f7b500",
  backgroundColor: "#101722",
};

const BRAND_KIT_KEY = "pref_presentationBrandKitV1";

export function loadBrandKit(): PresentationBrandKit {
  try {
    const value = JSON.parse(localStorage.getItem(BRAND_KIT_KEY) ?? "null") as Partial<PresentationBrandKit> | null;
    if (!value) return DEFAULT_BRAND_KIT;
    return {
      name: typeof value.name === "string" ? value.name : DEFAULT_BRAND_KIT.name,
      fontFamily: typeof value.fontFamily === "string" ? value.fontFamily : DEFAULT_BRAND_KIT.fontFamily,
      textColor: validHex(value.textColor) ? value.textColor : DEFAULT_BRAND_KIT.textColor,
      accentColor: validHex(value.accentColor) ? value.accentColor : DEFAULT_BRAND_KIT.accentColor,
      backgroundColor: validHex(value.backgroundColor) ? value.backgroundColor : DEFAULT_BRAND_KIT.backgroundColor,
    };
  } catch {
    return DEFAULT_BRAND_KIT;
  }
}

export function saveBrandKit(kit: PresentationBrandKit): void {
  try { localStorage.setItem(BRAND_KIT_KEY, JSON.stringify(kit)); } catch { /* optional preference */ }
}

function validHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function place(element: SlideElement, x: number, y: number, w: number, h: number, extra: Partial<SlideElement> = {}): SlideElement {
  if (element.locked) return element;
  return { ...element, x, y, w, h, ...extra } as SlideElement;
}

/** Deterministic layout recipes; content and element identities never change. */
export function applySmartLayout(slide: CustomSlide, layout: SmartLayout): CustomSlide {
  const visible = slide.elements.filter((element) => !element.hidden);
  const text = visible.filter((element) => element.kind === "text");
  const media = visible.filter((element) => element.kind === "image" || element.kind === "video");
  const firstTitle = text.find((element) => element.kind === "text" && element.role === "title") ?? text[0];
  const body = text.filter((element) => element.id !== firstTitle?.id);
  const changes = new Map<string, SlideElement>();

  if (layout === "hero") {
    media.forEach((element, index) => changes.set(element.id, place(element, 0, 0, 100, 100, { z_index: index })));
    if (firstTitle) changes.set(firstTitle.id, place(firstTitle, 10, 28, 80, 24, { align: "center", v_align: "middle", z_index: 20 }));
    body.forEach((element, index) => changes.set(element.id, place(element, 16, 56 + index * 13, 68, 11, { align: "center", v_align: "middle", z_index: 20 + index + 1 })));
  } else if (layout === "split-left" || layout === "split-right") {
    const mediaLeft = layout === "split-left";
    const mediaX = mediaLeft ? 0 : 55;
    const textX = mediaLeft ? 55 : 7;
    media.forEach((element, index) => changes.set(element.id, place(element, mediaX, index * (100 / Math.max(1, media.length)), 45, 100 / Math.max(1, media.length), { z_index: index })));
    if (firstTitle) changes.set(firstTitle.id, place(firstTitle, textX, 18, 38, 24, { align: "left", v_align: "middle", z_index: 20 }));
    body.forEach((element, index) => changes.set(element.id, place(element, textX, 48 + index * 17, 38, 14, { align: "left", v_align: "top", z_index: 21 + index })));
  } else if (layout === "stack") {
    const count = Math.max(1, visible.length);
    visible.forEach((element, index) => changes.set(element.id, place(element, 10, 7 + index * (86 / count), 80, Math.max(10, 78 / count), element.kind === "text" ? { align: "center", v_align: "middle" } : {})));
  } else {
    if (media.length > 0) {
      media.forEach((element, index) => changes.set(element.id, place(element, 52, 8 + index * (84 / media.length), 42, 78 / media.length)));
      if (firstTitle) changes.set(firstTitle.id, place(firstTitle, 7, 14, 39, 22, { align: "left", v_align: "middle" }));
      body.forEach((element, index) => changes.set(element.id, place(element, 7, 43 + index * 18, 39, 15, { align: "left", v_align: "top" })));
    } else {
      if (firstTitle) changes.set(firstTitle.id, place(firstTitle, 10, 15, 80, 22, { align: "center", v_align: "middle" }));
      body.forEach((element, index) => changes.set(element.id, place(element, 12, 43 + index * 17, 76, 14, { align: "center", v_align: "middle" })));
    }
  }

  return { ...slide, elements: slide.elements.map((element) => changes.get(element.id) ?? element) };
}

export function applyBrandKit(presentation: CustomPresentation, kit: PresentationBrandKit): CustomPresentation {
  return {
    ...presentation,
    theme: {
      ...(presentation.theme ?? {
        id: crypto.randomUUID(), name: kit.name, defaultFontSize: 32,
        titleStyle: {}, bodyStyle: {}, background: { type: "color", value: kit.backgroundColor },
      }),
      name: kit.name,
      defaultFontFamily: kit.fontFamily,
      textColor: kit.textColor,
      accentColor: kit.accentColor,
      background: { type: "color", value: kit.backgroundColor },
      titleStyle: { ...(presentation.theme?.titleStyle ?? {}), font_family: kit.fontFamily, color: kit.textColor },
      bodyStyle: { ...(presentation.theme?.bodyStyle ?? {}), font_family: kit.fontFamily, color: kit.textColor },
    },
    slides: presentation.slides.map((slide) => ({
      ...slide,
      background: slide.background.type === "color" || slide.background.type === "gradient"
        ? { type: "color", value: kit.backgroundColor }
        : slide.background,
      elements: slide.elements.map((element) => element.kind === "text" && !element.locked
        ? { ...element, font_family: kit.fontFamily, color: kit.textColor }
        : element),
    })),
  };
}

export function slidePlainText(slide: CustomSlide): string {
  const text: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (typeof value.text === "string") text.push(value.text);
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  slide.elements.forEach((element) => {
    if (element.kind !== "text") return;
    if (typeof element.content === "string") text.push(element.content.replace(/<[^>]+>/g, " "));
    else visit(element.content);
  });
  return text.join(" ").replace(/\s+/g, " ").trim();
}

export function slideLabel(slide: CustomSlide, index: number): string {
  const text = slidePlainText(slide);
  return text ? text.slice(0, 64) : `Slide ${index + 1}`;
}
