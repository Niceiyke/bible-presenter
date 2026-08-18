import type { LowerThirdData, LowerThirdPayload, LowerThirdTemplate } from "../types";
import { DEFAULT_LT_TEMPLATE } from "../types";

/** Substitute runtime tokens ({time}, {date}) used by free-text lower thirds. */
export function substituteTokens(text: string): string {
  const now = new Date();
  return text
    .replace(/{time}/g, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
    .replace(/{date}/g, now.toLocaleDateString());
}

/** One resolved text style slot. Sizes are authored px (pre-scale). */
export interface LtStyleSlot {
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
}

export interface LtGeometry {
  isFullWidth: boolean;
  widthPct: number;
  hAlign: "left" | "center" | "right";
  vAlign: "top" | "middle" | "bottom";
  offsetX: number;
  offsetY: number;
  paddingX: number;
  paddingY: number;
  borderRadius: number;
  maxLines: number;
}

export interface LtBackground {
  type: "solid" | "gradient" | "image" | "transparent";
  color: string;
  gradientEnd: string;
  /** 0..100 */
  opacity: number;
  imagePath?: string;
  blurEnabled: boolean;
  blur: number;
}

/**
 * The resolved lower-third document: a single normalized descriptor that every
 * renderer consumes. The DOM `LowerThirdOverlay` and the canvas `drawLowerThird`
 * both resolve through `resolveLowerThird`, so content→slot mapping, style
 * slots, background, and accent/border/shadow tokens can never drift apart —
 * the canvas path is no longer a hand-rolled approximation of the DOM path.
 */
export interface ResolvedLowerThird {
  template: LowerThirdTemplate;
  kind: LowerThirdData["kind"];
  content: {
    headline: string;
    subline: string;
    kicker: string;
    badgeText: string;
    tickerMode: boolean;
    bodyText: string;
  };
  slots: {
    showHeadline: boolean;
    showSubline: boolean;
    showKicker: boolean;
    headline: LtStyleSlot;
    subline: LtStyleSlot;
    kicker: LtStyleSlot;
  };
  background: LtBackground;
  accent: { enabled: boolean; color: string; side: "left" | "right" | "top" | "bottom"; width: number };
  border: { enabled: boolean; color: string; width: number };
  boxShadow: { enabled: boolean; color: string; blur: number };
  textShadow: { enabled: boolean; color: string; blur: number };
  outline: { enabled: boolean; color: string; width: number };
  geometry: LtGeometry;
  animation: { entry: string; exit: string; duration: number; exitDuration: number };
  variant: LowerThirdTemplate["variant"];
  scroll: {
    enabled: boolean;
    direction: "ltr" | "rtl";
    speed: number;
    separator: string;
    gap: number;
    count: number;
  };
}

/** Normalize a template against defaults. */
export function normalizeLtTemplate(template?: LowerThirdTemplate | null): LowerThirdTemplate {
  return { ...DEFAULT_LT_TEMPLATE, ...(template || {}) };
}

function slotFor(t: LowerThirdTemplate, slot: "primary" | "secondary" | "label"): LtStyleSlot {
  if (slot === "label") {
    return { font: t.secondaryFont, size: t.labelSize, color: t.labelColor, bold: true, italic: false, uppercase: t.labelUppercase };
  }
  if (slot === "secondary") {
    return { font: t.secondaryFont, size: t.secondarySize, color: t.secondaryColor, bold: t.secondaryBold, italic: t.secondaryItalic, uppercase: t.secondaryUppercase };
  }
  return { font: t.primaryFont, size: t.primarySize, color: t.primaryColor, bold: t.primaryBold, italic: t.primaryItalic, uppercase: t.primaryUppercase };
}

/**
 * Resolve a live lower-third document into the shared renderer descriptor.
 * Content→slot mapping follows the template's nameStyle/titleStyle/labelStyle
 * so a song can be rendered with the design the operator chose.
 */
export function resolveLowerThird(payload: LowerThirdPayload): ResolvedLowerThird {
  const t = normalizeLtTemplate(payload.template);
  const data = payload.data;

  const tickerMode = data.kind === "FreeText" && t.scrollEnabled;
  let headline = "";
  let subline = "";
  let kicker = "";
  if (data.kind === "Nameplate") {
    headline = data.data.name;
    subline = data.data.title || "";
  } else if (data.kind === "Lyrics") {
    headline = data.data.line1;
    subline = data.data.line2 || "";
    if (data.data.section_label && t.labelVisible) kicker = data.data.section_label;
  } else if (!tickerMode) {
    headline = data.data.text;
  }

  const showHeadline = headline.length > 0 && t.nameStyle !== "none";
  const showSubline = subline.length > 0 && t.titleStyle !== "none";
  const showKicker = kicker.length > 0 && t.labelStyle !== "none";

  const badgeText =
    data.kind === "Lyrics" ? (showKicker ? kicker : t.bannerBadgeText || "LIVE") : t.bannerBadgeText || "LIVE";

  return {
    template: t,
    kind: data.kind,
    content: {
      headline,
      subline,
      kicker,
      badgeText,
      tickerMode,
      bodyText: tickerMode ? substituteTokens(data.data.text) : "",
    },
    slots: {
      showHeadline,
      showSubline,
      showKicker,
      headline: slotFor(t, t.nameStyle === "none" ? "primary" : t.nameStyle),
      subline: slotFor(t, t.titleStyle === "none" ? "primary" : t.titleStyle),
      kicker: slotFor(t, t.labelStyle === "none" ? "label" : t.labelStyle),
    },
    background: {
      type: t.bgType === "image" && !t.bgImagePath ? "transparent" : (t.bgType as LtBackground["type"]),
      color: t.bgColor,
      gradientEnd: t.bgGradientEnd,
      opacity: t.bgOpacity,
      imagePath: t.bgImagePath,
      blurEnabled: t.bgBlur,
      blur: t.bgBlurAmount,
    },
    accent: { enabled: t.accentEnabled, color: t.accentColor, side: t.accentSide, width: t.accentWidth },
    border: { enabled: t.borderEnabled, color: t.borderColor, width: t.borderWidth },
    boxShadow: { enabled: t.boxShadow, color: t.boxShadowColor, blur: t.boxShadowBlur },
    textShadow: { enabled: t.textShadow, color: t.textShadowColor, blur: t.textShadowBlur },
    outline: { enabled: t.textOutline, color: t.textOutlineColor, width: t.textOutlineWidth },
    geometry: {
      isFullWidth: t.widthPct >= 100,
      widthPct: t.widthPct,
      hAlign: t.hAlign,
      vAlign: t.vAlign,
      offsetX: t.offsetX,
      offsetY: t.offsetY,
      paddingX: t.paddingX,
      paddingY: t.paddingY,
      borderRadius: t.borderRadius,
      maxLines: t.maxLines,
    },
    animation: { entry: t.entryAnimation || t.animation, exit: t.exitAnimation || t.animation, duration: t.animationDuration, exitDuration: t.exitDuration },
    variant: t.variant,
    scroll: {
      enabled: t.scrollEnabled,
      direction: t.scrollDirection,
      speed: t.scrollSpeed,
      separator: t.scrollSeparator,
      gap: t.scrollGap,
      count: t.scrollCount,
    },
  };
}