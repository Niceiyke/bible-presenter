/**
 * Custom Tiptap extensions for per-word inline styling.
 *
 * Phase 1.1 of the slide-modernization plan. These extensions are used by
 * the new Tiptap-based `InlineTextEditor` (replacing the hand-rolled
 * `contentEditable` from `SlideEditor.tsx`). They piggyback on
 * `@tiptap/extension-text-style` so every styling command can be applied
 * to a selection without nesting raw `<span>` elements by hand.
 *
 * Rendering on the projection window: the output renderer's
 * `sanitizeSlideHtml` allowlist permits `font-size`, `font-family`,
 * `font-weight`, `font-style`, `text-align`, `text-decoration`,
 * `color`, `line-height`, and `letter-spacing` on inline `style`
 * attributes — so anything these extensions emit survives sanitization
 * untouched.
 *
 * Phase 2 (P2.2) — this file also owns the ProseMirror JSON <-> HTML
 * bridge. `migrateJson` converts legacy HTML-string content into a
 * ProseMirror JSON doc on first load; `renderDocToHtml` hydrates the
 * JSON doc to an HTML string for `CustomSlideRenderer` (memoized by
 * the serialized JSON). Both call into `@tiptap/html`'s
 * `generateJSON` / `generateHTML` so the editor schema and the
 * renderer agree on shape.
 */

import { Extension } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";
import "@tiptap/extension-text-style";
import { generateHTML, generateJSON } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";

import type { ProseMirrorJSON } from "../../../types";
import { sanitizeSlideHtml } from "../../../utils/sanitize";
import { ptSizeToCalc, ptStylesToScale } from "./textStyleSystem";

type StoredStyle = { font?: string; fontSize?: string; lineHeight?: string };

/**
 * Apply `style="font-family: <font>"` to the current text selection.
 * Wraps the styled range in a `<span>` (Tiptap's TextStyle extension
 * normalizes span nesting so repeated applications do not accumulate
 * cruft the way the old manual `Range.extractContents` approach did).
 */
export const FontFamilyInline = Extension.create({
  name: "fontFamilyInline",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          font: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.fontFamily || null,
            renderHTML: (attrs: StoredStyle) =>
              attrs.font ? { style: `font-family: ${attrs.font}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontFamily:
        (font: string) =>
        ({ chain }: CommandProps) =>
          chain().setMark("textStyle", { font } as any).run(),
      unsetFontFamily:
        () =>
        ({ chain }: CommandProps) =>
          chain().setMark("textStyle", { font: null } as any).removeEmptyTextStyle().run(),
    } as any;
  },
});

/**
 * Apply `style="font-size: <size>pt"` to the current text selection.
 * Sizes are entered in points because the slide model uses pt throughout.
 * The rendered size is wrapped in `calc(<n>pt * var(--slide-scale))` so
 * per-word marks inherit the element container's scale factor
 * (`--slide-scale` is set by the renderer and the inline editor), instead
 * of escaping it and overflowing the box at any `scale !== 1`.
 */
export const FontSizeInline = Extension.create({
  name: "fontSizeInline",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            // Round-trip safe: emitted marks are `calc(Npt * var(--slide-scale))`,
            // so when HTML is re-parsed (copy/paste, legacy escape hatch) we
            // recover the authored pt value instead of storing the calc string.
            parseHTML: (el) => {
              const raw = (el as HTMLElement).style.fontSize;
              if (!raw) return null;
              const m = raw.match(/^calc\(\s*([0-9]+(?:\.[0-9]+)?)pt\s*\*/);
              return m ? `${m[1]}pt` : raw;
            },
            renderHTML: (attrs: StoredStyle) =>
              attrs.fontSize ? { style: `font-size: ${ptSizeToCalc(attrs.fontSize)}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (size: string | number) =>
        ({ chain }: CommandProps) =>
          chain()
            .setMark("textStyle", { fontSize: typeof size === "number" ? `${size}pt` : size } as any)
            .run(),
      unsetFontSize:
        () =>
        ({ chain }: CommandProps) =>
          chain().setMark("textStyle", { fontSize: null } as any).removeEmptyTextStyle().run(),
    } as any;
  },
});

/**
 * Apply `style="line-height: <value>"` to the current text selection.
 * Optional convenience; the slide-level `inline-style` already controls
 * line-height, but per-selection overrides are useful for list captions.
 */
export const LineHeightInline = Extension.create({
  name: "lineHeightInline",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.lineHeight || null,
            renderHTML: (attrs: StoredStyle) =>
              attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (value: string | number) =>
        ({ chain }: CommandProps) =>
          chain()
            .setMark("textStyle", { lineHeight: typeof value === "number" ? String(value) : value } as any)
            .run(),
      unsetLineHeight:
        () =>
        ({ chain }: CommandProps) =>
          chain().setMark("textStyle", { lineHeight: null } as any).removeEmptyTextStyle().run(),
    } as any;
  },
});

/**
 * P4.3 — named paragraph styles. Adds a `data-style` attribute to
 * paragraph nodes carrying the resolved inline CSS for a theme-defined
 * style ("Body", "Quote", "Header", …). The editor dropdown applies the
 * recipe by writing the CSS string into the paragraph's node attrs; the
 * output renderer (via `generateHTML` + `sanitizeSlideHtml`) emits those
 * attrs back as `style` on the `<p>` — no render-time lookup needed.
 *
 * The stored `data-style` blob stays byte-identical to the recipe's
 * authored CSS (absolute pt) so `findParagraphStyle` can match it; only
 * the *emitted* `style` has its `font-size: Npt` wrapped in the
 * `--slide-scale` calc so recipe paragraphs scale with the element like
 * per-word marks do.
 */
export const ParagraphStyleInline = Extension.create({
  name: "paragraphStyleInline",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          dataStyle: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).getAttribute("data-style") || null,
            renderHTML: (attrs: any) =>
              attrs.dataStyle
                ? { "data-style": attrs.dataStyle, style: ptStylesToScale(attrs.dataStyle) }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setParagraphStyle:
        (css: string | null) =>
        ({ chain, state }: CommandProps) => {
          if (css === null) {
            return chain().updateAttributes("paragraph", { dataStyle: null }).run();
          }
          // Apply to every paragraph in the current selection so a multi-
          // paragraph element styles uniformly.
          const { from, to } = state.selection;
          let tr = state.tr;
          const nodes: { pos: number; node: any }[] = [];
          state.doc.nodesBetween(from, to, (node: any, pos: number) => {
            if (node.type.name === "paragraph" || node.type.name === "heading") {
              nodes.push({ pos, node });
            }
          });
          // Run in reverse so earlier positions stay valid after each set.
          nodes.reverse().forEach(({ pos, node }) => {
            tr = tr.setNodeMarkup(pos, null, { ...node.attrs, dataStyle: css });
          });
          if (tr.docChanged) return chain().run();
          return chain().updateAttributes("paragraph", { dataStyle: css }).run();
        },
    } as any;
  },
});
/**
 * Shared extension array reused by both the inline editor instance, the
 * migration code (`migrateJson`), and the output renderer's
 * `renderDocToHtml()` call. Keeping this raw array avoids cross-phase drift
 * when the editor and renderer must agree on the schema.
 */
export const SLIDE_TEXT_EXTENSIONS = [
  StarterKit.configure({ undoRedo: false }),
  Underline,
  TextStyle,
  Color,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  FontFamilyInline,
  FontSizeInline,
  LineHeightInline,
  ParagraphStyleInline,
] as const;

/**
 * Module-level memoization cache for `renderDocToHtml`. Keyed by the
 * canonical JSON serialization of the doc; bounded so a long editing
 * session does not leak indefinitely. The cache is small (slide text
 * blobs are tiny) — a single key rarely moves us above a few KB.
 */
const DOC_HTML_CACHE = new Map<string, string>();
const DOC_HTML_CACHE_MAX = 256;

/**
 * Render a ProseMirror JSON doc (Tiptap `getJSON()`) to an HTML string
 * suitable for the projection window. Output is passed through
 * `sanitizeSlideHtml` so the XSS allowlist still applies even though
 * generateHTML itself is schema-bounded (defence-in-depth; some legacy
 * editor tooling may write inline styles we still want trimmed).
 *
 * Pure: same input → same output. Callers may memoize further.
 */
export function renderDocToHtml(doc: ProseMirrorJSON): string {
  const key = JSON.stringify(doc);
  const cached = DOC_HTML_CACHE.get(key);
  if (cached !== undefined) return cached;

  // `generateHTML` expects an Extensions array and a JSON doc; both
  // shapes are exported by `@tiptap/html`. We cast the readonly tuple
  // to a plain array since the runtime accepts any `Extension[]`.
  let html: string;
  try {
    html = generateHTML(doc as any, SLIDE_TEXT_EXTENSIONS as unknown as any[]);
  } catch (err) {
    console.warn("[slideContent] generateHTML failed; falling back to empty doc", err);
    html = "<p></p>";
  }
  const safe = sanitizeSlideHtml(html);
  if (DOC_HTML_CACHE.size >= DOC_HTML_CACHE_MAX) {
    // Evict oldest entry (insertion-order is preserved by Map).
    const firstKey = DOC_HTML_CACHE.keys().next().value;
    if (firstKey !== undefined) DOC_HTML_CACHE.delete(firstKey);
  }
  DOC_HTML_CACHE.set(key, safe);
  return safe;
}

/**
 * Convert a legacy HTML-string `TextElement.content` into a ProseMirror
 * JSON doc. Pass-through if the content is already an object (a JSON
 * doc) — this lets `migratePresentation` call it unconditionally.
 *
 * Empty / whitespace content normalizes to `{ type: "doc", content: [{ type: "paragraph" }] }`
 * so the InlineTextEditor's `setContent` doesn't choke on empty strings.
 */
export function migrateHtmlContentToJSON(content: ProseMirrorJSON | string): ProseMirrorJSON {
  if (content && typeof content === "object") return content;
  const html = typeof content === "string" ? content : "";
  if (!html || !html.trim()) {
    return { type: "doc", content: [{ type: "paragraph" }] } as ProseMirrorJSON;
  }
  try {
    return generateJSON(html, SLIDE_TEXT_EXTENSIONS as unknown as any[]) as unknown as ProseMirrorJSON;
  } catch (err) {
    console.warn("[slideContent] generateJSON failed; emitting a verbatim text paragraph", err);
    // Fall back to wrapping the raw text in a paragraph so we don't lose
    // content the way `generateJSON` would if it choked on an odd tag.
    const text = html.replace(/<[^>]+>/g, "");
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as ProseMirrorJSON;
  }
}

/**
 * A typed predicate for "is this content a JSON doc object already?"
 * Cheap helper so callers don't sprinkle `typeof content === "string"`.
 */
export function isJsonContent(content: unknown): content is ProseMirrorJSON {  return !!content && typeof content === "object" && Array.isArray((content as any).content);
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphStyleInline: {
      /** P4.3 — apply a named paragraph style by writing its resolved
       *  inline CSS into the paragraph node's `data-style` attr. Pass
       *  `null` to clear the style. Styles every paragraph in the
       *  current selection so multi-paragraph elements style uniformly. */
      setParagraphStyle: (css: string | null) => ReturnType;
    };
  }
}