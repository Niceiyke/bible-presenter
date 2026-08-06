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

import React, { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import FontFamily from "@tiptap/extension-font-family";
import {
  Bold, Italic, Underline as UnderlineIcon,
  AlignLeft, AlignCenter, AlignRight,
  Type, AArrowUp, AArrowDown,
} from "lucide-react";

import type { TextElement } from "../../../types";
import { FONTS } from "../../../types";
import {
  FontSizeInline,
  FontFamilyInline,
  LineHeightInline,
} from "./slideTextExtensions";

interface InlineTextEditorProps {
  el: TextElement;
  canvasScale: number;
  /** Called with `editor.getHTML()` when the user finishes editing (blur/Esc). */
  onCommit: (html: string) => void;
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

export function InlineTextEditor({ el, canvasScale, onCommit }: InlineTextEditorProps) {
  const committedRef = useRef(false);

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
      TextStyle,
      Color,
      FontFamily,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      FontFamilyInline,
      FontSizeInline,
      LineHeightInline,
    ],
    content: el.content || "",
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
        class: "tiptap-inline-editor prose prose-invert focus:outline-none max-w-none h-full",
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
      onCommit(editor.getHTML());
    };
  }, [editor, onCommit]);

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
    onCommit(editor.getHTML());
  };

  // Apply per-selection font-size delta: `delta` in points.
  const bumpFontSize = (delta: number) => {
    // Tiptap's setFontSize takes an absolute pt value. We start from the
    // element's default font_size and add the delta, so each press is a
    // predictable step (±4pt) rather than reading whatever inline span
    // the cursor is currently on.
    const base = el.font_size ?? 32;
    const next = Math.max(8, base + delta);
    editor.chain().focus().setFontSize(`${next}pt`).run();
  };

  return (
    <div
      className="absolute inset-0 outline-none overflow-hidden ring-2 ring-emerald-400/60 flex flex-col"
      style={{ justifyContent }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {/* Floating toolbar — above the content, never stealing pointer events
          from the editor unless the user is interacting with a control. */}
      <div
        className="absolute top-1 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 bg-[#1a1a2e]/95 border border-white/15 rounded-lg px-1 py-1 shadow-2xl shadow-black/80 backdrop-blur"
        // Mousedown handlers call preventDefault() so the editor doesn't
        // collapse its selection when the user mouses down on a toolbar
        // button. Pointer-down is also stopped so drag/resize doesn't
        // engage from the toolbar.
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
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
          onMouseDown={(e) => e.preventDefault()}
        >
          <Type size={11} className="text-slate-400" />
          <select
            value={editor.getAttributes("textStyle")?.font || el.font_family || "Arial"}
            onChange={(e) => editor.chain().focus().setFontFamily(e.target.value).run()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-white/8 border border-white/10 rounded px-1 py-0.5 text-[10px] text-slate-200 outline-none max-w-[110px]"
          >
            {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <ToolbarDivider />
        <ToolbarButton title="Smaller (Alt+A⁻)" onClick={() => bumpFontSize(-4)}>
          <AArrowDown size={13} />
        </ToolbarButton>
        <span className="text-[10px] text-slate-500 tabular-nums w-7 text-center">
          {String(el.font_size ?? 32)}
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
            className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
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
      </div>

      {/* The actual editor body fills the element's box exactly so its
          geometry matches the renderer. We render with the same
          fontFamily/fontSize/colour defaults the element would render
          with so the operator sees roughly what the audience will. */}
      <div className="flex-1 flex flex-col" style={{ justifyContent }}>
        <EditorContent
          editor={editor}
          style={{
            fontFamily: el.font_family ?? "Arial",
            fontSize: `${(el.font_size ?? 32) * canvasScale}pt`,
            color: el.color ?? "#ffffff",
            fontWeight: el.bold ? "bold" : "normal",
            fontStyle: el.italic ? "italic" : "normal",
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
      className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all text-slate-300 hover:text-white ${
        active ? "bg-emerald-500/30 text-white" : "bg-white/8 hover:bg-white/16"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />;
}