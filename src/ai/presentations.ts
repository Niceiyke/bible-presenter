import type {
  CustomPresentation,
  CustomSlide,
  ProseMirrorJSON,
  SlideTheme,
  TextElement,
  Verse,
} from "../types";
import { newTextElement, stableId } from "../utils";

export type AiSlideKind = "title" | "point" | "scripture" | "quote" | "application" | "recap" | "closing";
export type AiEmphasisStyle = "accent" | "bold" | "accent-bold";

export interface AiEmphasis {
  text: string;
  style: AiEmphasisStyle;
}

export interface AiVerifiedScripture {
  reference: string;
  verses: Verse[];
}

export interface AiPlannedSlide {
  kind: AiSlideKind;
  title: string;
  body: string;
  bullets: string[];
  scriptureReferences: string[];
  quote: string;
  attribution: string;
  speakerNotes: string;
  emphasis: AiEmphasis[];
  scriptures: AiVerifiedScripture[];
}

export interface AiDeckPlan {
  title: string;
  objective: string;
  slides: AiPlannedSlide[];
  warnings: string[];
}

export interface AiPresentationRequest {
  jobId: string;
  topic: string;
  notes: string;
  audience: string;
  presentationType: string;
  slideCount: number;
  bibleVersion: string;
  includeSpeakerNotes: boolean;
  highlightKeyPoints: boolean;
}

export type AiSlideEditAction =
  | "shorten"
  | "rewrite"
  | "bullets"
  | "highlight"
  | "speaker-notes"
  | "regenerate-slide";

export interface AiSlideEditRequest {
  jobId: string;
  action: AiSlideEditAction;
  content: string;
  slideContext: string;
  presentationTitle: string;
  bibleVersion: string;
}

export interface AiSlideEditResult {
  slide: AiPlannedSlide;
  warnings: string[];
}

export const AI_PRESENTATION_THEME: SlideTheme = {
  id: "ai-default-theme",
  name: "Midnight Amber",
  defaultFontFamily: "Arial",
  defaultFontSize: 34,
  titleStyle: { font_family: "Arial", font_size: 60, color: "#ffffff", bold: true },
  bodyStyle: { font_family: "Arial", font_size: 34, color: "#ffffff" },
  textColor: "#ffffff",
  accentColor: "#f59e0b",
  background: { type: "gradient", from: "#111827", to: "#1a1a2e", angle: 135 },
};

type RichNode = {
  type: "text";
  text: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

function emphasisMarks(style: AiEmphasisStyle, accentColor: string): RichNode["marks"] {
  const marks: NonNullable<RichNode["marks"]> = [];
  if (style === "bold" || style === "accent-bold") marks.push({ type: "bold" });
  if (style === "accent" || style === "accent-bold") {
    marks.push({ type: "textStyle", attrs: { color: accentColor } });
  }
  return marks;
}

/** Convert plain generated text plus verified exact-substring emphasis into safe ProseMirror JSON. */
export function aiTextToDoc(
  text: string,
  emphasis: AiEmphasis[],
  accentColor: string,
): ProseMirrorJSON {
  const phrases = emphasis
    .filter((item) => item.text.trim())
    .sort((a, b) => b.text.length - a.text.length);
  const lower = text.toLocaleLowerCase();
  const ranges: Array<{ start: number; end: number; style: AiEmphasisStyle }> = [];

  for (const item of phrases) {
    const needle = item.text.toLocaleLowerCase();
    let offset = 0;
    while (offset < lower.length) {
      const start = lower.indexOf(needle, offset);
      if (start < 0) break;
      const end = start + needle.length;
      const overlaps = ranges.some((range) => start < range.end && end > range.start);
      if (!overlaps) ranges.push({ start, end, style: item.style });
      offset = end;
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const nodes: RichNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) nodes.push({ type: "text", text: text.slice(cursor, range.start) });
    nodes.push({
      type: "text",
      text: text.slice(range.start, range.end),
      marks: emphasisMarks(range.style, accentColor),
    });
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push({ type: "text", text: text.slice(cursor) });

  return {
    type: "doc",
    content: [{ type: "paragraph", ...(nodes.length ? { content: nodes } : {}) }],
  } as ProseMirrorJSON;
}

export function bulletsToDoc(bullets: string[], emphasis: AiEmphasis[], accentColor: string): ProseMirrorJSON {
  return {
    type: "doc",
    content: [{
      type: "bulletList",
      content: bullets.map((bullet) => ({
        type: "listItem",
        content: (aiTextToDoc(bullet, emphasis, accentColor).content as unknown[]),
      })),
    }],
  } as ProseMirrorJSON;
}

/** Plain text sent to the AI editing boundary; no raw editor HTML is sent. */
export function proseMirrorToPlainText(content: ProseMirrorJSON | string): string {
  if (typeof content === "string") {
    return content
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const lines: string[] = [];
  const walk = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const value = node as { type?: string; text?: string; content?: unknown[] };
    if (value.type === "text") return value.text ?? "";
    const text = (value.content ?? []).map(walk).join("");
    if (["paragraph", "heading", "listItem"].includes(value.type ?? "") && text.trim()) {
      lines.push(text.trim());
      return "";
    }
    return text;
  };
  const remainder = walk(content).trim();
  if (remainder) lines.push(remainder);
  return lines.join("\n").trim();
}

export function slideToPlainText(slide: CustomSlide): string {
  const visible = slide.elements
    .filter((element): element is TextElement => element.kind === "text" && !element.hidden)
    .sort((a, b) => a.z_index - b.z_index)
    .map((element) => proseMirrorToPlainText(element.content))
    .filter(Boolean);
  if (slide.notes?.trim()) visible.push(`Speaker notes: ${slide.notes.trim()}`);
  return visible.join("\n\n").trim();
}

export function editedSlideVisibleText(slide: AiPlannedSlide): string {
  if (slide.scriptures.length > 0) {
    return slide.scriptures
      .map((scripture) => `${canonicalScriptureReference(scripture)}\n${scripture.verses.map((verse) => verse.text).join(" ")}`)
      .join("\n\n");
  }
  return [slide.title, slide.body, ...slide.bullets, slide.quote, slide.attribution]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

export function applyAiTextEdit(
  element: TextElement,
  result: AiSlideEditResult,
  action: AiSlideEditAction,
  accentColor: string,
): Partial<TextElement> {
  const generated = result.slide;
  if (action === "highlight") {
    const original = proseMirrorToPlainText(element.content);
    return { content: aiTextToDoc(original, generated.emphasis, accentColor) };
  }
  if (action === "bullets") {
    return {
      content: bulletsToDoc(generated.bullets, generated.emphasis, accentColor),
      align: "left",
    };
  }
  const text = generated.body.trim() || generated.bullets.join("\n").trim();
  return { content: aiTextToDoc(text, generated.emphasis, accentColor) };
}

/** Replace semantic text while retaining the slide's background, element IDs,
 * geometry, media, and styling. Falls back to a deterministic native layout
 * only when the source slide has no editable text boxes. */
export function applyAiRegeneratedSlide(
  existing: CustomSlide,
  generated: AiPlannedSlide,
  theme: SlideTheme,
  presentationTitle: string,
): CustomSlide {
  const textElements = existing.elements
    .filter((element): element is TextElement => element.kind === "text" && !element.locked)
    .sort((a, b) => a.z_index - b.z_index);
  if (textElements.length === 0) {
    const compiled = compileSlide(generated, {
      title: presentationTitle,
      objective: "",
      slides: [generated],
      warnings: [],
    }, theme);
    return { ...compiled, id: existing.id, background: { ...existing.background } };
  }

  let title = generated.title.trim();
  let bodyDoc: ProseMirrorJSON;
  if (generated.scriptures.length > 0) {
    title = generated.scriptures.map(canonicalScriptureReference).join(" · ");
    bodyDoc = aiTextToDoc(
      generated.scriptures.flatMap((item) => item.verses).map((verse) => verse.text).join(" "),
      generated.emphasis,
      theme.accentColor,
    );
  } else if (generated.bullets.length > 0) {
    bodyDoc = bulletsToDoc(generated.bullets, generated.emphasis, theme.accentColor);
  } else {
    bodyDoc = aiTextToDoc(generated.quote || generated.body, generated.emphasis, theme.accentColor);
  }

  const titleElement = textElements.find((element) => element.role === "title") ?? textElements[0];
  const bodyElement = textElements.find((element) => element.role === "body" && element.id !== titleElement.id)
    ?? textElements.find((element) => element.id !== titleElement.id);
  const elements = existing.elements.map((element) => {
    if (element.kind !== "text") return element;
    if (element.id === titleElement.id) {
      if (!bodyElement) {
        if (generated.bullets.length > 0 || generated.scriptures.length > 0 || !title) {
          return { ...element, content: bodyDoc, ...(generated.bullets.length > 0 ? { align: "left" as const } : {}) };
        }
        const combined = [title, generated.quote || generated.body, generated.attribution]
          .map((value) => value.trim())
          .filter(Boolean)
          .join("\n\n");
        return { ...element, content: aiTextToDoc(combined, generated.emphasis, theme.accentColor) };
      }
      return { ...element, content: aiTextToDoc(title || presentationTitle, generated.emphasis, theme.accentColor) };
    }
    if (bodyElement && element.id === bodyElement.id) {
      return { ...element, content: bodyDoc, ...(generated.bullets.length > 0 ? { align: "left" as const } : {}) };
    }
    return element;
  });
  return {
    ...existing,
    elements,
    notes: generated.speakerNotes.trim() || existing.notes,
  };
}

function textElement(options: Partial<Omit<TextElement, "id" | "kind">>): TextElement {
  return newTextElement({
    font_family: "inherit",
    color: "inherit",
    shadow: true,
    shadow_color: "#000000",
    ...options,
  });
}

function baseSlide(notes: string | undefined, theme: SlideTheme): CustomSlide {
  return {
    id: stableId(),
    background: { ...theme.background },
    elements: [],
    notes: notes || undefined,
  };
}

function compileTitleSlide(slide: AiPlannedSlide, plan: AiDeckPlan, theme: SlideTheme): CustomSlide {
  const result = baseSlide(slide.speakerNotes, theme);
  result.elements = [textElement({
    x: 9, y: 28, w: 82, h: 36, z_index: 1,
    role: "title",
    content: aiTextToDoc(slide.title || plan.title, slide.emphasis, theme.accentColor),
    font_size: 70,
    align: "center", v_align: "middle", bold: true,
    autoSize: "shrink",
  })];
  if (slide.body.trim()) {
    result.elements.push(textElement({
      x: 15, y: 67, w: 70, h: 12, z_index: 2,
      role: "footer",
      content: aiTextToDoc(slide.body, slide.emphasis, theme.accentColor),
      font_size: 28, align: "center", v_align: "middle", autoSize: "shrink",
    }));
  }
  return result;
}

function compileScriptureSlide(slide: AiPlannedSlide, theme: SlideTheme): CustomSlide | null {
  const verified = slide.scriptures.flatMap((item) => item.verses);
  if (verified.length === 0) return null;
  const references = slide.scriptures.map(canonicalScriptureReference).join(" · ");
  const verseText = verified.map((verse) => verse.text).join(" ");
  const result = baseSlide(slide.speakerNotes, theme);
  result.elements = [
    textElement({
      x: 10, y: 12, w: 80, h: 14, z_index: 1,
      role: "title", content: aiTextToDoc(references, [], theme.accentColor),
      font_size: 38, color: theme.accentColor, bold: true, align: "center", v_align: "middle",
      autoSize: "shrink",
    }),
    textElement({
      x: 11, y: 30, w: 78, h: 54, z_index: 2,
      role: "body", content: aiTextToDoc(verseText, slide.emphasis, theme.accentColor),
      font_size: 38, font_family: "Georgia", italic: true, align: "center", v_align: "middle",
      autoSize: "shrink",
    }),
  ];
  return result;
}

export function canonicalScriptureReference(scripture: AiVerifiedScripture): string {
  const first = scripture.verses[0];
  const last = scripture.verses[scripture.verses.length - 1];
  if (!first) return scripture.reference;
  if (last && last.book === first.book && last.chapter === first.chapter && last.verse !== first.verse) {
    return `${first.book} ${first.chapter}:${first.verse}-${last.verse}`;
  }
  return `${first.book} ${first.chapter}:${first.verse}`;
}

function compileQuoteSlide(slide: AiPlannedSlide, theme: SlideTheme): CustomSlide {
  const result = baseSlide(slide.speakerNotes, theme);
  result.elements = [
    textElement({
      x: 11, y: 18, w: 78, h: 48, z_index: 1,
      content: aiTextToDoc(slide.quote || slide.body, slide.emphasis, theme.accentColor),
      font_size: 50, font_family: "Georgia", italic: true, align: "center", v_align: "middle",
      autoSize: "shrink",
    }),
    textElement({
      x: 15, y: 69, w: 70, h: 12, z_index: 2,
      content: aiTextToDoc(slide.attribution, [], theme.accentColor),
      font_size: 28, color: theme.accentColor, bold: true, align: "center", v_align: "middle",
      autoSize: "shrink",
    }),
  ];
  return result;
}

function compileContentSlide(slide: AiPlannedSlide, theme: SlideTheme): CustomSlide {
  const result = baseSlide(slide.speakerNotes, theme);
  const bodyContent = slide.bullets.length > 0
    ? bulletsToDoc(slide.bullets, slide.emphasis, theme.accentColor)
    : aiTextToDoc(slide.body, slide.emphasis, theme.accentColor);
  result.elements = [
    textElement({
      x: 8, y: 9, w: 84, h: 20, z_index: 1,
      role: "title", content: aiTextToDoc(slide.title, slide.emphasis, theme.accentColor),
      font_size: 54, bold: true, align: "center", v_align: "middle", autoSize: "shrink",
    }),
    textElement({
      x: 12, y: 32, w: 76, h: 55, z_index: 2,
      role: "body", content: bodyContent,
      font_size: slide.kind === "recap" ? 38 : 34,
      align: slide.bullets.length > 0 ? "left" : "center", v_align: "middle", autoSize: "shrink",
    }),
  ];
  return result;
}

function compileSlide(slide: AiPlannedSlide, plan: AiDeckPlan, theme: SlideTheme): CustomSlide {
  if (slide.kind === "title") return compileTitleSlide(slide, plan, theme);
  if (slide.kind === "scripture") {
    const scripture = compileScriptureSlide(slide, theme);
    if (scripture) return scripture;
  }
  if (slide.kind === "quote") return compileQuoteSlide(slide, theme);
  return compileContentSlide(slide, theme);
}

export function compileAiDeckPlan(plan: AiDeckPlan): CustomPresentation {
  const theme: SlideTheme = {
    ...AI_PRESENTATION_THEME,
    id: stableId(),
    background: { ...AI_PRESENTATION_THEME.background },
  };
  return {
    id: stableId(),
    name: plan.title.trim() || "AI Presentation",
    version: 2,
    theme,
    slides: plan.slides.map((slide) => compileSlide(slide, plan, theme)),
  };
}
