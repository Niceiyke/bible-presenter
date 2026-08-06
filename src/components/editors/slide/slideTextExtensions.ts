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
 */

import { Extension } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";
import "@tiptap/extension-text-style";

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
            parseHTML: (el) => (el as HTMLElement).style.fontSize || null,
            renderHTML: (attrs: StoredStyle) =>
              attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
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
 * Shared extension array reused by both the inline editor instance and
 * (when Phase 2 swaps content to ProseMirror JSON) the output renderer's
 * `generateHTML()` call. Keeping this raw array avoids cross-phase drift
 * when the editor and renderer must agree on the schema.
 */
export const SLIDE_TEXT_EXTENSIONS = [
  FontFamilyInline,
  FontSizeInline,
  LineHeightInline,
] as const;