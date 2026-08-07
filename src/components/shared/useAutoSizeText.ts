/**
 * `useAutoSizeText` — generalized shrink-to-fit for slide text elements
 * (Phase 3.3 of the slide-modernization plan).
 *
 * Reuses the binary-search algorithm previously inlined in
 * `OutputWindow.tsx` so every consumer of `CustomSlideRenderer` (the
 * operator canvas, the thumbnail rail, the output window, the stage
 * window) honors the same auto-fit policy. The previous verse-only
 * implementation additionally mixed in projection-window frame
 * geometry; this hook is intentionally element-local: callers hand
 * it a ref to the rendered text container and a declaration of the
 * element's nominal size/family, and the hook returns the largest
 * `fontPt` value (capped at `maxPt`) that keeps `scrollHeight ≤ clientHeight`.
 *
 * The hook owns the probe element so the search O(log n)-samples the
 * browser's text metrics rather than re-rendering the React tree
 * (the latter would re-trigger layout per iteration).
 *
 * Determinism: insertions only render once. `Math.floor` of the
 * result is returned to avoid sub-pixel drift between the operator
 * and output windows, which would otherwise flicker as the binary
 * search settled on e.g. `42.87pt` versus `42.85pt`.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { TextElement, SlideTheme } from "../../types";

export interface AutoSizeOpts {
  /** Effective font-size in points *before* auto-fit is applied
   *  (i.e. `font_size ?? theme.defaultFontSize ?? 32` multiplied by
   *  the renderer scale). This is the upper bound; the algorithm
   *  searches *down* from here. */
  maxPt: number;
  /** Effective font family (already cascaded through the theme for
   *  `el.font_family === "inherit"`). */
  fontFamily: string;
  /** Effective colour, weight, style, alignment so the probe element
   *  matches the rendered text node. */
  weight: "bold" | "normal";
  style: "italic" | "normal";
  align: "left" | "center" | "right";
  /** Height the result must fit inside, in CSS px. Usually the
   *  element box (`clientHeight`) minus a small inset so long
   *  paragraphs don't render flush against the element border. */
  availableHeight: number;
  /** Width of the probe element, in CSS px. */
  availableWidth: number;
  /** Concrete text content for the probe. Caller must serialize the
   *  JSON doc to plain text before invoking the hook. */
  plainText: string;
  /** Declared line-height; defaults to the value used by
   *  `CustomSlideRenderer`'s text style (`1.3`) so the probe
   *  matches the on-screen text. */
  lineHeight?: number;
}

/** Returns `null` when no shrink was needed (the declared size fit,
 *  meaning the caller should fall back to `maxPt`). */
export function useAutoSizeText(
  enabled: boolean,
  opts: AutoSizeOpts | null,
): number | null {
  const [fitted, setFitted] = useState<number | null>(null);
  const probeRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !opts) {
      setFitted(null);
      return;
    }
    if (opts.availableWidth <= 0 || opts.availableHeight <= 0) {
      setFitted(null);
      return;
    }

    const probe = document.createElement("p");
    probe.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "pointer-events:none",
      `width:${opts.availableWidth}px`,
      `font-family:${opts.fontFamily}`,
      `font-weight:${opts.weight}`,
      `font-style:${opts.style}`,
      `text-align:${opts.align}`,
      "white-space:normal",
      "word-break:break-word",
      `line-height:${opts.lineHeight ?? 1.3}`,
    ].join(";");
    // Attach to the document body so the probe inherits webview font
    // settings; the renderer's element box doesn't need to exist yet.
    document.body.appendChild(probe);
    probeRef.current = probe;

    let lo = 8; // Minimum sensible point size; below this the text is unreadable.
    let hi = opts.maxPt;
    let best = lo;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      probe.style.fontSize = `${mid}pt`;
      probe.textContent = opts.plainText;
      if (probe.scrollHeight <= opts.availableHeight) {
        best = mid;
        lo = mid + 0.25;
      } else {
        hi = mid - 0.25;
      }
    }

    document.body.removeChild(probe);
    probeRef.current = null;
    setFitted(best < opts.maxPt ? Math.floor(best) : null);
  }, [enabled, opts]);

  return fitted;
}

/**
 * Generalised version of the OutputWindow verse-fit routine: resolve
 * the cascade for the element's font properties so the auto-fit
 * algorithm uses the same values the renderer will paint with.
 */
export function resolveAutoSizeInputs(
  el: TextElement,
  theme: SlideTheme | undefined,
  scale: number,
  plainText: string,
  containerHeight: number,
  containerWidth: number,
): AutoSizeOpts {
  const fontFamily =
    el.font_family === "inherit" || el.font_family === undefined
      ? theme?.defaultFontFamily ?? "Arial"
      : el.font_family;
  const baseFontSize =
    el.font_size === "inherit" || el.font_size === undefined
      ? theme?.defaultFontSize ?? 32
      : el.font_size;
  return {
    maxPt: baseFontSize * scale,
    fontFamily,
    weight: el.bold ? "bold" : "normal",
    style: el.italic ? "italic" : "normal",
    align: el.align ?? "left",
    availableHeight: containerHeight,
    availableWidth: containerWidth,
    plainText,
  };
}

/**
 * Lightweight text extractor matching `items/registry.tsx`'s
 * `stageDetail` walker — keep them byte-identical so auto-fit and
 * stage labels agree on the visible characters.
 */
export function docToPlainText(content: TextElement["content"]): string {
  if (typeof content === "string") return content.replace(/<[^>]+>/g, "");
  const walk = (node: any): string => {
    if (!node) return "";
    if (typeof node === "string") return node;
    const txt = (node.text ?? "") as string;
    const inner = Array.isArray(node.content) ? node.content.map(walk).join("") : "";
    return txt + inner;
  };
  return walk(content) || "";
}