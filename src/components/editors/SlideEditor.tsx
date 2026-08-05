import React, { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Trash2, Save, X, ChevronLeft, ChevronRight,
  Type, Image as ImageIcon, Copy, Square,
  Undo2, Redo2, AlignCenter, AlignLeft, AlignRight,
  ArrowUp, ArrowDown, MoveUp, MoveDown,
  BookOpen, Lock, Unlock, GripVertical,
  Download, Upload, Layers, Video, Library, Plus,
} from "lucide-react";
import { CustomSlideRenderer } from "../shared/Renderers";
import { MediaPickerModal } from "../MediaPickerModal";
import { BiblePickerModal } from "../BiblePickerModal";
import { newDefaultSlide, newTitleSlide, newBlankSlide, stableId, relativizePath, exportPresentation, importPresentation, deepCloneSlide } from "../../utils";
import { useAppStore } from "../../store";
import type { CustomPresentation, CustomSlide, MediaItem, SlideElement, SlideTemplate } from "../../types";
import { FONTS } from "../../types";

const HISTORY_MAX = 200;

// ─── Inline Text Editor (with per-word styling mini-toolbar) ──────────────────
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
  const savedSelRef = useRef<Range | null>(null);
  const toolbarHoveredRef = useRef(false);
  const [selToolbar, setSelToolbar] = useState<{ x: number; y: number } | null>(null);
  const [selColor, setSelColor] = useState("#ffffff");
  const [selFontSize, setSelFontSize] = useState(32);

  useEffect(() => {
    const div = ref.current;
    if (!div) return;
    div.innerHTML = el.content || "";
    div.focus();
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  const getSelectionInfo = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current) {
      if (!toolbarHoveredRef.current) setSelToolbar(null);
      return;
    }
    if (!ref.current.contains(sel.anchorNode)) {
      setSelToolbar(null);
      return;
    }
    const range = sel.getRangeAt(0);
    savedSelRef.current = range.cloneRange();
    const rect = range.getBoundingClientRect();
    setSelToolbar({ x: rect.left + rect.width / 2, y: rect.top - 44 });
  }, []);

  const execStyle = useCallback((cmd: string, value?: string) => {
    ref.current?.focus();

    const sel = window.getSelection();
    let range: Range | undefined;
    if (sel && !sel.isCollapsed && ref.current?.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
    } else if (savedSelRef.current) {
      range = savedSelRef.current;
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    if (!range) return;

    if (cmd === "fontSize") {
      const span = document.createElement("span");
      span.style.fontSize = `${value}pt`;
      try { range.surroundContents(span); } catch { }
    } else if (cmd === "foreColor" && value) {
      document.execCommand("foreColor", false, value);
    } else {
      document.execCommand(cmd, false, value);
    }

    savedSelRef.current = null;
    toolbarHoveredRef.current = false;
    setSelToolbar(null);
  }, []);

  const commit = useCallback(() => {
    toolbarHoveredRef.current = false;
    savedSelRef.current = null;
    setSelToolbar(null);
    if (ref.current) onCommit(ref.current.innerHTML);
  }, [onCommit]);

  const handleToolbarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    toolbarHoveredRef.current = true;
  }, []);

  const justifyContent =
    el.v_align === "middle" ? "center" :
    el.v_align === "bottom" ? "flex-end" : "flex-start";

  return (
    <>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onBlur={() => { if (!toolbarHoveredRef.current) commit(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            commit();
          }
        }}
        onMouseUp={() => { setTimeout(getSelectionInfo, 10); }}
        onKeyUp={() => { setTimeout(getSelectionInfo, 10); }}
        className="absolute inset-0 outline-none overflow-hidden ring-2 ring-emerald-400/60"
        style={{
          fontFamily: el.font_family || "inherit",
          fontSize: `${(el.font_size || 32) * canvasScale}pt`,
          color: el.color || "#ffffff",
          fontWeight: el.bold ? "bold" : "normal",
          fontStyle: el.italic ? "italic" : "normal",
          textAlign: (el.align || "center") as React.CSSProperties["textAlign"],
          display: "flex", flexDirection: "column", justifyContent,
          padding: "0", lineHeight: 1.3,
          whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text",
          textShadow: el.shadow !== false ? `0 2px 8px ${el.shadow_color || "rgba(0,0,0,0.6)"}` : "none",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
      />

      {/* Floating mini-toolbar on text selection */}
      {selToolbar && (
        <div
          className="fixed z-[250] flex items-center gap-1 bg-[#1a1a2e] border border-white/15 rounded-xl px-2 py-1.5 shadow-2xl shadow-black/80"
          style={{ left: selToolbar.x, top: selToolbar.y, transform: "translate(-50%, -100%)" }}
          onMouseDown={handleToolbarMouseDown}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); toolbarHoveredRef.current = true; }}
        >
          <button onMouseDown={(e) => { e.preventDefault(); execStyle("bold"); }} className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/16 text-slate-300 hover:text-white text-xs font-black transition-all" title="Bold">B</button>
          <button onMouseDown={(e) => { e.preventDefault(); execStyle("italic"); }} className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/16 text-slate-300 hover:text-white text-xs font-serif italic transition-all" title="Italic">I</button>
          <button onMouseDown={(e) => { e.preventDefault(); execStyle("underline"); }} className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/16 text-slate-300 hover:text-white text-xs underline transition-all" title="Underline">U</button>
          <div className="w-px h-5 bg-white/10 mx-0.5" />
          <div onMouseDown={(e) => { e.preventDefault(); toolbarHoveredRef.current = true; }}>
            <input
              type="color"
              value={selColor}
              onMouseDown={(e) => { e.preventDefault(); toolbarHoveredRef.current = true; }}
              onChange={e => { setSelColor(e.target.value); execStyle("foreColor", e.target.value); }}
              className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
              title="Text Color"
            />
          </div>
          <div className="w-px h-5 bg-white/10 mx-0.5" />
          <button onMouseDown={(e) => { e.preventDefault(); execStyle("fontSize", String(selFontSize - 4)); }} className="w-6 h-7 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/16 text-slate-400 hover:text-white text-[10px] font-bold transition-all" title="Smaller">A⁻</button>
          <span className="text-[9px] text-slate-500 tabular-nums w-5 text-center">{selFontSize}</span>
          <button onMouseDown={(e) => { e.preventDefault(); setSelFontSize(s => s + 4); execStyle("fontSize", String(selFontSize + 4)); }} className="w-6 h-7 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/16 text-slate-400 hover:text-white text-[10px] font-bold transition-all" title="Larger">A⁺</button>
        </div>
      )}
    </>
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
  const { appDataDir, stagedItem, setToast, setIsDirty, templates, setTemplates } = useAppStore();

  const init = () => migratePresentation(JSON.parse(JSON.stringify(initialPres)));
  const [pres, _setPres] = useState<CustomPresentation>(init);
  const [history, setHistory] = useState<CustomPresentation[]>([init()]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [activeElementIds, setActiveElementIds] = useState<string[]>([]);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [focusedSlidePanel, setFocusedSlidePanel] = useState(false);

  const [showBgPicker, setShowBgPicker] = useState(false);
  const [showBgVideoPicker, setShowBgVideoPicker] = useState(false);
  const [showImgPicker, setShowImgPicker] = useState(false);
  const [showVideoPicker, setShowVideoPicker] = useState(false);
  const [showBiblePicker, setShowBiblePicker] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [dragOverSlideIdx, setDragOverSlideIdx] = useState<number | null>(null);
  const [dragSlideIdx, setDragSlideIdx] = useState<number | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const slidePanelRef = useRef<HTMLDivElement>(null);
  const [canvasScale, setCanvasScale] = useState(1);

  const isDirtyRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePendingRef = useRef(false);

  const activeElementId = activeElementIds.length === 1 ? activeElementIds[0] : null;

  // ── Scale tracking ──────────────────────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      if (canvasRef.current) setCanvasScale(canvasRef.current.clientHeight / 1080);
    };
    update();
    window.addEventListener("resize", update);
    const t = setTimeout(update, 120);
    return () => { window.removeEventListener("resize", update); clearTimeout(t); };
  }, []);

  const slide = pres.slides[activeSlideIdx] ?? pres.slides[0];

  const setPres = useCallback(
    (next: CustomPresentation | ((p: CustomPresentation) => CustomPresentation), save = true) => {
      _setPres(prev => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (save) {
          const hist = history.slice(0, historyIndex + 1);
          if (hist.length >= HISTORY_MAX) {
            hist.shift();
            setToast("Undo history limit reached");
          }
          hist.push(JSON.parse(JSON.stringify(resolved)));
          setHistory(hist);
          setHistoryIndex(hist.length - 1);
          isDirtyRef.current = true;
          setIsDirty(true);
        }
        return resolved;
      });
    },
    [history, historyIndex, setToast, setIsDirty],
  );

  // ── Auto-save debounce ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isDirtyRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      if (savePendingRef.current) return;
      savePendingRef.current = true;
      try {
        await invoke("save_studio_presentation", { presentation: pres });
        isDirtyRef.current = false;
        setIsDirty(false);
      } catch (err) {
        console.error("Auto-save failed", err);
      } finally {
        savePendingRef.current = false;
      }
    }, 3000);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [pres, setIsDirty]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const idx = historyIndex - 1;
      _setPres(JSON.parse(JSON.stringify(history[idx])));
      setHistoryIndex(idx);
      isDirtyRef.current = true;
      setIsDirty(true);
    }
  }, [history, historyIndex, setIsDirty]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const idx = historyIndex + 1;
      _setPres(JSON.parse(JSON.stringify(history[idx])));
      setHistoryIndex(idx);
      isDirtyRef.current = true;
      setIsDirty(true);
    }
  }, [history, historyIndex, setIsDirty]);

  // ── Get IDs to move (element + all group members) ───────────────────────────
  const getGroupIds = useCallback((id: string): string[] => {
    const el = slide.elements.find(e => e.id === id);
    if (el?.groupId) {
      return slide.elements.filter(e => e.groupId === el.groupId).map(e => e.id);
    }
    return [id];
  }, [slide.elements]);

  // ── All selected IDs including group members ───────────────────────────────
  const allSelectedIds = new Set<string>();
  activeElementIds.forEach(id => {
    getGroupIds(id).forEach(gid => allSelectedIds.add(gid));
  });

  // ── Is any selected element locked? ────────────────────────────────────────
  const isSelectionLocked = activeElementIds.some(id => {
    const el = slide.elements.find(e => e.id === id);
    return el?.locked;
  });

  // ── Global keyboard shortcuts ───────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const typing =
        tgt.tagName === "INPUT" ||
        tgt.tagName === "TEXTAREA" ||
        tgt.tagName === "SELECT" ||
        tgt.contentEditable === "true";

      if (typing) return;

      // Slide panel keyboard navigation
      if (focusedSlidePanel) {
        if (e.key === "ArrowUp") {
          e.preventDefault(); setActiveSlideIdx(i => Math.max(0, i - 1));
        } else if (e.key === "ArrowDown") {
          e.preventDefault(); setActiveSlideIdx(i => Math.min(pres.slides.length - 1, i + 1));
        } else if (e.key === "Delete") {
          e.preventDefault(); handleDeleteSlide();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault(); e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault(); redo();
      } else if (e.key === "Escape") {
        setActiveElementIds([]); setEditingElementId(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (activeElementIds.length > 0) deleteSelectedElements();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        e.preventDefault();
        if (activeElementIds.length > 0) duplicateSelectedElements();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "g") {
        e.preventDefault();
        if (activeElementIds.length > 1) groupSelectedElements();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "u") {
        e.preventDefault();
        ungroupSelectedElements();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [undo, redo, activeElementIds, slide.elements, focusedSlidePanel, pres.slides.length]);

  // ── Element helper: get all selected elements ───────────────────────────────
  const getSelectedElements = (): SlideElement[] =>
    slide.elements.filter(e => activeElementIds.some(id => allSelectedIds.has(id)) || activeElementIds.includes(e.id));

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

  const updateElements = (ids: string[], updates: Partial<SlideElement>, save = true) =>
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => ids.includes(e.id) ? { ...e, ...updates } : e) };
      return { ...prev, slides: ns };
    }, save);

  const deleteElement = (id: string) => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.filter(e => e.id !== id) };
      return { ...prev, slides: ns };
    });
    setActiveElementIds(prev => prev.filter(i => i !== id));
  };

  const deleteSelectedElements = () => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.filter(e => !allSelectedIds.has(e.id)) };
      return { ...prev, slides: ns };
    });
    setActiveElementIds([]);
  };

  const duplicateSelectedElements = () => {
    const toDup = getSelectedElements();
    if (toDup.length === 0) return;
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      const newEls = toDup.map(el => ({ ...el, id: stableId(), x: el.x + 3, y: el.y + 3, z_index: cs.elements.length + 1 }));
      const newIds = newEls.map(e => e.id);
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, ...newEls] };
      return { ...prev, slides: ns };
    });
    setActiveElementIds(prev => {
      const newIds = toDup.map(() => stableId());
      return [...prev, ...newIds].slice(-toDup.length);
    });
  };

  const duplicateElement = (el: SlideElement) => {
    const n = { ...el, id: stableId(), x: el.x + 3, y: el.y + 3, z_index: slide.elements.length + 1 };
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, n] };
      return { ...prev, slides: ns };
    });
    setActiveElementIds([n.id]);
  };

  const groupSelectedElements = () => {
    const toGroup = activeElementIds.filter(id => slide.elements.find(e => e.id === id && !e.groupId));
    if (toGroup.length < 2) return;
    const groupId = stableId();
    updateElements(toGroup, { groupId });
    setToast(`${toGroup.length} elements grouped (Ctrl+G)`);
  };

  const ungroupSelectedElements = () => {
    const toUngroup = activeElementIds
      .map(id => slide.elements.find(e => e.id === id))
      .filter((e): e is SlideElement => !!e?.groupId)
      .flatMap(e => slide.elements.filter(x => x.groupId === e.groupId).map(x => x.id));
    if (toUngroup.length === 0) return;
    updateElements([...new Set(toUngroup)], { groupId: undefined });
    setToast("Group ungrouped (Ctrl+U)");
  };

  const addEl = (el: SlideElement) => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, el] };
      return { ...prev, slides: ns };
    });
    setActiveElementIds([el.id]);
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

  const addVideoElement = () => addEl({
    id: stableId(), kind: "video", x: 15, y: 10, w: 70, h: 80,
    z_index: slide.elements.length + 1, content: "",
    loop: true, muted: true,
  });

  const handleAddSlide = (type: "default" | "title" | "blank") => {
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0,
        type === "title" ? newTitleSlide() : type === "blank" ? newBlankSlide() : newDefaultSlide());
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementIds([]);
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
    setActiveElementIds([]);
  };

  const handleDeleteSlide = () => {
    if (pres.slides.length <= 1) return;
    setPres(prev => ({ ...prev, slides: prev.slides.filter((_, i) => i !== activeSlideIdx) }));
    setActiveSlideIdx(i => Math.max(0, i - 1));
    setActiveElementIds([]);
  };

  const handleMoveSlide = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    setPres(prev => {
      const ns = [...prev.slides];
      const [moved] = ns.splice(fromIdx, 1);
      ns.splice(toIdx, 0, moved);
      return { ...prev, slides: ns };
    });
    if (fromIdx === activeSlideIdx) setActiveSlideIdx(toIdx);
    else if (fromIdx < activeSlideIdx && toIdx >= activeSlideIdx) setActiveSlideIdx(i => i - 1);
    else if (fromIdx > activeSlideIdx && toIdx <= activeSlideIdx) setActiveSlideIdx(i => i + 1);
  };

  const alignElement = (type: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (activeElementIds.length === 0) return;
    const els = slide.elements.filter(e => activeElementIds.includes(e.id));
    els.forEach(el => {
      const u: Partial<SlideElement> = {};
      if (type === "left")   u.x = 0;
      if (type === "right")  u.x = 100 - el.w;
      if (type === "center") u.x = (100 - el.w) / 2;
      if (type === "top")    u.y = 0;
      if (type === "bottom") u.y = 100 - el.h;
      if (type === "middle") u.y = (100 - el.h) / 2;
      updateElement(el.id, u);
    });
  };

  const updateZOrder = (dir: "forward" | "backward" | "front" | "back") => {
    if (activeElementIds.length === 0) return;
    const ids = new Set(activeElementIds);
    const els = [...slide.elements].sort((a, b) => a.z_index - b.z_index);
    const i = els.findIndex(e => ids.has(e.id));
    if (i === -1) return;
    const target = els[i];
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

  // ── Slide reordering via drag ───────────────────────────────────────────────
  const handleSlideDragStart = (idx: number) => { setDragSlideIdx(idx); };
  const handleSlideDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragOverSlideIdx !== idx) setDragOverSlideIdx(idx);
  };
  const handleSlideDragEnd = () => {
    if (dragSlideIdx !== null && dragOverSlideIdx !== null && dragSlideIdx !== dragOverSlideIdx) {
      handleMoveSlide(dragSlideIdx, dragOverSlideIdx);
    }
    setDragSlideIdx(null); setDragOverSlideIdx(null);
  };

  // ── Element drag (supports multi-select) ────────────────────────────────────
  const handleDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0 || editingElementId === id) return;
    e.stopPropagation(); e.preventDefault();
    if (!activeElementIds.includes(id)) {
      if (e.ctrlKey || e.metaKey) {
        setActiveElementIds(prev => [...prev, id]);
      } else {
        setActiveElementIds([id]);
      }
    }
    // Wait for state update – use current selection
    const moveIds = activeElementIds.includes(id)
      ? [...activeElementIds].filter(i => !slide.elements.find(x => x.id === i)?.locked)
      : [id];
    if (moveIds.length === 0) return;
    if (!canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const startPositions = moveIds.map(mid => {
      const el = slide.elements.find(x => x.id === mid);
      return el ? { id: mid, ix: el.x, iy: el.y } : null;
    }).filter(Boolean) as { id: string; ix: number; iy: number }[];

    const sx = e.clientX; const sy = e.clientY;
    let lxMap = new Map(startPositions.map(p => [p.id, p.ix]));
    let lyMap = new Map(startPositions.map(p => [p.id, p.iy]));
    const move = (mv: PointerEvent) => {
      const dx = ((mv.clientX - sx) / rect.width) * 100;
      const dy = ((mv.clientY - sy) / rect.height) * 100;
      for (const sp of startPositions) {
        const nx = sp.ix + dx;
        const ny = sp.iy + dy;
        lxMap.set(sp.id, nx);
        lyMap.set(sp.id, ny);
        updateElement(sp.id, { x: nx, y: ny }, false);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const sp of startPositions) {
        updateElement(sp.id, { x: lxMap.get(sp.id)!, y: lyMap.get(sp.id)! }, true);
      }
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

  const handleCanvasClick = (e: React.MouseEvent) => {
    setActiveElementIds([]);
  };

  const handleElementClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      setActiveElementIds(prev =>
        prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
      );
    } else {
      setActiveElementIds([id]);
    }
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

  // ── Save / Close ────────────────────────────────────────────────────────────
  const handleSaveAndClose = async () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      isDirtyRef.current = false;
      setIsDirty(false);
      onClose(true);
    } catch (err) {
      console.error("Save failed", err);
      setToast("Save failed");
    }
  };

  const handleCloseRequest = () => {
    if (isDirtyRef.current) setShowUnsavedConfirm(true);
    else onClose(false);
  };

  const handleDiscardChanges = () => {
    isDirtyRef.current = false;
    setIsDirty(false);
    setShowUnsavedConfirm(false);
    onClose(false);
  };

  // ── Export / Import ─────────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      const filePath = await saveDialog({
        defaultPath: `${pres.name.replace(/[^a-zA-Z0-9]/g, "_")}.biblepresenter.json`,
        filters: [{ name: "Bible Presenter File", extensions: ["json"] }],
      });
      if (!filePath) return;
      const exp = exportPresentation({ presentation: pres });
      const json = JSON.stringify(exp, null, 2);
      // Write via invoke to get filesystem access
      await invoke("write_text_file", { path: filePath, content: json });
      setToast("Presentation exported");
    } catch (err) { setToast("Export failed: " + String(err)); }
  };

  const handleImport = async () => {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "Bible Presenter Files", extensions: ["json"] }],
      });
      if (!sel || typeof sel !== "string") return;
      const content = await invoke<string>("read_text_file", { path: sel });
      const data = JSON.parse(content);
      const result = importPresentation(data);
      if (!result.success || !result.presentation) {
        setToast(result.error || "Import failed");
        return;
      }
      const imported = result.presentation as CustomPresentation;
      imported.id = stableId();
      imported.name = imported.name + " (Imported)";
      imported.slides.forEach(s => {
        s.id = stableId();
        s.elements.forEach(e => (e.id = stableId()));
      });
      setPres(imported);
      setActiveSlideIdx(0);
      setActiveElementIds([]);
      setToast("Imported successfully — press Save to keep");
    } catch (err) { setToast("Import failed: " + String(err)); }
  };

  // ── Templates ───────────────────────────────────────────────────────────────
  const handleSaveAsTemplate = async () => {
    const slide = pres.slides[activeSlideIdx];
    const templateSlide = deepCloneSlide(slide);
    templateSlide.id = stableId();
    templateSlide.elements.forEach(e => (e.id = stableId()));
    const tpl: SlideTemplate = {
      id: stableId(),
      name: `Template ${templates.length + 1}`,
      category: "Custom",
      slide: templateSlide,
      created_at: Date.now(),
    };
    try {
      const saved = await invoke<SlideTemplate>("save_slide_template", { template: tpl });
      setTemplates(prev => [...prev, saved]);
      setToast("Slide saved as template");
    } catch (err) { setToast("Failed to save template"); }
  };

  const handleInsertTemplate = (tpl: SlideTemplate) => {
    const cloned = deepCloneSlide(tpl.slide);
    cloned.id = stableId();
    cloned.elements.forEach(e => (e.id = stableId()));
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0, cloned);
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementIds([]);
    setShowTemplateGallery(false);
    setToast(`Inserted template: ${tpl.name}`);
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await invoke("delete_slide_template", { id });
      setTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { setToast("Failed to delete template"); }
  };

  // ── Handle click outside selection ─────────────────────────────────────────
  const activeEl = activeElementId ? slide.elements.find(e => e.id === activeElementId) : null;

  const handleImageSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    if (activeEl?.kind === "image") {
      updateElement(activeEl.id, { content: rel });
    } else {
      addEl({ id: stableId(), kind: "image", x: 20, y: 15, w: 60, h: 70, z_index: slide.elements.length + 1, content: rel });
    }
    setShowImgPicker(false);
  };

  const handleVideoSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    if (activeEl?.kind === "video") {
      updateElement(activeEl.id, { content: rel });
    } else {
      addVideoElement();
      const lastEl = slide.elements[slide.elements.length - 1];
      if (lastEl) updateElement(lastEl.id, { content: rel });
    }
    setShowVideoPicker(false);
  };

  const handleBgVideoSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    updateSlide({ ...slide, backgroundVideo: rel, backgroundVideoLoop: true, backgroundVideoMuted: true });
    setShowBgVideoPicker(false);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  const selectedCount = activeElementIds.length;
  const hasGroup = activeElementIds.some(id => !!slide.elements.find(e => e.id === id)?.groupId);
  const multiSelectActive = selectedCount > 1;

  return (
    <div className="fixed inset-0 z-[60] bg-[#0e0e1c] flex flex-col font-sans">

      {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-white/8 bg-[#131326] shrink-0">
        <button onClick={handleCloseRequest} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Close editor">
          <X size={18} />
        </button>
        <div className="h-5 w-px bg-white/10" />
        {isDirtyRef.current && <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" title="Unsaved changes" />}
        <input
          value={pres.name}
          onChange={e => setPres({ ...pres, name: e.target.value })}
          onKeyDown={e => e.stopPropagation()}
          className="bg-transparent text-sm font-semibold text-white focus:outline-none min-w-0 flex-1"
          placeholder="Untitled Presentation"
        />
        <span className="text-[10px] font-bold text-slate-500 tabular-nums whitespace-nowrap bg-white/6 px-2 py-1 rounded">
          {activeSlideIdx + 1} / {pres.slides.length}
        </span>
        <div className="h-5 w-px bg-white/10" />
        <div className="flex bg-white/6 rounded-lg p-0.5 gap-0.5">
          <button onClick={undo} disabled={historyIndex === 0} className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Undo (Ctrl+Z)">
            <Undo2 size={15} />
          </button>
          <button onClick={redo} disabled={historyIndex === history.length - 1} className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Redo (Ctrl+Y)">
            <Redo2 size={15} />
          </button>
        </div>
        <div className="h-5 w-px bg-white/10" />
        <button onClick={handleImport} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Import presentation">
          <Upload size={13} />
        </button>
        <button onClick={handleExport} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Export presentation">
          <Download size={13} />
        </button>
        <div className="h-5 w-px bg-white/10" />
        <button onClick={handleSaveAndClose} className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black uppercase text-[11px] rounded-lg transition-all shadow-lg tracking-wide">
          <Save size={14} /> Save & Close
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">

        {/* ══ LEFT: SLIDE PANEL + TEMPLATES ════════════════════════════════════ */}
        <aside className="w-48 border-r border-white/8 bg-[#131326] flex flex-col overflow-hidden shrink-0">
          <div className="px-3 py-2 border-b border-white/8 flex items-center justify-between shrink-0">
            <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">Slides</span>
            <span className="text-[8px] text-slate-700">{pres.slides.length}</span>
          </div>

          <div
            ref={slidePanelRef}
            tabIndex={0}
            onFocus={() => setFocusedSlidePanel(true)}
            onBlur={() => setFocusedSlidePanel(false)}
            className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-2 custom-scrollbar outline-none"
          >
            {pres.slides.map((s, i) => (
              <button
                key={s.id}
                draggable
                onDragStart={() => handleSlideDragStart(i)}
                onDragOver={(e) => handleSlideDragOver(e, i)}
                onDragEnd={handleSlideDragEnd}
                onDragLeave={() => { if (dragOverSlideIdx === i) setDragOverSlideIdx(null); }}
                onClick={() => { setActiveSlideIdx(i); setActiveElementIds([]); setEditingElementId(null); }}
                className={`relative aspect-video rounded-xl overflow-hidden border-2 transition-all shrink-0 group ${
                  i === activeSlideIdx
                    ? "border-indigo-500 shadow-lg shadow-indigo-500/20"
                    : dragOverSlideIdx === i
                      ? "border-purple-500 border-dashed shadow-lg shadow-purple-500/20"
                      : dragSlideIdx === i
                        ? "border-white/20 opacity-50"
                        : "border-white/8 hover:border-white/20"
                } ${dragSlideIdx !== null ? "cursor-grabbing" : ""} ${focusedSlidePanel && i === activeSlideIdx ? "ring-1 ring-indigo-400/50" : ""}`}
              >
                <CustomSlideRenderer slide={s} scale={0.07} appDataDir={appDataDir} />
                <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded flex items-center justify-center text-[8px] font-black ${
                  i === activeSlideIdx ? "bg-indigo-500 text-white" : "bg-black/60 text-white/50"
                }`}>
                  {i + 1}
                </span>
                <div className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-white/30">
                  <GripVertical size={10} />
                </div>
                {dragOverSlideIdx === i && dragSlideIdx !== i && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400" />
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-white/8 p-2 flex gap-1 shrink-0">
            {(["Title", "Body", "Blank"] as const).map(t => (
              <button key={t}
                onClick={() => handleAddSlide(t.toLowerCase() as "title" | "default" | "blank")}
                className="flex-1 py-1.5 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-slate-300 text-[8px] font-bold rounded-lg transition-all"
              >
                +{t[0]}
              </button>
            ))}
            <button onClick={() => setShowTemplateGallery(true)}
              className="flex-1 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 hover:text-purple-300 text-[8px] font-bold rounded-lg transition-all border border-purple-500/20"
              title="Insert from Templates"
            >
              <Library size={10} className="inline mr-0.5" />Tpl
            </button>
          </div>
        </aside>

        {/* ══ CENTER: CANVAS ════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col overflow-hidden">

          <div className="h-11 border-b border-white/8 flex items-center px-3 gap-1 bg-[#131326] shrink-0 overflow-x-auto">

            {/* ── No selection: Insert tools ── */}
            {selectedCount === 0 && <>
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-600 mr-1 shrink-0">Insert</span>
              <Btn onClick={addTextElement} icon={<Type size={13} />}>Text</Btn>
              <Btn onClick={() => setShowImgPicker(true)} icon={<ImageIcon size={13} />}>Image</Btn>
              <Btn onClick={() => setShowVideoPicker(true)} icon={<Video size={13} />}>Video</Btn>
              <Btn onClick={addShapeElement} icon={<Square size={13} />}>Shape</Btn>
              <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />
              <Btn onClick={() => setShowBiblePicker(true)} icon={<BookOpen size={13} />} className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/20">
                Bible
              </Btn>
              {stagedItem?.type === "Verse" && (
                <Btn onClick={() => {
                  const v = stagedItem.data;
                  addEl({ id: stableId(), kind: "text", x: 10, y: 10, w: 80, h: 80, z_index: slide.elements.length + 1, content: `${v.text}\n— ${v.book} ${v.chapter}:${v.verse}`, font_size: 40, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: true, shadow: true, shadow_color: "#000" });
                }} icon={<BookOpen size={13} />} className="text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20">
                  Insert Verse
                </Btn>
              )}
            </>}

            {/* ── Multi-select actions ── */}
            {multiSelectActive && <>
              <span className="text-[9px] text-indigo-400 font-bold shrink-0">{selectedCount} selected</span>
              <Btn onClick={groupSelectedElements} icon={<Layers size={13} />}>Group</Btn>
              {hasGroup && <Btn onClick={ungroupSelectedElements} icon={<Layers size={13} />}>Ungroup</Btn>}
              <Btn onClick={duplicateSelectedElements} icon={<Copy size={13} />}>Dup All</Btn>
              <Btn onClick={deleteSelectedElements} icon={<Trash2 size={13} />} className="hover:bg-red-500/20 hover:text-red-400">Del All</Btn>
              <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />
            </>}

            {/* ── Text element selected ── */}
            {activeEl?.kind === "text" && selectedCount === 1 && <>
              <select value={activeEl.font_family} onChange={e => updateElement(activeEl.id, { font_family: e.target.value })} onKeyDown={e => e.stopPropagation()} className="bg-white/8 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-slate-300 outline-none max-w-[130px] shrink-0">
                {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <div className="flex items-center bg-white/8 border border-white/10 rounded-lg shrink-0 overflow-hidden">
                <button onClick={() => updateElement(activeEl.id, { font_size: Math.max(8, (activeEl.font_size ?? 32) - 2) })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">−</button>
                <input type="number" value={activeEl.font_size ?? 32} onChange={e => updateElement(activeEl.id, { font_size: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-10 bg-transparent py-1 text-xs text-white text-center outline-none tabular-nums" />
                <button onClick={() => updateElement(activeEl.id, { font_size: (activeEl.font_size ?? 32) + 2 })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">+</button>
              </div>
              <Div /><ToggleBtn active={!!activeEl.bold} onClick={() => updateElement(activeEl.id, { bold: !activeEl.bold })} title="Bold"><span className="font-black text-sm">B</span></ToggleBtn>
              <ToggleBtn active={!!activeEl.italic} onClick={() => updateElement(activeEl.id, { italic: !activeEl.italic })} title="Italic"><span className="font-serif italic text-sm">I</span></ToggleBtn>
              <Div />
              <ToggleBtn active={activeEl.align === "left"} onClick={() => updateElement(activeEl.id, { align: "left" })} title="Align left"><AlignLeft size={14} /></ToggleBtn>
              <ToggleBtn active={activeEl.align === "center" || !activeEl.align} onClick={() => updateElement(activeEl.id, { align: "center" })} title="Center"><AlignCenter size={14} /></ToggleBtn>
              <ToggleBtn active={activeEl.align === "right"} onClick={() => updateElement(activeEl.id, { align: "right" })} title="Align right"><AlignRight size={14} /></ToggleBtn>
              <Div />
              <div className="flex items-center gap-1.5 shrink-0"><span className="text-[9px] text-slate-600">Color</span><input type="color" value={activeEl.color} onChange={e => updateElement(activeEl.id, { color: e.target.value })} className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent" /></div>
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer ml-1"><input type="checkbox" checked={activeEl.shadow !== false} onChange={e => updateElement(activeEl.id, { shadow: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Shadow</span></label>
            </>}

            {/* ── Shape selected ── */}
            {activeEl?.kind === "shape" && selectedCount === 1 && <>
              <span className="text-[9px] text-slate-500 shrink-0">Fill</span><input type="color" value={activeEl.color} onChange={e => updateElement(activeEl.id, { color: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
              <Div /><span className="text-[9px] text-slate-500 shrink-0">Opacity</span><input type="range" min={0} max={1} step={0.05} value={activeEl.opacity ?? 1} onChange={e => updateElement(activeEl.id, { opacity: Number(e.target.value) })} className="w-20 accent-indigo-500 shrink-0" />
              <span className="text-[10px] text-slate-400 font-mono shrink-0 w-8">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
            </>}

            {/* ── Image selected ── */}
            {activeEl?.kind === "image" && selectedCount === 1 && <>
              <Btn onClick={() => setShowImgPicker(true)} icon={<ImageIcon size={13} />}>Change Image</Btn>
            </>}

            {/* ── Video selected ── */}
            {activeEl?.kind === "video" && selectedCount === 1 && <>
              <Btn onClick={() => setShowVideoPicker(true)} icon={<Video size={13} />}>Change Video</Btn>
              <Div />
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.loop !== false} onChange={e => updateElement(activeEl.id, { loop: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Loop</span></label>
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.muted !== false} onChange={e => updateElement(activeEl.id, { muted: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Muted</span></label>
            </>}

            <div className="flex-1" />
            <div className="flex items-center gap-1 border-l border-white/8 pl-2 shrink-0">
              <Btn onClick={handleDuplicateSlide} icon={<Copy size={13} />}>Dupe</Btn>
              <button onClick={handleDeleteSlide} disabled={pres.slides.length <= 1} className="p-2 bg-white/6 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-all disabled:opacity-20" title="Delete slide"><Trash2 size={13} /></button>
            </div>
          </div>

          {/* Canvas area */}
          <div
            className={`flex-1 flex items-center justify-center p-10 overflow-hidden relative ${editingElementId ? '' : 'select-none'}`}
            style={{ background: "radial-gradient(circle, #252540 1px, transparent 1px)", backgroundSize: "22px 22px", backgroundColor: "#0b0b18" }}
            onClick={handleCanvasClick}
          >
            <div ref={canvasRef} className="relative shadow-2xl shadow-black/80 ring-1 ring-white/8" style={{ aspectRatio: "16/9", backgroundColor: slide.backgroundColor, width: "min(100%, calc((100vh - 140px) * 16 / 9))" }}>
              <CustomSlideRenderer slide={slide} scale={canvasScale} appDataDir={appDataDir} hiddenElementIds={editingElementId ? [editingElementId] : []} />

              <div className="absolute inset-0 z-50">
                {slide.elements.slice().sort((a, b) => a.z_index - b.z_index).map(el => {
                  const isActive = activeElementIds.includes(el.id);
                  const isEditing = editingElementId === el.id;
                  const isGroupedSelected = el.groupId && activeElementIds.some(id => {
                    const sel = slide.elements.find(e => e.id === id);
                    return sel?.groupId === el.groupId;
                  });
                  const highlight = isActive || isGroupedSelected;

                  return (
                    <div key={el.id}
                      className={`absolute pointer-events-auto transition-all ${isEditing ? "cursor-text" : isActive ? "cursor-move" : "cursor-pointer"}`}
                      style={{
                        left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`,
                        zIndex: el.z_index + 100,
                        outline: isEditing ? "2px solid #34d399" : isActive ? "2px solid #818cf8" : isGroupedSelected ? "2px dashed #818cf8" : "2px solid transparent",
                        outlineOffset: "1px",
                      }}
                      onClick={e => handleElementClick(el.id, e)}
                      onPointerDown={e => { if (!isEditing) handleDrag(el.id, e); }}
                      onDoubleClick={e => handleDblClick(el.id, e)}
                    >
                      {isEditing && el.kind === "text" && <InlineTextEditor el={el} canvasScale={canvasScale} onCommit={html => commitInline(el.id, html)} />}
                      {isActive && !isEditing && Object.entries(HANDLES).map(([h, style]) => (
                        <div key={h} onPointerDown={e => handleResize(el.id, e, h)} className="absolute w-2.5 h-2.5 bg-white border-2 border-indigo-400 rounded-full shadow-md" style={{ position: "absolute", ...style }} />
                      ))}
                      {isActive && !isEditing && el.kind === "text" && (
                        <span className="absolute top-full left-0 mt-1 px-1.5 py-0.5 bg-indigo-500 text-white text-[7px] font-bold rounded whitespace-nowrap pointer-events-none z-[200]">↕ drag · double-click to edit</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur border border-white/10 rounded-full px-3 py-1.5 z-[70]">
              <button disabled={activeSlideIdx === 0} onClick={e => { e.stopPropagation(); setActiveSlideIdx(i => i - 1); setActiveElementIds([]); }} className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"><ChevronLeft size={16} /></button>
              <span className="text-xs text-slate-300 font-bold tabular-nums min-w-[40px] text-center">{activeSlideIdx + 1} / {pres.slides.length}</span>
              <button disabled={activeSlideIdx === pres.slides.length - 1} onClick={e => { e.stopPropagation(); setActiveSlideIdx(i => i + 1); setActiveElementIds([]); }} className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"><ChevronRight size={16} /></button>
            </div>
          </div>
        </div>

        {/* ══ RIGHT: PROPERTIES + NOTES PANEL ════════════════════════════════════ */}
        <aside className="w-60 border-l border-white/8 bg-[#131326] flex flex-col overflow-hidden shrink-0">
          <div className="px-3 py-2.5 border-b border-white/8 flex items-center justify-between shrink-0">
            <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">
              {activeEl ? `${activeEl.kind} element` : selectedCount > 1 ? `${selectedCount} elements` : "Slide"}
            </span>
            {selectedCount > 1 && <span className="text-[8px] text-indigo-400 font-bold">Ctrl+G to group</span>}
          </div>

          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 custom-scrollbar">

            {/* ── Slide background ── */}
            <Panel label="Background">
              <div className="flex items-center gap-3">
                <input type="color" value={slide.backgroundColor} onChange={e => updateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined, backgroundVideo: undefined })} className="w-9 h-9 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
                <span className="text-xs text-slate-400 font-mono">{slide.backgroundColor}</span>
              </div>
              <button onClick={() => setShowBgPicker(true)} className="w-full px-3 py-2 bg-white/6 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-[11px] font-semibold rounded-lg transition-all text-left">
                {slide.backgroundImage ? "Change Image…" : "Set Image…"}
              </button>
              {slide.backgroundImage && (
                <div className="flex items-center justify-between bg-white/4 p-2 rounded-lg border border-white/8">
                  <span className="text-[9px] text-slate-500 truncate">{slide.backgroundImage.split(/[/\\]/).pop()}</span>
                  <button onClick={() => updateSlide({ ...slide, backgroundImage: undefined })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
                </div>
              )}
              <div className="w-full h-px bg-white/5 my-0.5" />
              <button onClick={() => setShowBgVideoPicker(true)} className="w-full px-3 py-2 bg-purple-600/10 hover:bg-purple-600/20 text-purple-400 hover:text-purple-300 text-[11px] font-semibold rounded-lg transition-all text-left border border-purple-500/10">
                {slide.backgroundVideo ? "Change Video…" : "Set Video…"}
              </button>
              {slide.backgroundVideo && (
                <div className="flex flex-col gap-2 bg-white/4 p-2 rounded-lg border border-white/8">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-slate-500 truncate">{slide.backgroundVideo.split(/[/\\]/).pop()}</span>
                    <button onClick={() => updateSlide({ ...slide, backgroundVideo: undefined })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={slide.backgroundVideoLoop !== false} onChange={e => updateSlide({ ...slide, backgroundVideoLoop: e.target.checked })} className="accent-purple-500" />
                    <span className="text-[9px] text-slate-500">Loop</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={slide.backgroundVideoMuted !== false} onChange={e => updateSlide({ ...slide, backgroundVideoMuted: e.target.checked })} className="accent-purple-500" />
                    <span className="text-[9px] text-slate-500">Muted</span>
                  </label>
                </div>
              )}
            </Panel>

            {/* ── Slide Notes ── */}
            <Panel label="Speaker Notes">
              <textarea
                value={slide.notes || ""}
                onChange={e => updateSlide({ ...slide, notes: e.target.value })}
                onKeyDown={e => e.stopPropagation()}
                placeholder="Notes for this slide (not shown on output)..."
                className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/50 transition-colors resize-none h-20 custom-scrollbar"
              />
            </Panel>

            {/* ── Template actions ── */}
            <Panel label="Template">
              <button onClick={handleSaveAsTemplate} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 hover:text-purple-300 text-[10px] font-bold rounded-lg transition-all border border-purple-500/20">
                <Library size={12} /> Save Slide as Template
              </button>
            </Panel>

            {/* ── Element controls ── */}
            {activeEl && selectedCount === 1 && <>
              <div className="flex gap-1.5">
                <button onClick={() => updateElement(activeEl.id, { locked: !activeEl.locked })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[10px] font-bold transition-all border ${activeEl.locked ? "bg-amber-500/15 border-amber-500/30 text-amber-400" : "bg-white/6 border-white/8 text-slate-400 hover:text-white"}`}>
                  {activeEl.locked ? <Lock size={11} /> : <Unlock size={11} />}{activeEl.locked ? "Locked" : "Lock"}
                </button>
                <button onClick={() => duplicateElement(activeEl)} className="px-3 py-2 bg-white/6 hover:bg-white/12 border border-white/8 text-slate-400 hover:text-white rounded-xl transition-all" title="Duplicate"><Copy size={13} /></button>
                <button onClick={() => deleteElement(activeEl.id)} className="px-3 py-2 bg-white/6 hover:bg-red-500/20 border border-white/8 text-slate-500 hover:text-red-400 rounded-xl transition-all" title="Delete"><Trash2 size={13} /></button>
              </div>

              <Panel label="Position & Size">
                <div className="grid grid-cols-2 gap-2">
                  {([["X %", "x"], ["Y %", "y"], ["W %", "w"], ["H %", "h"]] as const).map(([lbl, key]) => (
                    <div key={key}>
                      <span className="text-[8px] text-slate-600 uppercase font-black">{lbl}</span>
                      <input type="number" value={Math.round(activeEl[key])} onChange={e => updateElement(activeEl.id, { [key]: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="mt-1 w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors" />
                    </div>
                  ))}
                </div>
              </Panel>

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

              {activeEl.kind === "text" && (
                <Panel label="Vertical Align">
                  <div className="flex gap-1">
                    {(["top", "middle", "bottom"] as const).map(a => (
                      <button key={a} onClick={() => updateElement(activeEl.id, { v_align: a })} className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${(activeEl.v_align === a || (!activeEl.v_align && a === "top")) ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}>
                        {a[0].toUpperCase() + a.slice(1)}
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
            </>}

            {selectedCount > 1 && (
              <div className="flex flex-col gap-2">
                <button onClick={groupSelectedElements} className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-[10px] font-bold rounded-lg transition-all border border-indigo-500/20">
                  <Layers size={12} /> Group ({selectedCount} elements)
                </button>
                {hasGroup && (
                  <button onClick={ungroupSelectedElements} className="w-full flex items-center justify-center gap-1.5 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-[10px] font-bold rounded-lg transition-all border border-amber-500/20">
                    <Layers size={12} /> Ungroup
                  </button>
                )}
              </div>
            )}

            {selectedCount === 0 && (
              <p className="text-[10px] text-slate-700 text-center pt-4 leading-relaxed">
                Click to select · Ctrl+click for multi<br />
                <span className="text-[8px] text-slate-800">Drag slides to reorder · Ctrl+G group</span>
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* ── Template Gallery Modal ── */}
      {showTemplateGallery && (
        <div className="absolute inset-0 z-[100] bg-black/70 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-[#131326] border border-white/10 rounded-2xl p-5 w-full max-w-lg mx-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <p className="text-sm font-bold text-white">Slide Templates</p>
              <button onClick={() => setShowTemplateGallery(false)} className="text-slate-400 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {templates.length === 0 ? (
                <p className="text-slate-600 text-xs text-center py-8">No templates yet. Save a slide as template from the right panel.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {templates.map(tpl => (
                    <div key={tpl.id} className="group relative rounded-xl border border-white/8 bg-white/4 overflow-hidden">
                      <CustomSlideRenderer slide={tpl.slide} scale={0.1} appDataDir={appDataDir} />
                      <div className="p-2 flex items-center justify-between bg-white/4">
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold text-slate-300 truncate">{tpl.name}</p>
                          <p className="text-[8px] text-slate-600">{tpl.category}</p>
                        </div>
                        <div className="flex gap-1 shrink-0 ml-2">
                          <button onClick={() => handleInsertTemplate(tpl)} className="p-1.5 bg-purple-600/30 hover:bg-purple-600 text-purple-300 hover:text-white rounded-lg transition-all" title="Insert slide"><Plus size={11} /></button>
                          <button onClick={() => handleDeleteTemplate(tpl.id)} className="p-1.5 bg-red-500/10 hover:bg-red-500/30 text-red-400 hover:text-red-300 rounded-lg transition-all" title="Delete template"><Trash2 size={11} /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Unsaved changes confirmation ── */}
      {showUnsavedConfirm && (
        <div className="absolute inset-0 z-[100] bg-black/70 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-[#131326] border border-white/10 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <p className="text-sm font-bold text-white mb-1">Unsaved Changes</p>
            <p className="text-xs text-slate-400 mb-5">You have unsaved changes to "{pres.name}". Save before leaving?</p>
            <div className="flex gap-2">
              <button onClick={handleDiscardChanges} className="flex-1 py-2.5 bg-white/6 hover:bg-red-500/20 text-slate-400 hover:text-red-400 text-[11px] font-bold rounded-lg transition-all">Discard</button>
              <button onClick={() => setShowUnsavedConfirm(false)} className="flex-1 py-2.5 bg-white/8 hover:bg-white/12 text-slate-300 text-[11px] font-bold rounded-lg transition-all">Cancel</button>
              <button onClick={handleSaveAndClose} className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 text-black text-[11px] font-bold rounded-lg transition-all">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showBgPicker && (
        <MediaPickerModal images={mediaImages} onSelect={path => { updateSlide({ ...slide, backgroundImage: relativizePath(path, appDataDir) }); setShowBgPicker(false); }} onClose={() => setShowBgPicker(false)}
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showBgVideoPicker && (
        <MediaPickerModal images={mediaImages} onSelect={handleBgVideoSelect} onClose={() => setShowBgVideoPicker(false)} mode="video"
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Videos", extensions: ["mp4","webm","mov","avi","mkv"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showImgPicker && (
        <MediaPickerModal images={mediaImages} onSelect={handleImageSelect} onClose={() => setShowImgPicker(false)}
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showVideoPicker && (
        <MediaPickerModal images={mediaImages} onSelect={handleVideoSelect} onClose={() => setShowVideoPicker(false)} mode="video"
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Videos", extensions: ["mp4","webm","mov","avi","mkv"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showBiblePicker && (
        <BiblePickerModal onClose={() => setShowBiblePicker(false)}
          onSelect={verse => {
            addEl({ id: stableId(), kind: "text", x: 10, y: 10, w: 80, h: 80, z_index: slide.elements.length + 1, content: `${verse.text}\n\n— ${verse.book} ${verse.chapter}:${verse.verse} (${verse.version})`, font_size: 40, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: true, shadow: true, shadow_color: "#000" });
            setShowBiblePicker(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Micro UI helpers ─────────────────────────────────────────────────────────
function Btn({ onClick, icon, children, className = "" }: { onClick: () => void; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <button onClick={onClick} className={`flex items-center gap-1.5 px-2.5 py-1.5 bg-white/8 hover:bg-white/14 text-slate-300 hover:text-white text-[11px] font-semibold rounded-lg transition-all shrink-0 ${className}`}>{icon}{children}</button>;
}
function ToggleBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return <button onClick={onClick} title={title} className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shrink-0 ${active ? "bg-indigo-500 text-white" : "bg-white/8 text-slate-400 hover:text-white hover:bg-white/14"}`}>{children}</button>;
}
function Div() { return <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />; }
function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="bg-white/4 rounded-xl border border-white/8 p-3 flex flex-col gap-2.5"><p className="text-[8px] font-black uppercase tracking-widest text-slate-600">{label}</p>{children}</div>;
}
function IconBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return <button onClick={onClick} title={title} className="p-2 bg-white/6 hover:bg-white/12 text-slate-400 hover:text-white rounded-lg flex items-center justify-center transition-all">{children}</button>;
}
function TextBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return <button onClick={onClick} title={title} className="p-2 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-white rounded-lg flex items-center justify-center transition-all text-[9px] font-bold">{children}</button>;
}
