import React, { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Trash2, Save, X, ChevronLeft, ChevronRight,
  Type, Image as ImageIcon, Copy, Square,
  Undo2, Redo2, AlignCenter, AlignLeft, AlignRight,
  ArrowUp, ArrowDown, MoveUp, MoveDown,
  BookOpen, Lock, Unlock,
} from "lucide-react";
import { CustomSlideRenderer } from "../shared/Renderers";
import { MediaPickerModal } from "../MediaPickerModal";
import { BiblePickerModal } from "../BiblePickerModal";
import { newDefaultSlide, newTitleSlide, newBlankSlide, stableId, relativizePath } from "../../utils";
import { useAppStore } from "../../store";
import type { CustomPresentation, CustomSlide, MediaItem, SlideElement } from "../../types";
import { FONTS } from "../../types";

// ─── Inline Text Editor ───────────────────────────────────────────────────────
// Renders directly on the canvas. stopPropagation fixes spacebar & all key input.
function InlineTextEditor({
  el,
  canvasScale,
  onCommit,
}: {
  el: SlideElement;
  canvasScale: number;
  onCommit: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const div = ref.current;
    if (!div) return;
    // Set HTML once on mount only (avoid React overwriting cursor position)
    div.innerHTML = el.content || "";
    div.focus();
    // Move cursor to end
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []); // intentionally empty – only run once

  const justifyContent =
    el.v_align === "middle" ? "center" :
    el.v_align === "bottom" ? "flex-end" : "flex-start";

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={() => { if (ref.current) onCommit(ref.current.innerHTML); }}
      onKeyDown={(e) => {
        // Critical: stop ALL keys from reaching global shortcut handlers
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          if (ref.current) onCommit(ref.current.innerHTML);
        }
      }}
      className="absolute inset-0 outline-none overflow-hidden ring-2 ring-emerald-400/60"
      style={{
        fontFamily: el.font_family || "inherit",
        fontSize: `${(el.font_size || 32) * canvasScale}px`,
        color: el.color || "#ffffff",
        fontWeight: el.bold ? "bold" : "normal",
        fontStyle: el.italic ? "italic" : "normal",
        textAlign: (el.align || "center") as React.CSSProperties["textAlign"],
        display: "flex",
        flexDirection: "column",
        justifyContent,
        padding: "2px 4px",
        lineHeight: 1.25,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        cursor: "text",
        textShadow:
          el.shadow !== false
            ? `2px 2px 6px ${el.shadow_color || "#000"}`
            : "none",
      }}
    />
  );
}

// ─── Presentation migrator ────────────────────────────────────────────────────
function migratePresentation(p: CustomPresentation): CustomPresentation {
  if (p.version && p.version >= 1) return p;
  return {
    ...p, version: 1,
    slides: p.slides.map(s => {
      if (!s.elements || s.elements.length === 0) {
        const elements: SlideElement[] = [];
        if (s.headerEnabled !== false && s.header) {
          elements.push({ id: stableId(), kind: "text", x: 10, y: 10, w: 80, h: s.headerHeightPct ?? 35, z_index: 1, content: s.header.text, font_size: s.header.fontSize, font_family: s.header.fontFamily, color: s.header.color, bold: s.header.bold, italic: s.header.italic, align: s.header.align });
        }
        if (s.body) {
          elements.push({ id: stableId(), kind: "text", x: 10, y: (s.headerHeightPct ?? 35) + 15, w: 80, h: 40, z_index: 2, content: s.body.text, font_size: s.body.fontSize, font_family: s.body.fontFamily, color: s.body.color, bold: s.body.bold, italic: s.body.italic, align: s.body.align });
        }
        return { ...s, elements };
      }
      return s;
    }),
  };
}

// ─── Resize handle positions ─────────────────────────────────────────────────
const HANDLES: Record<string, React.CSSProperties> = {
  nw: { top: -5, left: -5, cursor: "nwse-resize" },
  n:  { top: -5, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" },
  ne: { top: -5, right: -5, cursor: "nesw-resize" },
  e:  { top: "50%", right: -5, transform: "translateY(-50%)", cursor: "ew-resize" },
  se: { bottom: -5, right: -5, cursor: "nwse-resize" },
  s:  { bottom: -5, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" },
  sw: { bottom: -5, left: -5, cursor: "nesw-resize" },
  w:  { top: "50%", left: -5, transform: "translateY(-50%)", cursor: "ew-resize" },
};

// ─── Main SlideEditor ────────────────────────────────────────────────────────
interface SlideEditorProps {
  initialPres: CustomPresentation;
  mediaImages: MediaItem[];
  onClose: (saved: boolean) => void;
}

export function SlideEditor({ initialPres, mediaImages, onClose }: SlideEditorProps) {
  const { appDataDir, stagedItem } = useAppStore();

  const init = () => migratePresentation(JSON.parse(JSON.stringify(initialPres)));
  const [pres, _setPres] = useState<CustomPresentation>(init);
  const [history, setHistory] = useState<CustomPresentation[]>([init()]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);

  const [showBgPicker, setShowBgPicker] = useState(false);
  const [showImgPicker, setShowImgPicker] = useState(false);
  const [showBiblePicker, setShowBiblePicker] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasScale, setCanvasScale] = useState(1);

  // ── Scale tracking ──────────────────────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      if (canvasRef.current) setCanvasScale(canvasRef.current.clientHeight / 1080);
    };
    update();
    window.addEventListener("resize", update);
    const t = setTimeout(update, 120);
    return () => { window.removeEventListener("resize", update); clearTimeout(t); };
  }, [pres.slides.length]);

  const slide = pres.slides[activeSlideIdx] ?? pres.slides[0];

  // ── History-aware setter ────────────────────────────────────────────────────
  const setPres = useCallback(
    (next: CustomPresentation | ((p: CustomPresentation) => CustomPresentation), save = true) => {
      _setPres(prev => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (save) {
          const hist = history.slice(0, historyIndex + 1);
          hist.push(JSON.parse(JSON.stringify(resolved)));
          if (hist.length > 50) hist.shift();
          setHistory(hist);
          setHistoryIndex(hist.length - 1);
        }
        return resolved;
      });
    },
    [history, historyIndex],
  );

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const idx = historyIndex - 1;
      _setPres(JSON.parse(JSON.stringify(history[idx])));
      setHistoryIndex(idx);
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const idx = historyIndex + 1;
      _setPres(JSON.parse(JSON.stringify(history[idx])));
      setHistoryIndex(idx);
    }
  }, [history, historyIndex]);

  // ── Global keyboard shortcuts ───────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const typing =
        tgt.tagName === "INPUT" ||
        tgt.tagName === "TEXTAREA" ||
        tgt.tagName === "SELECT" ||
        tgt.contentEditable === "true";

      if (typing) return; // never intercept while user types

      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault(); e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault(); redo();
      } else if (e.key === "Escape") {
        setActiveElementId(null); setEditingElementId(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (activeElementId) deleteElement(activeElementId);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        e.preventDefault();
        if (activeElementId) {
          const el = slide.elements.find(x => x.id === activeElementId);
          if (el) duplicateElement(el);
        }
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [undo, redo, activeElementId, slide.elements]);

  // ── Slide/element helpers ───────────────────────────────────────────────────
  const updateSlide = (next: CustomSlide) =>
    setPres(prev => { const s = [...prev.slides]; s[activeSlideIdx] = next; return { ...prev, slides: s }; });

  const updateElement = (id: string, updates: Partial<SlideElement>, save = true) =>
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => e.id === id ? { ...e, ...updates } : e) };
      return { ...prev, slides: ns };
    }, save);

  const deleteElement = (id: string) => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.filter(e => e.id !== id) };
      return { ...prev, slides: ns };
    });
    if (activeElementId === id) setActiveElementId(null);
  };

  const duplicateElement = (el: SlideElement) => {
    const n = { ...el, id: stableId(), x: el.x + 3, y: el.y + 3, z_index: slide.elements.length + 1 };
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, n] };
      return { ...prev, slides: ns };
    });
    setActiveElementId(n.id);
  };

  const addEl = (el: SlideElement) => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, el] };
      return { ...prev, slides: ns };
    });
    setActiveElementId(el.id);
  };

  const addTextElement = () => addEl({
    id: stableId(), kind: "text", x: 20, y: 35, w: 60, h: 30,
    z_index: slide.elements.length + 1,
    content: "Double-click to edit", font_size: 48, font_family: "Arial",
    color: "#ffffff", align: "center", v_align: "middle",
    bold: false, italic: false, shadow: true, shadow_color: "#000000",
  });

  const addShapeElement = () => addEl({
    id: stableId(), kind: "shape", x: 25, y: 25, w: 50, h: 50,
    z_index: slide.elements.length + 1, content: "", color: "#6366f1", opacity: 0.85,
  });

  const handleAddSlide = (type: "default" | "title" | "blank") => {
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0,
        type === "title" ? newTitleSlide() : type === "blank" ? newBlankSlide() : newDefaultSlide());
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementId(null);
  };

  const handleDuplicateSlide = () => {
    setPres(prev => {
      const ns = [...prev.slides];
      const copy: CustomSlide = JSON.parse(JSON.stringify(ns[activeSlideIdx]));
      copy.id = stableId();
      copy.elements.forEach((e: SlideElement) => (e.id = stableId()));
      ns.splice(activeSlideIdx + 1, 0, copy);
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementId(null);
  };

  const handleDeleteSlide = () => {
    if (pres.slides.length <= 1) return;
    setPres(prev => ({ ...prev, slides: prev.slides.filter((_, i) => i !== activeSlideIdx) }));
    setActiveSlideIdx(i => Math.max(0, i - 1));
    setActiveElementId(null);
  };

  const alignElement = (type: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (!activeElementId) return;
    const el = slide.elements.find(e => e.id === activeElementId);
    if (!el) return;
    const u: Partial<SlideElement> = {};
    if (type === "left")   u.x = 0;
    if (type === "right")  u.x = 100 - el.w;
    if (type === "center") u.x = (100 - el.w) / 2;
    if (type === "top")    u.y = 0;
    if (type === "bottom") u.y = 100 - el.h;
    if (type === "middle") u.y = (100 - el.h) / 2;
    updateElement(activeElementId, u);
  };

  const updateZOrder = (dir: "forward" | "backward" | "front" | "back") => {
    if (!activeElementId) return;
    const els = [...slide.elements].sort((a, b) => a.z_index - b.z_index);
    const i = els.findIndex(e => e.id === activeElementId);
    if (i === -1) return;
    if (dir === "forward" && i < els.length - 1)
      [els[i].z_index, els[i + 1].z_index] = [els[i + 1].z_index, els[i].z_index];
    else if (dir === "backward" && i > 0)
      [els[i].z_index, els[i - 1].z_index] = [els[i - 1].z_index, els[i].z_index];
    else if (dir === "front")
      els[i].z_index = Math.max(...els.map(e => e.z_index)) + 1;
    else if (dir === "back")
      els[i].z_index = Math.min(...els.map(e => e.z_index)) - 1;
    updateSlide({ ...slide, elements: els });
  };

  // ── Drag & resize ───────────────────────────────────────────────────────────
  const handleDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0 || editingElementId === id) return;
    e.stopPropagation(); e.preventDefault();
    setActiveElementId(id);
    const el = slide.elements.find(x => x.id === id);
    if (!el || !canvasRef.current || el.locked) return;
    const sx = e.clientX, sy = e.clientY, ix = el.x, iy = el.y;
    const rect = canvasRef.current.getBoundingClientRect();
    let lx = ix, ly = iy;
    const move = (mv: PointerEvent) => {
      lx = ix + ((mv.clientX - sx) / rect.width) * 100;
      ly = iy + ((mv.clientY - sy) / rect.height) * 100;
      updateElement(id, { x: lx, y: ly }, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      updateElement(id, { x: lx, y: ly }, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleResize = (id: string, e: React.PointerEvent, h: string) => {
    e.stopPropagation(); e.preventDefault();
    const el = slide.elements.find(x => x.id === id);
    if (!el || !canvasRef.current || el.locked) return;
    const sx = e.clientX, sy = e.clientY;
    const { x: ix, y: iy, w: iw, h: ih } = el;
    const rect = canvasRef.current.getBoundingClientRect();
    let lx = ix, ly = iy, lw = iw, lh = ih;
    const move = (mv: PointerEvent) => {
      const dx = ((mv.clientX - sx) / rect.width) * 100;
      const dy = ((mv.clientY - sy) / rect.height) * 100;
      let nx = ix, ny = iy, nw = iw, nh = ih;
      if (h.includes("e")) nw = Math.max(5, iw + dx);
      if (h.includes("s")) nh = Math.max(5, ih + dy);
      if (h.includes("w")) { const d = Math.min(iw - 5, dx); nx = ix + d; nw = iw - d; }
      if (h.includes("n")) { const d = Math.min(ih - 5, dy); ny = iy + d; nh = ih - d; }
      lx = nx; ly = ny; lw = nw; lh = nh;
      updateElement(id, { x: nx, y: ny, w: nw, h: nh }, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      updateElement(id, { x: lx, y: ly, w: lw, h: lh }, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleDblClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const el = slide.elements.find(x => x.id === id);
    if (el?.kind === "text" && !el.locked) setEditingElementId(id);
  };

  const commitInline = (id: string, html: string) => {
    updateElement(id, { content: html });
    setEditingElementId(null);
  };

  const handleSave = async () => {
    try { await invoke("save_studio_presentation", { presentation: pres }); onClose(true); }
    catch (err) { console.error("Save failed", err); }
  };

  const activeEl = slide.elements.find(e => e.id === activeElementId);

  // Helper: add element or replace image src
  const handleImageSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    if (activeEl?.kind === "image") {
      updateElement(activeEl.id, { content: rel });
    } else {
      addEl({ id: stableId(), kind: "image", x: 20, y: 15, w: 60, h: 70, z_index: slide.elements.length + 1, content: rel });
    }
    setShowImgPicker(false);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[60] bg-[#0e0e1c] flex flex-col font-sans">

      {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-white/8 bg-[#131326] shrink-0">
        <button
          onClick={() => onClose(false)}
          className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all"
          title="Close without saving"
        >
          <X size={18} />
        </button>

        <div className="h-5 w-px bg-white/10" />

        {/* Presentation title */}
        <input
          value={pres.name}
          onChange={e => setPres({ ...pres, name: e.target.value })}
          onKeyDown={e => e.stopPropagation()}
          className="bg-transparent text-sm font-semibold text-white focus:outline-none min-w-0 flex-1"
          placeholder="Untitled Presentation"
        />

        {/* Slide counter */}
        <span className="text-[10px] font-bold text-slate-500 tabular-nums whitespace-nowrap bg-white/6 px-2 py-1 rounded">
          {activeSlideIdx + 1} / {pres.slides.length}
        </span>

        <div className="h-5 w-px bg-white/10" />

        {/* Undo / Redo */}
        <div className="flex bg-white/6 rounded-lg p-0.5 gap-0.5">
          <button onClick={undo} disabled={historyIndex === 0}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Undo (Ctrl+Z)">
            <Undo2 size={15} />
          </button>
          <button onClick={redo} disabled={historyIndex === history.length - 1}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Redo (Ctrl+Y)">
            <Redo2 size={15} />
          </button>
        </div>

        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black uppercase text-[11px] rounded-lg transition-all shadow-lg tracking-wide"
        >
          <Save size={14} /> Save
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">

        {/* ══ LEFT: SLIDE PANEL ════════════════════════════════════════════════ */}
        <aside className="w-48 border-r border-white/8 bg-[#131326] flex flex-col overflow-hidden shrink-0">
          <div className="px-3 py-2 border-b border-white/8 flex items-center justify-between shrink-0">
            <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">Slides</span>
            <span className="text-[8px] text-slate-700">{pres.slides.length}</span>
          </div>

          {/* Thumbnail list */}
          <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-2 custom-scrollbar">
            {pres.slides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => { setActiveSlideIdx(i); setActiveElementId(null); setEditingElementId(null); }}
                className={`relative aspect-video rounded-xl overflow-hidden border-2 transition-all shrink-0 group ${
                  i === activeSlideIdx
                    ? "border-indigo-500 shadow-lg shadow-indigo-500/20"
                    : "border-white/8 hover:border-white/20"
                }`}
              >
                <CustomSlideRenderer slide={s} scale={0.07} appDataDir={appDataDir} />
                <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded flex items-center justify-center text-[8px] font-black ${
                  i === activeSlideIdx ? "bg-indigo-500 text-white" : "bg-black/60 text-white/50"
                }`}>
                  {i + 1}
                </span>
              </button>
            ))}
          </div>

          {/* Add slide */}
          <div className="border-t border-white/8 p-2 flex gap-1 shrink-0">
            {(["Title", "Body", "Blank"] as const).map(t => (
              <button key={t}
                onClick={() => handleAddSlide(t.toLowerCase() as "title" | "default" | "blank")}
                className="flex-1 py-1.5 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-slate-300 text-[8px] font-bold rounded-lg transition-all"
              >
                +{t[0]}
              </button>
            ))}
          </div>
        </aside>

        {/* ══ CENTER: CANVAS ════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Context toolbar — changes based on selected element */}
          <div className="h-11 border-b border-white/8 flex items-center px-3 gap-1 bg-[#131326] shrink-0 overflow-x-auto">

            {/* ── No selection: Insert tools ── */}
            {!activeEl && <>
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-600 mr-1 shrink-0">Insert</span>
              <Btn onClick={addTextElement} icon={<Type size={13} />}>Text</Btn>
              <Btn onClick={() => setShowImgPicker(true)} icon={<ImageIcon size={13} />}>Image</Btn>
              <Btn onClick={addShapeElement} icon={<Square size={13} />}>Shape</Btn>
              <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />
              <Btn
                onClick={() => setShowBiblePicker(true)}
                icon={<BookOpen size={13} />}
                className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/20"
              >
                Bible
              </Btn>
              {stagedItem?.type === "Verse" && (
                <Btn
                  onClick={() => {
                    const v = stagedItem.data;
                    addEl({
                      id: stableId(), kind: "text", x: 10, y: 10, w: 80, h: 80,
                      z_index: slide.elements.length + 1,
                      content: `${v.text}\n— ${v.book} ${v.chapter}:${v.verse}`,
                      font_size: 40, font_family: "Georgia", color: "#ffffff",
                      align: "center", v_align: "middle", bold: false, italic: true,
                      shadow: true, shadow_color: "#000",
                    });
                  }}
                  icon={<BookOpen size={13} />}
                  className="text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20"
                >
                  Insert Verse
                </Btn>
              )}
            </>}

            {/* ── Text element selected ── */}
            {activeEl?.kind === "text" && <>
              {/* Font family */}
              <select
                value={activeEl.font_family}
                onChange={e => updateElement(activeEl.id, { font_family: e.target.value })}
                onKeyDown={e => e.stopPropagation()}
                className="bg-white/8 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-slate-300 outline-none max-w-[130px] shrink-0"
              >
                {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>

              {/* Font size stepper */}
              <div className="flex items-center bg-white/8 border border-white/10 rounded-lg shrink-0 overflow-hidden">
                <button onClick={() => updateElement(activeEl.id, { font_size: Math.max(8, (activeEl.font_size ?? 32) - 2) })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">−</button>
                <input
                  type="number"
                  value={activeEl.font_size ?? 32}
                  onChange={e => updateElement(activeEl.id, { font_size: Number(e.target.value) })}
                  onKeyDown={e => e.stopPropagation()}
                  className="w-10 bg-transparent py-1 text-xs text-white text-center outline-none tabular-nums"
                />
                <button onClick={() => updateElement(activeEl.id, { font_size: (activeEl.font_size ?? 32) + 2 })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">+</button>
              </div>

              <Div />

              {/* Bold, Italic */}
              <ToggleBtn active={!!activeEl.bold} onClick={() => updateElement(activeEl.id, { bold: !activeEl.bold })} title="Bold">
                <span className="font-black text-sm">B</span>
              </ToggleBtn>
              <ToggleBtn active={!!activeEl.italic} onClick={() => updateElement(activeEl.id, { italic: !activeEl.italic })} title="Italic">
                <span className="font-serif italic text-sm">I</span>
              </ToggleBtn>

              <Div />

              {/* H-Align */}
              <ToggleBtn active={activeEl.align === "left"} onClick={() => updateElement(activeEl.id, { align: "left" })} title="Align left"><AlignLeft size={14} /></ToggleBtn>
              <ToggleBtn active={activeEl.align === "center" || !activeEl.align} onClick={() => updateElement(activeEl.id, { align: "center" })} title="Center"><AlignCenter size={14} /></ToggleBtn>
              <ToggleBtn active={activeEl.align === "right"} onClick={() => updateElement(activeEl.id, { align: "right" })} title="Align right"><AlignRight size={14} /></ToggleBtn>

              <Div />

              {/* Color + shadow */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[9px] text-slate-600">Color</span>
                <input type="color" value={activeEl.color}
                  onChange={e => updateElement(activeEl.id, { color: e.target.value })}
                  className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent" />
              </div>
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer ml-1">
                <input type="checkbox" checked={activeEl.shadow !== false}
                  onChange={e => updateElement(activeEl.id, { shadow: e.target.checked })}
                  className="accent-indigo-500" />
                <span className="text-[9px] text-slate-500">Shadow</span>
              </label>
            </>}

            {/* ── Shape selected ── */}
            {activeEl?.kind === "shape" && <>
              <span className="text-[9px] text-slate-500 shrink-0">Fill</span>
              <input type="color" value={activeEl.color}
                onChange={e => updateElement(activeEl.id, { color: e.target.value })}
                className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
              <Div />
              <span className="text-[9px] text-slate-500 shrink-0">Opacity</span>
              <input type="range" min={0} max={1} step={0.05}
                value={activeEl.opacity ?? 1}
                onChange={e => updateElement(activeEl.id, { opacity: Number(e.target.value) })}
                className="w-20 accent-indigo-500 shrink-0" />
              <span className="text-[10px] text-slate-400 font-mono shrink-0 w-8">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
            </>}

            {/* ── Image selected ── */}
            {activeEl?.kind === "image" && <>
              <Btn onClick={() => setShowImgPicker(true)} icon={<ImageIcon size={13} />}>Change Image</Btn>
            </>}

            <div className="flex-1" />

            {/* Always: slide-level actions */}
            <div className="flex items-center gap-1 border-l border-white/8 pl-2 shrink-0">
              <Btn onClick={handleDuplicateSlide} icon={<Copy size={13} />}>Dupe</Btn>
              <button
                onClick={handleDeleteSlide}
                disabled={pres.slides.length <= 1}
                className="p-2 bg-white/6 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-all disabled:opacity-20"
                title="Delete slide"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Canvas area */}
          <div
            className="flex-1 flex items-center justify-center p-10 overflow-hidden relative select-none"
            style={{
              background: "radial-gradient(circle, #252540 1px, transparent 1px)",
              backgroundSize: "22px 22px",
              backgroundColor: "#0b0b18",
            }}
            onPointerDown={() => { setActiveElementId(null); }}
          >
            <div
              ref={canvasRef}
              className="relative shadow-2xl shadow-black/80 ring-1 ring-white/8"
              style={{
                aspectRatio: "16/9",
                backgroundColor: slide.backgroundColor,
                width: "min(100%, calc((100vh - 140px) * 16 / 9))",
              }}
            >
              {/* Rendered slide content */}
              <CustomSlideRenderer slide={slide} scale={canvasScale} appDataDir={appDataDir} />

              {/* Interactive element overlay */}
              <div className="absolute inset-0 z-50">
                {slide.elements
                  .slice()
                  .sort((a, b) => a.z_index - b.z_index)
                  .map(el => {
                    const isActive = activeElementId === el.id;
                    const isEditing = editingElementId === el.id;
                    return (
                      <div
                        key={el.id}
                        className={`absolute pointer-events-auto transition-all ${
                          isEditing
                            ? "cursor-text"
                            : isActive
                              ? "cursor-move"
                              : "cursor-pointer"
                        }`}
                        style={{
                          left: `${el.x}%`, top: `${el.y}%`,
                          width: `${el.w}%`, height: `${el.h}%`,
                          zIndex: el.z_index + 100,
                          outline: isEditing
                            ? "2px solid #34d399"
                            : isActive
                              ? "2px solid #818cf8"
                              : "2px solid transparent",
                          outlineOffset: "1px",
                        }}
                        onPointerDown={e => { if (!isEditing) handleDrag(el.id, e); }}
                        onDoubleClick={e => handleDblClick(el.id, e)}
                      >
                        {/* Inline text editor (on double-click) */}
                        {isEditing && el.kind === "text" && (
                          <InlineTextEditor
                            el={el}
                            canvasScale={canvasScale}
                            onCommit={html => commitInline(el.id, html)}
                          />
                        )}

                        {/* Resize handles when active & not editing */}
                        {isActive && !isEditing && Object.entries(HANDLES).map(([h, style]) => (
                          <div
                            key={h}
                            onPointerDown={e => handleResize(el.id, e, h)}
                            className="absolute w-2.5 h-2.5 bg-white border-2 border-indigo-400 rounded-full shadow-md"
                            style={{ position: "absolute", ...style }}
                          />
                        ))}

                        {/* Edit hint for text */}
                        {isActive && !isEditing && el.kind === "text" && (
                          <span className="absolute top-full left-0 mt-1 px-1.5 py-0.5 bg-indigo-500 text-white text-[7px] font-bold rounded whitespace-nowrap pointer-events-none z-[200]">
                            ↕ drag · double-click to edit
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Bottom slide navigator */}
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur border border-white/10 rounded-full px-3 py-1.5 z-[70]">
              <button
                disabled={activeSlideIdx === 0}
                onClick={e => { e.stopPropagation(); setActiveSlideIdx(i => i - 1); setActiveElementId(null); }}
                className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-slate-300 font-bold tabular-nums min-w-[40px] text-center">
                {activeSlideIdx + 1} / {pres.slides.length}
              </span>
              <button
                disabled={activeSlideIdx === pres.slides.length - 1}
                onClick={e => { e.stopPropagation(); setActiveSlideIdx(i => i + 1); setActiveElementId(null); }}
                className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* ══ RIGHT: PROPERTIES PANEL ═══════════════════════════════════════════ */}
        <aside className="w-60 border-l border-white/8 bg-[#131326] flex flex-col overflow-hidden shrink-0">
          <div className="px-3 py-2.5 border-b border-white/8 flex items-center justify-between shrink-0">
            <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">
              {activeEl ? `${activeEl.kind} element` : "Slide"}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 custom-scrollbar">

            {/* ── Slide background ── */}
            <Panel label="Background">
              <div className="flex items-center gap-3">
                <input type="color" value={slide.backgroundColor}
                  onChange={e => updateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined })}
                  className="w-9 h-9 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
                <span className="text-xs text-slate-400 font-mono">{slide.backgroundColor}</span>
              </div>
              <button onClick={() => setShowBgPicker(true)}
                className="w-full px-3 py-2 bg-white/6 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-[11px] font-semibold rounded-lg transition-all text-left">
                {slide.backgroundImage ? "Change Image…" : "Set Image…"}
              </button>
              {slide.backgroundImage && (
                <div className="flex items-center justify-between bg-white/4 p-2 rounded-lg border border-white/8">
                  <span className="text-[9px] text-slate-500 truncate">{slide.backgroundImage.split(/[/\\]/).pop()}</span>
                  <button onClick={() => updateSlide({ ...slide, backgroundImage: undefined })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
                </div>
              )}
            </Panel>

            {/* ── Element controls ── */}
            {activeEl && <>
              {/* Quick actions */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => updateElement(activeEl.id, { locked: !activeEl.locked })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[10px] font-bold transition-all border ${
                    activeEl.locked
                      ? "bg-amber-500/15 border-amber-500/30 text-amber-400"
                      : "bg-white/6 border-white/8 text-slate-400 hover:text-white"
                  }`}
                >
                  {activeEl.locked ? <Lock size={11} /> : <Unlock size={11} />}
                  {activeEl.locked ? "Locked" : "Lock"}
                </button>
                <button onClick={() => duplicateElement(activeEl)}
                  className="px-3 py-2 bg-white/6 hover:bg-white/12 border border-white/8 text-slate-400 hover:text-white rounded-xl transition-all" title="Duplicate">
                  <Copy size={13} />
                </button>
                <button onClick={() => deleteElement(activeEl.id)}
                  className="px-3 py-2 bg-white/6 hover:bg-red-500/20 border border-white/8 text-slate-500 hover:text-red-400 rounded-xl transition-all" title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>

              {/* Position & Size */}
              <Panel label="Position & Size">
                <div className="grid grid-cols-2 gap-2">
                  {([["X %", "x"], ["Y %", "y"], ["W %", "w"], ["H %", "h"]] as const).map(([lbl, key]) => (
                    <div key={key}>
                      <span className="text-[8px] text-slate-600 uppercase font-black">{lbl}</span>
                      <input
                        type="number"
                        value={Math.round(activeEl[key])}
                        onChange={e => updateElement(activeEl.id, { [key]: Number(e.target.value) })}
                        onKeyDown={e => e.stopPropagation()}
                        className="mt-1 w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors"
                      />
                    </div>
                  ))}
                </div>
              </Panel>

              {/* Arrange */}
              <Panel label="Arrange">
                <div className="grid grid-cols-3 gap-1">
                  <IconBtn onClick={() => alignElement("left")} title="Left edge"><AlignLeft size={12} /></IconBtn>
                  <IconBtn onClick={() => alignElement("center")} title="Center H"><AlignCenter size={12} /></IconBtn>
                  <IconBtn onClick={() => alignElement("right")} title="Right edge"><AlignRight size={12} /></IconBtn>
                  <TextBtn onClick={() => alignElement("top")} title="Top">Top</TextBtn>
                  <TextBtn onClick={() => alignElement("middle")} title="Center V">Mid</TextBtn>
                  <TextBtn onClick={() => alignElement("bottom")} title="Bottom">Bot</TextBtn>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1">
                  <IconBtn onClick={() => updateZOrder("back")} title="Send to Back"><MoveDown size={12} /></IconBtn>
                  <IconBtn onClick={() => updateZOrder("backward")} title="Send Backward"><ArrowDown size={12} /></IconBtn>
                  <IconBtn onClick={() => updateZOrder("forward")} title="Bring Forward"><ArrowUp size={12} /></IconBtn>
                  <IconBtn onClick={() => updateZOrder("front")} title="Bring to Front"><MoveUp size={12} /></IconBtn>
                </div>
              </Panel>

              {/* Text vertical alignment */}
              {activeEl.kind === "text" && (
                <Panel label="Vertical Align">
                  <div className="flex gap-1">
                    {(["top", "middle", "bottom"] as const).map(a => (
                      <button key={a}
                        onClick={() => updateElement(activeEl.id, { v_align: a })}
                        className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${
                          (activeEl.v_align === a || (!activeEl.v_align && a === "top"))
                            ? "bg-indigo-500 text-white"
                            : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"
                        }`}
                      >
                        {a[0].toUpperCase() + a.slice(1)}
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
            </>}

            {!activeEl && (
              <p className="text-[10px] text-slate-700 text-center pt-4 leading-relaxed">
                Click to select · double-click text to edit
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* ── Modals ── */}
      {showBgPicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={path => { updateSlide({ ...slide, backgroundImage: relativizePath(path, appDataDir) }); setShowBgPicker(false); }}
          onClose={() => setShowBgPicker(false)}
          onUpload={async () => {
            try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {}
          }}
        />
      )}
      {showImgPicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={handleImageSelect}
          onClose={() => setShowImgPicker(false)}
          onUpload={async () => {
            try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {}
          }}
        />
      )}
      {showBiblePicker && (
        <BiblePickerModal
          onClose={() => setShowBiblePicker(false)}
          onSelect={verse => {
            addEl({
              id: stableId(), kind: "text", x: 10, y: 10, w: 80, h: 80,
              z_index: slide.elements.length + 1,
              content: `${verse.text}\n\n— ${verse.book} ${verse.chapter}:${verse.verse} (${verse.version})`,
              font_size: 40, font_family: "Georgia", color: "#ffffff",
              align: "center", v_align: "middle", bold: false, italic: true,
              shadow: true, shadow_color: "#000",
            });
            setShowBiblePicker(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Micro UI helpers ─────────────────────────────────────────────────────────
function Btn({ onClick, icon, children, className = "" }: { onClick: () => void; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 bg-white/8 hover:bg-white/14 text-slate-300 hover:text-white text-[11px] font-semibold rounded-lg transition-all shrink-0 ${className}`}
    >
      {icon}{children}
    </button>
  );
}

function ToggleBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shrink-0 ${
        active ? "bg-indigo-500 text-white" : "bg-white/8 text-slate-400 hover:text-white hover:bg-white/14"
      }`}
    >
      {children}
    </button>
  );
}

function Div() {
  return <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />;
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/4 rounded-xl border border-white/8 p-3 flex flex-col gap-2.5">
      <p className="text-[8px] font-black uppercase tracking-widest text-slate-600">{label}</p>
      {children}
    </div>
  );
}

function IconBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-2 bg-white/6 hover:bg-white/12 text-slate-400 hover:text-white rounded-lg flex items-center justify-center transition-all"
    >
      {children}
    </button>
  );
}

function TextBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-2 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-white rounded-lg flex items-center justify-center transition-all text-[9px] font-bold"
    >
      {children}
    </button>
  );
}
