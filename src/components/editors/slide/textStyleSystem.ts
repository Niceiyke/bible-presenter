/**
 * Unified typography system for slide text (Phase 5.2).
 *
 * The slide editor previously had three uncoordinated font-size sources:
 * the element default (`TextElement.font_size`), per-selection Tiptap
 * marks (`textStyle.fontSize`), and P4.3 paragraph-style recipe blobs
 * (`data-style`). That produced drift — different step sizes across the
 * toolbar / inline editor / keyboard, a readout that ignored recipe
 * sizes, and bump operations that stepped from the wrong base.
 *
 * This module is the single source of truth for:
 *   - the step/clamp policy every control shares,
 *   - the resolution cascade (theme → paragraph recipe → element → marks),
 *   - the inherit-aware element default resolution used by the renderer
 *     and the auto-size probe.
 *
 * It is deliberately framework-free: the early `bumpFontSize`/readout
 * logic lived inline in `InlineTextEditor`; keeping the resolution here
 * as pure functions lets every consumer (toolbar, inline editor, renderer,
 * thumbnail, stage) agree on the same numbers and lets the tests pin
 * the behavior down.
 */

import type { SlideTheme, TextElement, TextStyle as TextStyleType } from "../../../types";

// ─── Step / clamp policy ─────────────────────────────────────────────────────

/** Minimum sensible point size; below this text is unreadable and every
 *  control clamps to the same floor. */
export const FONT_SIZE_MIN = 8;
/** Reasonable ceiling so an accidental keystroke can't balloon a size
 *  past the point where it becomes a deliberate choice. */
export const FONT_SIZE_MAX = 600;
/** The single step every A+/A−/+2/−2/shortcut control uses. Previously
 *  the toolbar stepped by 2 and the inline editor + keyboard by 4. */
export const FONT_SIZE_STEP = 2;

/** Round + clamp a font size into `[FONT_SIZE_MIN, FONT_SIZE_MAX]`.
 *  Non-finite input saturates (positive Infinity → ceiling, NaN /
 *  negative Infinity → floor) so a bad value can never produce an
 *  unreadable or invalid `pt` string. */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return n > 0 ? FONT_SIZE_MAX : FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** Compute the next size after a `delta` step, applying the shared clamp. */
export function stepFontSize(base: number, delta: number): number {
  return clampFontSize(base + delta);
}

/** Parse a `pt` string ("48pt", "32.5pt") or a bare number into a font
 *  size. Returns `null` for anything else so callers can fall through the
 *  cascade. Accepts any casing of the unit. */
export function parsePt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const m = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)pt$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── Render-space scale reconciliation ──────────────────────────────────────

/**
 * The slide renderer authors every font size against a reference space
 * (element `font_size` and per-word marks are both absolute points). The
 * windows scale the *element base* by `scale` (`fontSize * scale` on the
 * container) so text fills the current viewport — but per-word marks and
 * P4.3 recipe blobs were emitted as absolute `pt` inline styles, so they
 * escaped the scale entirely and overflowed the element box at any
 * `scale !== 1`.
 *
 * Fix: emit those sizes as `calc(<n>pt * var(--slide-scale))`. The
 * container defines `--slide-scale` = the renderer's current scale (the
 * editor sets it to `canvasScale`, the output/stage/thumbnail to their
 * fit scale). The base text is painted at `fontSize * scale` and every
 * mark/recipe then scales in lock-step (`48pt * scale`), so there is a
 * single multiply point and no absolute-pt drift. `calc()` with a `var()`
 * is used instead of `em` because `em` inside a recipe paragraph that is
 * itself scaled would compound against the altered parent font-size.
 */

/** Wrap every `font-size: <n>pt` declaration in a style string with the
 * `--slide-scale` calc so per-element/recipe sizes inherit the container's
 * scale factor. Non-`pt` values (px, em, unitless) pass through. */
export function ptStylesToScale(style: string): string {
  if (!style) return style;
  return style.replace(/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)pt/gi, (_m, n) => {
    return `font-size: calc(${n}pt * var(--slide-scale))`;
  });
}

/** Wrap a single `"<n>pt"` size (as stored on a `textStyle` mark) in the
 *  `--slide-scale` calc so the per-word size inherits the container's
 *  scale. Non-`pt` values pass through unchanged. */
export function ptSizeToCalc(size: string): string {
  return ptStylesToScale(`font-size: ${size}`).replace(/^font-size:\s*/, "");
}

/** Same rewrite scoped to `style="…"` attribute bodies in an HTML string
 *  (span marks, `<p>` recipe styles, legacy HTML content). */
export function ptToScaleHtml(html: string): string {
  if (!html) return html;
  return html.replace(/style="([^"]*)"/g, (_m, style) => {
    const next = ptStylesToScale(style);
    return next === style ? _m : `style="${next}"`;
  });
}

// ─── P4.3 paragraph-style recipes ────────────────────────────────────────────

export type ParagraphStyleRecipe = Partial<TextStyleType> & { indent?: string };

/** Resolve a theme-defined paragraph style recipe to the inline CSS
 *  string the paragraph node stores. The output is the *render contract*
 *  — the projection window re-emits this string back onto the `<p>` via
 *  `sanitizeSlideHtml`, so the recipe must be stable for a given theme. */
export function paragraphStyleCss(
  _name: string,
  recipe: ParagraphStyleRecipe,
  theme?: SlideTheme,
): string {
  const parts: string[] = [];
  const fam = recipe.font_family ?? theme?.defaultFontFamily ?? "Arial";
  const size = recipe.font_size ?? theme?.defaultFontSize ?? 32;
  parts.push(`font-family: ${fam}`);
  parts.push(`font-size: ${size}pt`);
  if (recipe.color) parts.push(`color: ${recipe.color}`);
  if (recipe.bold) parts.push("font-weight: bold");
  if (recipe.italic) parts.push("font-style: italic");
  if (recipe.align) parts.push(`text-align: ${recipe.align}`);
  if (recipe.indent) parts.push(`text-indent: ${recipe.indent}`);
  return parts.join("; ");
}

/** Match a paragraph node's stored `data-style` blob against the theme's
 *  recipes. The blob is a full rebuild of a recipe, so an exact string
 *  match is the way to recover the recipe (and its *size*) for readouts
 *  and bump operations that would otherwise fall back to the element
 *  default and mis-report a "Header" (48pt) paragraph as 32pt. */
export function findParagraphStyle(
  css: string | null | undefined,
  theme?: SlideTheme,
): { name: string; recipe: ParagraphStyleRecipe } | null {
  if (!css || !theme?.paragraphStyles) return null;
  for (const [name, recipe] of Object.entries(theme.paragraphStyles)) {
    if (paragraphStyleCss(name, recipe, theme) === css) return { name, recipe };
  }
  return null;
}

// ─── Element-level (inherit-aware) defaults ──────────────────────────────────

/** Effective font size of an element after resolving the `"inherit"` /
 *  undefined cascade against the theme. Mirrors what the renderer's
 *  `resolveElementTextStyle` paints. */
export function elementFontSize(el: Pick<TextElement, "font_size">, theme?: SlideTheme): number {
  const v = el.font_size;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return theme?.defaultFontSize ?? 32;
}

/** Inherit-aware element text style. This is the single element-level
 *  cascade endpoint — it replaces the duplicated copies previously in
 *  `Renderers.tsx` (`resolveTextFont`) and `useAutoSizeText.ts`
 *  (`resolveAutoSizeInputs`) so the editor CSS, the output renderer, and
 *  the auto-fit probe all paint with the same font. */
export function resolveElementTextStyle(
  el: Pick<TextElement, "font_family" | "font_size" | "color">,
  theme?: SlideTheme,
): { fontFamily: string; fontSize: number; color: string } {
  return {
    fontFamily:
      el.font_family === "inherit" || el.font_family === undefined
        ? theme?.defaultFontFamily ?? "Arial"
        : el.font_family,
    fontSize: elementFontSize(el, theme),
    color:
      el.color === "inherit" || el.color === undefined
        ? theme?.textColor ?? "#ffffff"
        : el.color,
  };
}

// ─── Selection-level resolution (inline editor) ──────────────────────────────

export interface FontSizeContext {
  /** The `textStyle` mark's current fontSize attribute, if any. */
  markSize: unknown;
  /** The paragraph node's stored `data-style` CSS blob, if any. */
  paragraphCss: string | null | undefined;
  /** The element-level declaration (a number, `"inherit"`, or absent). */
  elementSize: TextElement["font_size"];
  theme?: SlideTheme;
}

/** Resolve the font size the caret position actually paints with, in
 *  cascade order: selection mark → paragraph style recipe → element
 *  default → theme default. Previously the base ignored the recipe, so
 *  bumping the size of a "Header" (48pt) paragraph stepped from the
 *  element's 32pt default and the readout reported 32 for a paragraph
 *  painting at 48. */
export function resolveFontSize(ctx: FontSizeContext): number {
  const markPt = parsePt(ctx.markSize);
  if (markPt !== null) return markPt;
  const recipe = findParagraphStyle(ctx.paragraphCss, ctx.theme);
  if (recipe && typeof recipe.recipe.font_size === "number" && Number.isFinite(recipe.recipe.font_size)) {
    return recipe.recipe.font_size;
  }
  return elementFontSize({ font_size: ctx.elementSize }, ctx.theme);
}