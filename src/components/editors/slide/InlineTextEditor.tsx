/**
 * Tiptap-based inline text editor for slide canvas.
 *
 * Phase 1.1 of the slide-modernization plan. Replaces the hand-rolled
 * `contentEditable` + manual `Range`/`<span>` editor that previously
 * lived inline inside `SlideEditor.tsx`. Tiptap gives us:
 *
 *   - In-editor undo (StarterKit's History, not the slide-history stack)
 *   - Selection-preserving per-word styling (B/I/U/color/size/family)
 *   - Semantic HTML output instead of nested `<span style>` cruft
 *   - Headers, paragraphs, lists for free
 *   - XSS-safe content model (combined with `sanitizeSlideHtml` on output)
 *
 * Commit model: the editor maintains its own ProseMirror state. On blur
 * we hand the parent `editor.getHTML()`, which the parent writes into
 * `TextElement.content`. The parent's slide-history commits one
 * snapshot per *editing session*, not per keystroke (P1.6 coalescing
 * allows multiple consecutive text-edit commits on the same element to
 * fold into one entry).
 *
 * The component is "inline": it renders an absolutely-positioned
 * `contentEditable` occupying the element's full box, exactly matching
 * the renderer's geometry. Both share the same font/size/colour via
 * CSS (so what you see is what the audience gets).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle as TipTapTextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import {
  Bold, Italic, Underline as UnderlineIcon,
  AlignLeft, AlignCenter, AlignRight,
  Type, AArrowUp, AArrowDown, Pilcrow,
} from "lucide-react";

import type { TextElement, ProseMirrorJSON, SlideTheme, TextStyle as TextStyleType } from "../../../types";
import { useFonts } from "../../../hooks/useFonts";
import {
  FontSizeInline,
  FontFamilyInline,
  LineHeightInline,
  ParagraphStyleInline,
} from "./slideTextExtensions";

interface InlineTextEditorProps {
  el: TextElement;
  canvasScale: number;
  /** Optional cascade theme (P4.3) for the paragraph-style dropdown. */
  theme?: SlideTheme;
  /** Called with `editor.getJSON()` when the user finishes editing (blur/Esc). */
  onCommit: (doc: ProseMirrorJSON) => void;
}

const TOOLBAR_BTNS: { cmd: string; title: string; icon: React.ReactNode }[] = [
  { cmd: "bold", title: "Bold (Ctrl+B)", icon: <Bold size={13} /> },
  { cmd: "italic", title: "Italic (Ctrl+I)", icon: <Italic size={13} /> },
  { cmd: "underline", title: "Underline (Ctrl+U)", icon: <UnderlineIcon size={13} /> },
];

const ALIGN_BTNS: { cmd: string; title: string; icon: React.ReactNode }[] = [
  { cmd: "left", title: "Align left", icon: <AlignLeft size={13} /> },
  { cmd: "center", title: "Align center", icon: <AlignCenter size={13} /> },
  { cmd: "right", title: "Align right", icon: <AlignRight size={13} /> },
];

/** P4.3 — resolve a theme-defined paragraph style recipe to an inline CSS
 *  string the paragraph node stores (font, size, color, italic, indent). */
export function paragraphStyleCss(
  name: string,
  recipe: Partial<TextStyleType> & { indent?: string },
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

export function InlineTextEditor({ el, canvasScale, theme, onCommit }: InlineTextEditorProps) {
  // P2.5: user-installed @font-face families merged with built-ins.
  const { availableFonts } = useFonts();
  const committedRef = useRef(false);
  // `onCommit` is rebuilt on every parent render (SlideCanvas constructs
  // `html => onCommit(el.id, html)` inline in its `.map` body). Keeping it
  // in the commit-cleanup effect's deps would re-run that cleanup on any
  // re-render while editing — e.g. the overlay's `onClick` calling
  // `setActiveElementIds` after a drag-select. The cleanup would then
  // commit, `commitInline` clears `editingElementId`, and the editor
  // unmounts mid-edit (seen as "the editor loses focus the moment I try
  // to highlight a word"). So we capture the latest `onCommit` in a ref
  // and key the cleanup effect on `[editor]` only.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // We enable in-editor undo history here (Tiptap 3.x renamed
        // the option from `history` to `undoRedo`). Slide-level undo/redo
        // is still handled by the parent `useSlideHistory` and triggered
        // on commit (blur); this lets Ctrl+Z inside the editor revert
        // within the element without affecting slide history.
        undoRedo: { depth: 200, newGroupDelay: 600 },
      }),
      Underline,
      TipTapTextStyle,
      Color,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      FontFamilyInline,
      FontSizeInline,
      LineHeightInline,
      ParagraphStyleInline,
    ],
    // P2.2: content is now a ProseMirror JSON doc (Tiptap's
    // `useEditor` `content` accepts both an HTML string and a JSON
    // object, so the legacy HTML-string escape hatch continues to
    // work while `migratePresentation` upgrades older decks).
    content: (el.content ?? "") as any,
    editorProps: {
      // Stop ALL keydown events from bubbling up — the slide editor's
      // global shortcut listener would otherwise intercept Space, Delete,
      // Backspace, Ctrl+Z, etc.
      handleDOMEvents: {
        keydown: (_view, event) => {
          event.stopPropagation();
          // Return false so ProseMirror still processes the key normally.
          return false;
        },
        keyup: (_view, event) => {
          event.stopPropagation();
          return false;
        },
      },
      attributes: {
        class: "tiptap-inline-editor prose prose-invert focus:outline-none max-w-none h-full select-text",
      },
    },
  });

  // Cleanup commits the latest content exactly once on unmount. Without
  // this, the slide swaps the editor out on blur BEFORE the editor has
  // serialised its state — committing on `onBlur` is racy because React
  // already tears down the editor instance by then.
  useEffect(() => {
    return () => {
      if (committedRef.current || !editor) return;
      committedRef.current = true;
      onCommitRef.current(editor.getJSON() as unknown as ProseMirrorJSON);
    };
  }, [editor]);

  // Migrate whole-element bold/italic (legacy box-level `el.bold`/`el.italic`)
  // into actual Tiptap marks on the whole document once, when editing begins.
  // We used to render `fontWeight: el.bold ? "bold" : "normal"` as box CSS on
  // the editor (and the renderer still does). That FORCES every word bold, so
  // `<strong>` marks become redundant and `toggleBold` on a bold-looking word
  // actually *adds* a mark (because at the mark level the word isn't bold) —
  // making it impossible to UN-bold a single word. Seeding the mark across the
  // whole doc (and dropping the box-CSS force below + clearing `el.bold` on
  // commit) lets per-word `toggleBold`/`toggleItalic` add AND remove.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!editor || seededRef.current) return;
    seededRef.current = true;
    const end = editor.state.doc.content.size;
    const tr = editor.state.tr;
    let changed = false;
    const schema = editor.schema as any;
    if (el.bold && schema.marks.bold) { tr.addMark(0, end, schema.marks.bold.create()); changed = true; }
    if (el.italic && schema.marks.italic) { tr.addMark(0, end, schema.marks.italic.create()); changed = true; }
    if (changed) editor.view.dispatch(tr);
  }, [editor, el]);

  // Focus + caret-to-end on mount.
  useEffect(() => {
    if (!editor) return;
    editor.commands.focus("end");
  }, [editor]);

  if (!editor) return null;

  const justifyContent =
    el.v_align === "middle" ? "center" :
    el.v_align === "bottom" ? "flex-end" : "flex-start";

  const commitNow = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(editor.getJSON() as unknown as ProseMirrorJSON);
  };

  // Apply per-selection font-size delta: `delta` in points.
  const bumpFontSize = (delta: number) => {
    // Start from the *current* font size of the selection — an already-
    // styled word keeps its size, and plain text falls back to the
    // element's default. Previously we always based the step on
    // `el.font_size`, so selecting a word and pressing A+/A- was "stuck"
    // at the element default (re-applying the same absolute size every
    // press) instead of stepping the selected text.
    const selSize = (editor.getAttributes("textStyle") as any)?.fontSize;
    let base = typeof el.font_size === "number" ? el.font_size : 32;
    if (typeof selSize === "string" && selSize.trim().endsWith("pt")) {
      const parsed = parseFloat(selSize);
      if (!Number.isNaN(parsed)) base = parsed;
    }
    const next = Math.max(8, Math.round(base + delta));
    editor.chain().focus().setFontSize(`${next}pt`).run();
  };

  // P4.3 — current paragraph style, resolved by comparing the paragraph
  // node's stored `data-style` CSS against each theme recipe. The recipe
  // wins when the CSS strings match, so selecting the same style again
  // leaves the node untouched.
  const currentStyleName = useMemo(() => {
    const css = (editor.getAttributes("paragraph") as any)?.dataStyle ?? null;
    if (!css) return "";
    for (const [name, recipe] of Object.entries(theme?.paragraphStyles ?? {})) {
      if (paragraphStyleCss(name, recipe, theme) === css) return name;
    }
    return "";
  }, [editor, theme]);

  const applyParagraphStyle = (name: string) => {
    if (!name) {
      editor.chain().focus().setParagraphStyle(null).run();
      return;
    }
    const recipe = theme?.paragraphStyles?.[name];
    if (!recipe) return;
    editor.chain().focus().setParagraphStyle(paragraphStyleCss(name, recipe, theme)).run();
  };

  // Change the case of the current text selection. `insertText` replaces the
  // selection and inherits the surrounding marks, so a bold selection stays
  // bold after re-casing. No-op when the selection is collapsed.
  const [caseMode, setCaseMode] = useState("");
  const applyCase = (mode: "upper" | "lower" | "title") => {
    const { state, view } = editor;
    const { from, to } = state.selection;
    if (from === to) return;
    const txt = state.doc.textBetween(from, to, " ");
    const out =
      mode === "upper" ? txt.toUpperCase() :
      mode === "lower" ? txt.toLowerCase() :
      txt.replace(/\b\w/g, (c) => c.toUpperCase());
    // Use the ProseMirror transaction directly: tr.insertText replaces the
    // [from,to) range with `out` and inherits the marks at `from`, so a bold
    // selection stays bold after re-casing.
    const tr = state.tr.insertText(out, from, to);
    view.dispatch(tr.setMeta("addToHistory", true));
  };

  return (
    <div
      className="absolute inset-0 outline-none ring-2 ring-state-success/60 flex flex-col"
      style={{ justifyContent }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Floating toolbar — above the content, never stealing pointer events
          from the editor unless the user is interacting with a control. */}
      <div
        className="absolute top-1 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 bg-console-surface border border-console-border rounded-lg px-1 py-1 shadow-2xl shadow-black/80 backdrop-blur"
        // Mousedown handlers call preventDefault() so the editor doesn't
        // collapse its selection when the user mouses down on a toolbar
        // button. Pointer-down is also stopped so drag/resize doesn't
        // engage from the toolbar. Native `<select>` / `<input type=color>`
        // MUST keep their default behavior or their dropdowns won't open —
        // so we only preventDefault for the editable text content, never
        // for the form controls.
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("select, input[type=color]")) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("select, input[type=color]")) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        style={{ pointerEvents: "auto" }}
      >
        {TOOLBAR_BTNS.map((b) => (
          <ToolbarButton
            key={b.cmd}
            title={b.title}
            active={editor.isActive(b.cmd)}
            onClick={() => editor.chain().focus().toggleMark(b.cmd).run()}
          >
            {b.icon}
          </ToolbarButton>
        ))}
        <ToolbarDivider />
        <label
          className="flex items-center gap-1 px-1 cursor-pointer"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Type size={11} className="text-console-text-muted" />
          <select
            value={editor.getAttributes("textStyle")?.font || el.font_family || "Arial"}
            onChange={(e) => editor.chain().focus().setFontFamily(e.target.value).run()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-console-surface-raised border border-console-border rounded px-1 py-0.5 text-[10px] text-console-text outline-none max-w-[110px]"
          >
            {availableFonts.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <ToolbarDivider />
        <ToolbarButton title="Smaller (Alt+A⁻)" onClick={() => bumpFontSize(-4)}>
          <AArrowDown size={13} />
        </ToolbarButton>
        <span className="text-[10px] text-console-text-muted tabular-nums w-7 text-center">
          {(() => {
            const selSize = (editor.getAttributes("textStyle") as any)?.fontSize;
            if (typeof selSize === "string" && selSize.trim().endsWith("pt")) {
              const parsed = parseFloat(selSize);
              if (!Number.isNaN(parsed)) return Math.round(parsed);
            }
            return String(el.font_size ?? 32);
          })()}
        </span>
        <ToolbarButton title="Larger (Alt+A⁺)" onClick={() => bumpFontSize(4)}>
          <AArrowUp size={13} />
        </ToolbarButton>
        <ToolbarDivider />
        <label
          className="flex items-center cursor-pointer"
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            type="color"
            value={(editor.getAttributes("textStyle") as any)?.color || el.color || "#ffffff"}
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
            title="Text Color"
          />
        </label>
        <ToolbarDivider />
        {ALIGN_BTNS.map((b) => (
          <ToolbarButton
            key={b.cmd}
            title={b.title}
            active={editor.isActive({ textAlign: b.cmd })}
            onClick={() => editor.chain().focus().setTextAlign(b.cmd).run()}
          >
            {b.icon}
          </ToolbarButton>
        ))}
        <ToolbarDivider />
        <label
          className="flex items-center gap-1 px-1 cursor-pointer"
          onMouseDown={(e) => e.stopPropagation()}
          title="Paragraph style"
        >
          <Pilcrow size={11} className="text-console-text-muted" />
          <select
            value={currentStyleName}
            onChange={(e) => applyParagraphStyle(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-console-surface-raised border border-console-border rounded px-1 py-0.5 text-[10px] text-console-text outline-none max-w-[100px]"
          >
            <option value="">Plain</option>
            {(theme?.paragraphStyles ? Object.keys(theme.paragraphStyles) : []).map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <ToolbarDivider />
        <label
          className="flex items-center cursor-pointer"
          title="Change case"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <select
            value={caseMode}
            onChange={(e) => {
              const m = e.target.value as "upper" | "lower" | "title" | "";
              setCaseMode("");
              if (m) applyCase(m);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-console-surface-raised border border-console-border rounded px-1 py-0.5 text-[10px] text-console-text outline-none"
          >
            <option value="">Aa</option>
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="title">Title Case</option>
          </select>
        </label>
      </div>

      {/* The actual editor body fills the element's box exactly so its
          geometry matches the renderer. We render with the same
          fontFamily/fontSize/colour defaults the element would render
          with so the operator sees roughly what the audience will. */}
      <div className="flex-1 flex flex-col overflow-hidden" style={{ justifyContent }}>
        <EditorContent
          editor={editor}
          style={{
            fontFamily: typeof el.font_family === "string" ? el.font_family : "Arial",
            fontSize: `${(typeof el.font_size === "number" ? el.font_size : 32) * canvasScale}pt`,
            color: typeof el.color === "string" ? el.color : "#ffffff",
            // NOTE: bold/italic are no longer forced here — they are
            // represented as Tiptap marks (see the seeding effect above) so
            // per-word toggleBold/toggleItalic can add AND remove them.
            textAlign: (el.align ?? "center") as React.CSSProperties["textAlign"],
            lineHeight: 1.3,
            width: "100%",
            // Keep the text shadow visible so the editor matches the
            // projection window's drop-shadow look.
            textShadow: el.shadow === false ? "none" : `0 2px 8px ${el.shadow_color || "rgba(0,0,0,0.6)"}`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            cursor: "text",
          }}
        />
      </div>

      {/* Hidden sentinel that captures blur events when the user clicks
          outside the editor box. Committing on blur alone is insufficient
          because clicking the toolbar collapses the editor's selection
          (which is why every toolbar handler calls preventDefault); the
          parent's `editingElementId` is cleared on user click outside,
          unmounting this component and committing via the cleanup effect
          above. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute -bottom-2 -right-2 w-4 h-4 opacity-0"
        onFocus={commitNow}
      />
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.preventDefault(); onClick(); }}
      className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all text-console-text hover:text-console-text ${
        active ? "bg-state-success/30 text-console-text" : "bg-console-surface-raised hover:bg-console-surface-strong"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-console-border mx-0.5 shrink-0" />;
}