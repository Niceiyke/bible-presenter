import React, { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Plus, Trash2, Save, X, ChevronLeft, ChevronRight, Type, Image as ImageIcon, Copy, Square, Undo2, Redo2, AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowUp, ArrowDown, MoveUp, MoveDown, BookOpen, Lock, Unlock } from "lucide-react";
import { CustomSlideRenderer } from "../shared/Renderers";
import { MediaPickerModal } from "../MediaPickerModal";
import { newDefaultSlide, newTitleSlide, newBlankSlide, stableId, relativizePath } from "../../utils";
import { useAppStore } from "../../store";
import type { CustomPresentation, CustomSlide, MediaItem, SlideElement } from "../../types";
import { FONTS } from "../../types";

interface SlideEditorProps {
  initialPres: CustomPresentation;
  mediaImages: MediaItem[];
  onClose: (saved: boolean) => void;
}

function migratePresentation(initialPres: CustomPresentation): CustomPresentation {
  if (initialPres.version && initialPres.version >= 1) return initialPres;

  return {
    ...initialPres,
    version: 1,
    slides: initialPres.slides.map(s => {
      if (!s.elements || s.elements.length === 0) {
        const elements: SlideElement[] = [];
        if (s.headerEnabled !== false && s.header) {
          elements.push({
            id: stableId(), kind: "text",
            x: 10, y: 10, w: 80, h: s.headerHeightPct ?? 35, z_index: 1,
            content: s.header.text, font_size: s.header.fontSize, font_family: s.header.fontFamily,
            color: s.header.color, bold: s.header.bold, italic: s.header.italic, align: s.header.align
          });
        }
        if (s.body) {
          elements.push({
            id: stableId(), kind: "text",
            x: 10, y: (s.headerHeightPct ?? 35) + 15, w: 80, h: 40, z_index: 2,
            content: s.body.text, font_size: s.body.fontSize, font_family: s.body.fontFamily,
            color: s.body.color, bold: s.body.bold, italic: s.body.italic, align: s.body.align
          });
        }
        return { ...s, elements };
      }
      return s;
    })
  };
}

export function SlideEditor({ initialPres, mediaImages, onClose }: SlideEditorProps) {
  const { appDataDir, stagedItem } = useAppStore();
  const [pres, _setPres] = useState<CustomPresentation>(() => migratePresentation(JSON.parse(JSON.stringify(initialPres))));
  const [history, setHistory] = useState<CustomPresentation[]>([migratePresentation(JSON.parse(JSON.stringify(initialPres)))]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  const [showBgImagePicker, setShowBgImagePicker] = useState(false);
  const [showElementImagePicker, setShowElementImagePicker] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasScale, setCanvasScale] = useState(1);

  // Calculate scale based on canvas height vs 1080p reference
  useEffect(() => {
    const updateScale = () => {
      if (canvasRef.current) {
        const height = canvasRef.current.clientHeight;
        setCanvasScale(height / 1080);
      }
    };

    updateScale();
    window.addEventListener("resize", updateScale);
    // Also update after a short delay to account for sidebar animations or layout shifts
    const timer = setTimeout(updateScale, 100);
    return () => {
      window.removeEventListener("resize", updateScale);
      clearTimeout(timer);
    };
  }, [pres.slides.length]); // Re-run when slides change as it might affect layout

  const slide = pres.slides[activeSlideIdx] || pres.slides[0];

  // History management
  const setPres = useCallback((next: CustomPresentation | ((prev: CustomPresentation) => CustomPresentation), saveToHistory = true) => {
    _setPres(prev => {
      const resolvedNext = typeof next === "function" ? next(prev) : next;
      if (saveToHistory) {
        const nextHistory = history.slice(0, historyIndex + 1);
        nextHistory.push(JSON.parse(JSON.stringify(resolvedNext)));
        // Limit history to 50 steps
        if (nextHistory.length > 50) nextHistory.shift();
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
      }
      return resolvedNext;
    });
  }, [history, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const nextIdx = historyIndex - 1;
      const prevPres = JSON.parse(JSON.stringify(history[nextIdx]));
      _setPres(prevPres);
      setHistoryIndex(nextIdx);
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextIdx = historyIndex + 1;
      const nextPres = JSON.parse(JSON.stringify(history[nextIdx]));
      _setPres(nextPres);
      setHistoryIndex(nextIdx);
    }
  }, [history, historyIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (activeElementId && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
          deleteElement(activeElementId);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        if (activeElementId) {
          e.preventDefault();
          const el = slide.elements.find(x => x.id === activeElementId);
          if (el) duplicateElement(el);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, activeElementId, slide.elements]);

  const updateSlide = (next: CustomSlide) => {
    setPres(prev => {
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = next;
      return { ...prev, slides: nextSlides };
    });
  };

  const updateElement = (id: string, updates: Partial<SlideElement>, saveToHistory = true) => {
    setPres(prev => {
      const currentSlide = prev.slides[activeSlideIdx];
      const nextElements = currentSlide.elements.map(e => e.id === id ? { ...e, ...updates } : e);
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = { ...currentSlide, elements: nextElements };
      return { ...prev, slides: nextSlides };
    }, saveToHistory);
  };

  const deleteElement = (id: string) => {
    setPres(prev => {
      const currentSlide = prev.slides[activeSlideIdx];
      const nextElements = currentSlide.elements.filter(e => e.id !== id);
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = { ...currentSlide, elements: nextElements };
      return { ...prev, slides: nextSlides };
    });
    if (activeElementId === id) setActiveElementId(null);
  };

  const duplicateElement = (el: SlideElement) => {
    const newEl = { ...el, id: stableId(), x: el.x + 5, y: el.y + 5, z_index: slide.elements.length + 1 };
    setPres(prev => {
      const currentSlide = prev.slides[activeSlideIdx];
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = { ...currentSlide, elements: [...currentSlide.elements, newEl] };
      return { ...prev, slides: nextSlides };
    });
    setActiveElementId(newEl.id);
  };

  const handleSave = async () => {
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      onClose(true);
    } catch (err) {
      console.error("Save failed", err);
    }
  };

  const handleAddSlide = (type: "default" | "title" | "blank") => {
    setPres(prev => {
      const nextSlides = [...prev.slides];
      const newSlide = type === "title" ? newTitleSlide() : type === "blank" ? newBlankSlide() : newDefaultSlide();
      nextSlides.splice(activeSlideIdx + 1, 0, newSlide);
      return { ...prev, slides: nextSlides };
    });
    setActiveSlideIdx(activeSlideIdx + 1);
    setActiveElementId(null);
  };

  const handleDuplicateSlide = () => {
    setPres(prev => {
      const nextSlides = [...prev.slides];
      const newSlide = JSON.parse(JSON.stringify(nextSlides[activeSlideIdx]));
      newSlide.id = stableId();
      newSlide.elements.forEach((e: SlideElement) => e.id = stableId());
      nextSlides.splice(activeSlideIdx + 1, 0, newSlide);
      return { ...prev, slides: nextSlides };
    });
    setActiveSlideIdx(activeSlideIdx + 1);
    setActiveElementId(null);
  };

  const handleDeleteSlide = () => {
    if (pres.slides.length <= 1) return;
    setPres(prev => {
      const nextSlides = prev.slides.filter((_, i) => i !== activeSlideIdx);
      return { ...prev, slides: nextSlides };
    });
    setActiveSlideIdx(Math.max(0, activeSlideIdx - 1));
    setActiveElementId(null);
  };

  const addTextElement = () => {
    const newEl: SlideElement = {
      id: stableId(), kind: "text",
      x: 10, y: 10, w: 80, h: 20, z_index: slide.elements.length + 1,
      content: "New Text", font_size: 32, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: false
    };
    setPres(prev => {
      const currentSlide = prev.slides[activeSlideIdx];
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = { ...currentSlide, elements: [...currentSlide.elements, newEl] };
      return { ...prev, slides: nextSlides };
    });
    setActiveElementId(newEl.id);
  };

  const addShapeElement = () => {
    const newEl: SlideElement = {
      id: stableId(), kind: "shape",
      x: 30, y: 30, w: 40, h: 40, z_index: slide.elements.length + 1,
      content: "", color: "#3b82f6", opacity: 1
    };
    setPres(prev => {
      const currentSlide = prev.slides[activeSlideIdx];
      const nextSlides = [...prev.slides];
      nextSlides[activeSlideIdx] = { ...currentSlide, elements: [...currentSlide.elements, newEl] };
      return { ...prev, slides: nextSlides };
    });
    setActiveElementId(newEl.id);
  };

  const alignElement = (type: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (!activeElementId) return;
    const el = slide.elements.find(e => e.id === activeElementId);
    if (!el) return;

    let updates: Partial<SlideElement> = {};
    if (type === "left") updates.x = 0;
    if (type === "right") updates.x = 100 - el.w;
    if (type === "center") updates.x = (100 - el.w) / 2;
    if (type === "top") updates.y = 0;
    if (type === "bottom") updates.y = 100 - el.h;
    if (type === "middle") updates.y = (100 - el.h) / 2;

    updateElement(activeElementId, updates);
  };

  const updateZOrder = (dir: "forward" | "backward" | "front" | "back") => {
    if (!activeElementId) return;
    const elements = [...slide.elements].sort((a, b) => a.z_index - b.z_index);
    const idx = elements.findIndex(e => e.id === activeElementId);
    if (idx === -1) return;

    if (dir === "forward" && idx < elements.length - 1) {
      const temp = elements[idx].z_index;
      elements[idx].z_index = elements[idx+1].z_index;
      elements[idx+1].z_index = temp;
    } else if (dir === "backward" && idx > 0) {
      const temp = elements[idx].z_index;
      elements[idx].z_index = elements[idx-1].z_index;
      elements[idx-1].z_index = temp;
    } else if (dir === "front") {
      const maxZ = Math.max(...elements.map(e => e.z_index), 0);
      elements[idx].z_index = maxZ + 1;
    } else if (dir === "back") {
      const minZ = Math.min(...elements.map(e => e.z_index), 0);
      elements[idx].z_index = minZ - 1;
    }

    updateSlide({ ...slide, elements });
  };

  const handlePickBgImage = async () => {
    if (mediaImages.length > 0) {
      setShowBgImagePicker(true);
    } else {
      try {
        const selected = await openDialog({
          multiple: false,
          filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
        });
        if (typeof selected !== "string") return;
        const rel = relativizePath(selected, appDataDir);
        updateSlide({ ...slide, backgroundImage: rel });
      } catch (err) {
        console.error("Pick failed", err);
      }
    }
  };

  const handleElementDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setActiveElementId(id);

    const el = slide.elements.find(x => x.id === id);
    if (!el || !canvasRef.current || el.locked) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const initialElX = el.x;
    const initialElY = el.y;
    const canvasRect = canvasRef.current.getBoundingClientRect();

    let lastX = initialElX;
    let lastY = initialElY;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      
      const dxPct = (dx / canvasRect.width) * 100;
      const dyPct = (dy / canvasRect.height) * 100;

      lastX = initialElX + dxPct;
      lastY = initialElY + dyPct;

      updateElement(id, { x: lastX, y: lastY }, false);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      updateElement(id, { x: lastX, y: lastY }, true);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleResize = (id: string, e: React.PointerEvent, handle: string) => {
    e.stopPropagation();
    e.preventDefault();
    const el = slide.elements.find(x => x.id === id);
    if (!el || !canvasRef.current || el.locked) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = el.x;
    const initialY = el.y;
    const initialW = el.w;
    const initialH = el.h;
    const canvasRect = canvasRef.current.getBoundingClientRect();

    let lastX = el.x;
    let lastY = el.y;
    let lastW = el.w;
    let lastH = el.h;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / canvasRect.width) * 100;
      const dy = ((moveEvent.clientY - startY) / canvasRect.height) * 100;

      let nextX = initialX;
      let nextY = initialY;
      let nextW = initialW;
      let nextH = initialH;

      if (handle.includes("e")) nextW = Math.max(1, initialW + dx);
      if (handle.includes("s")) nextH = Math.max(1, initialH + dy);
      if (handle.includes("w")) {
        const delta = Math.min(initialW - 1, dx);
        nextX = initialX + delta;
        nextW = initialW - delta;
      }
      if (handle.includes("n")) {
        const delta = Math.min(initialH - 1, dy);
        nextY = initialY + delta;
        nextH = initialH - delta;
      }

      lastX = nextX; lastY = nextY; lastW = nextW; lastH = nextH;
      updateElement(id, { x: nextX, y: nextY, w: nextW, h: nextH }, false);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      updateElement(id, { x: lastX, y: lastY, w: lastW, h: lastH }, true);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeElement = slide.elements.find(e => e.id === activeElementId);

  return (
    <div className="fixed inset-0 z-[60] bg-slate-950 flex flex-col font-sans">
      {/* Top Bar */}
      <header className="flex items-center gap-4 px-6 py-3 border-b border-slate-800 bg-slate-900/80 shrink-0">
        <button onClick={() => onClose(false)} className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-all">
          <X size={20} />
        </button>
        <div className="h-6 w-px bg-slate-800" />
        <input
          value={pres.name}
          onChange={(e) => setPres({ ...pres, name: e.target.value })}
          className="bg-transparent text-xl font-bold text-white focus:outline-none focus:ring-b-2 focus:ring-amber-500 min-w-0 flex-1"
          placeholder="Presentation Title"
        />
        
        <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
          <button
            onClick={undo}
            disabled={historyIndex === 0}
            className="p-1.5 text-slate-400 hover:text-white disabled:opacity-20 transition-all"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 size={18} />
          </button>
          <button
            onClick={redo}
            disabled={historyIndex === history.length - 1}
            className="p-1.5 text-slate-400 hover:text-white disabled:opacity-20 transition-all"
            title="Redo (Ctrl+Y)"
          >
            <Redo2 size={18} />
          </button>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black uppercase text-xs rounded-full transition-all shadow-lg"
          >
            <Save size={16} /> Save
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar: Thumbnails */}
        <aside className="w-64 border-r border-slate-800 bg-slate-900/30 flex flex-col overflow-hidden shrink-0">
          <div className="p-3 border-b border-slate-800 flex flex-col gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Slides</span>
            <div className="flex items-center gap-1">
              <button onClick={() => handleAddSlide("title")} className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-bold rounded transition-all">
                + Title
              </button>
              <button onClick={() => handleAddSlide("default")} className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-bold rounded transition-all">
                + Body
              </button>
              <button onClick={() => handleAddSlide("blank")} className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-bold rounded transition-all">
                + Blank
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {pres.slides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => { setActiveSlideIdx(i); setActiveElementId(null); }}
                className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all shrink-0 ${
                  activeSlideIdx === i ? "border-amber-500 shadow-lg scale-105 z-10" : "border-slate-800 hover:border-slate-600"
                }`}
              >
                <CustomSlideRenderer slide={s} scale={0.06} appDataDir={appDataDir} />
                <div className="absolute bottom-1 left-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold text-white">
                  {i + 1}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Main: Preview & Editor */}
        <div className="flex-1 flex flex-col overflow-hidden bg-black/40">
          
          {/* Toolbar */}
          <div className="h-12 border-b border-slate-800 flex items-center justify-center gap-4 bg-slate-900/50">
            <button onClick={addTextElement} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded">
              <Type size={14} /> Add Text
            </button>
            <button onClick={() => setShowElementImagePicker(true)} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded">
              <ImageIcon size={14} /> Add Image
            </button>
            <button onClick={addShapeElement} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded">
              <Square size={14} /> Add Shape
            </button>
            {stagedItem?.type === "Verse" && (
              <button onClick={() => {
                const verse = stagedItem.data;
                const newEl: SlideElement = {
                  id: stableId(), kind: "text",
                  x: 10, y: 10, w: 80, h: 80, z_index: slide.elements.length + 1,
                  content: `${verse.text}\n— ${verse.book} ${verse.chapter}:${verse.verse}`, font_size: 40, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: true
                };
                setPres(prev => {
                  const currentSlide = prev.slides[activeSlideIdx];
                  const nextSlides = [...prev.slides];
                  nextSlides[activeSlideIdx] = { ...currentSlide, elements: [...currentSlide.elements, newEl] };
                  return { ...prev, slides: nextSlides };
                });
                setActiveElementId(newEl.id);
              }} className="flex items-center gap-2 px-3 py-1.5 bg-indigo-900/50 hover:bg-indigo-800 text-indigo-300 text-xs font-bold rounded">
                <BookOpen size={14} /> Insert Verse
              </button>
            )}
            <div className="w-px h-6 bg-slate-700 mx-2" />
            <button onClick={handleDuplicateSlide} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded">
              <Copy size={14} /> Duplicate Slide
            </button>
            <button onClick={handleDeleteSlide} className="flex items-center gap-2 px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 text-xs font-bold rounded">
              <Trash2 size={14} /> Delete Slide
            </button>
          </div>

          {/* Canvas Area */}
          <div className="flex-1 flex items-center justify-center p-8 overflow-hidden relative" onPointerDown={() => setActiveElementId(null)}>
            <div 
              ref={canvasRef}
              className="w-full max-w-5xl shadow-2xl ring-1 ring-slate-700 relative select-none" 
              style={{ aspectRatio: "16/9", backgroundColor: slide.backgroundColor }}
            >
              <CustomSlideRenderer slide={slide} scale={canvasScale} appDataDir={appDataDir} />
              
              {/* Interactive Overlay */}
              <div className="absolute inset-0 z-50 pointer-events-none">
                {slide.elements.map(el => {
                  const isActive = activeElementId === el.id;
                  return (
                    <div
                      key={el.id}
                      onPointerDown={(e) => handleElementDrag(el.id, e)}
                      className={`absolute pointer-events-auto cursor-move border-2 ${isActive ? 'border-amber-500 bg-amber-500/5' : 'border-transparent hover:border-slate-500/50'}`}
                      style={{ left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`, zIndex: el.z_index }}
                    >
                      {isActive && (
                        <>
                          {/* Resize Handles */}
                          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map(h => (
                            <div
                              key={h}
                              onPointerDown={(e) => handleResize(el.id, e, h)}
                              className={`absolute w-2.5 h-2.5 bg-white border border-amber-500 rounded-full shadow-md z-[60] 
                                ${h.includes("n") ? "-top-1.5" : h.includes("s") ? "-bottom-1.5" : "top-1/2 -translate-y-1/2"}
                                ${h.includes("w") ? "-left-1.5" : h.includes("e") ? "-right-1.5" : "left-1/2 -translate-x-1/2"}
                                ${h === "nw" || h === "se" ? "cursor-nwse-resize" : h === "ne" || h === "sw" ? "cursor-nesw-resize" : h === "n" || h === "s" ? "cursor-ns-resize" : "cursor-ew-resize"}
                              `}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Navigation Overlays */}
            <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-[70]">
              <button
                disabled={activeSlideIdx === 0}
                onClick={(e) => { e.stopPropagation(); setActiveSlideIdx(activeSlideIdx - 1); setActiveElementId(null); }}
                className="p-3 bg-slate-900/80 hover:bg-slate-800 text-white rounded-full disabled:opacity-20 transition-all"
              >
                <ChevronLeft size={24} />
              </button>
            </div>
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-[70]">
              <button
                disabled={activeSlideIdx === pres.slides.length - 1}
                onClick={(e) => { e.stopPropagation(); setActiveSlideIdx(activeSlideIdx + 1); setActiveElementId(null); }}
                className="p-3 bg-slate-900/80 hover:bg-slate-800 text-white rounded-full disabled:opacity-20 transition-all"
              >
                <ChevronRight size={24} />
              </button>
            </div>
          </div>
        </div>

        {/* Properties Panel */}
        <aside className="w-80 border-l border-slate-800 bg-slate-900/90 flex flex-col overflow-hidden shrink-0">
          <div className="p-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Properties</span>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6">
            {!activeElement && (
              <div className="flex flex-col gap-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Slide Background</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={slide.backgroundColor}
                    onChange={(e) => updateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined })}
                    className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
                  />
                  <span className="text-xs text-slate-500 font-mono uppercase">{slide.backgroundColor}</span>
                </div>
                <button
                  onClick={handlePickBgImage}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded border border-slate-700 transition-all"
                >
                  {slide.backgroundImage ? "Change Background..." : "Choose Image..."}
                </button>
                {slide.backgroundImage && (
                  <div className="flex items-center justify-between bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-[9px] text-slate-500 truncate max-w-[200px]">{slide.backgroundImage.split(/[/\\]/).pop()}</span>
                    <button onClick={() => updateSlide({ ...slide, backgroundImage: undefined })} className="text-red-500 hover:text-red-400 text-[10px] font-bold">Clear</button>
                  </div>
                )}
              </div>
            )}

            {activeElement && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-amber-500 uppercase tracking-widest">Edit Element</h3>
                  <div className="flex gap-1">
                    <button onClick={() => updateElement(activeElement.id, { locked: !activeElement.locked })} className={`p-1.5 rounded ${activeElement.locked ? "bg-amber-500/20 text-amber-400" : "bg-slate-800 hover:bg-slate-700 text-slate-400"}`} title={activeElement.locked ? "Unlock Element" : "Lock Element"}>
                      {activeElement.locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                    <button onClick={() => duplicateElement(activeElement)} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded" title="Duplicate"><Copy size={12} /></button>
                    <button onClick={() => deleteElement(activeElement.id)} className="p-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded" title="Delete"><Trash2 size={12} /></button>
                  </div>
                </div>

                {/* Position & Size */}
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">X (%)</span>
                      <input type="number" value={Math.round(activeElement.x)} onChange={e => updateElement(activeElement.id, { x: Number(e.target.value) })} className="bg-slate-950 border border-slate-700 rounded p-1 text-xs text-white" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">Y (%)</span>
                      <input type="number" value={Math.round(activeElement.y)} onChange={e => updateElement(activeElement.id, { y: Number(e.target.value) })} className="bg-slate-950 border border-slate-700 rounded p-1 text-xs text-white" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">W (%)</span>
                      <input type="number" value={Math.round(activeElement.w)} onChange={e => updateElement(activeElement.id, { w: Number(e.target.value) })} className="bg-slate-950 border border-slate-700 rounded p-1 text-xs text-white" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">H (%)</span>
                      <input type="number" value={Math.round(activeElement.h)} onChange={e => updateElement(activeElement.id, { h: Number(e.target.value) })} className="bg-slate-950 border border-slate-700 rounded p-1 text-xs text-white" />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[9px] text-slate-500 uppercase font-bold">Alignment</span>
                    <div className="grid grid-cols-3 gap-1">
                      <button onClick={() => alignElement("left")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Align Left"><AlignLeft size={14} /></button>
                      <button onClick={() => alignElement("center")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Center Horizontal"><AlignCenter size={14} /></button>
                      <button onClick={() => alignElement("right")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Align Right"><AlignRight size={14} /></button>
                      <button onClick={() => alignElement("top")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Align Top" style={{ transform: 'rotate(90deg)' }}><AlignRight size={14} /></button>
                      <button onClick={() => alignElement("middle")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Center Vertical" style={{ transform: 'rotate(90deg)' }}><AlignCenter size={14} /></button>
                      <button onClick={() => alignElement("bottom")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Align Bottom" style={{ transform: 'rotate(90deg)' }}><AlignLeft size={14} /></button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[9px] text-slate-500 uppercase font-bold">Z-Order</span>
                    <div className="grid grid-cols-4 gap-1">
                      <button onClick={() => updateZOrder("back")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Send to Back"><MoveDown size={14} /></button>
                      <button onClick={() => updateZOrder("backward")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Send Backward"><ArrowDown size={14} /></button>
                      <button onClick={() => updateZOrder("forward")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Bring Forward"><ArrowUp size={14} /></button>
                      <button onClick={() => updateZOrder("front")} className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded flex items-center justify-center" title="Bring to Front"><MoveUp size={14} /></button>
                    </div>
                  </div>
                </div>

                {/* Text Content */}
                {activeElement.kind === "text" && (
                  <div className="flex flex-col gap-3 pt-3 border-t border-slate-800">
                    <textarea
                      value={activeElement.content}
                      onChange={e => updateElement(activeElement.id, { content: e.target.value })}
                      rows={4}
                      className="bg-slate-950 border border-slate-700 rounded p-2 text-sm text-white resize-none"
                      placeholder="Enter text..."
                    />
                    
                    <div className="flex flex-col gap-2">
                      <select value={activeElement.font_family} onChange={e => updateElement(activeElement.id, { font_family: e.target.value })} className="bg-slate-950 border border-slate-700 rounded p-1.5 text-xs text-white">
                        {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                      
                      <div className="flex items-center gap-2">
                        <div className="flex flex-1 items-center bg-slate-950 border border-slate-700 rounded px-2">
                          <span className="text-[10px] text-slate-500">Size</span>
                          <input type="number" value={activeElement.font_size} onChange={e => updateElement(activeElement.id, { font_size: Number(e.target.value) })} className="bg-transparent w-full p-1 text-xs text-white text-right outline-none" />
                        </div>
                        <input type="color" value={activeElement.color} onChange={e => updateElement(activeElement.id, { color: e.target.value })} className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent shrink-0" />
                      </div>

                      <div className="flex gap-2">
                        <div className="flex flex-col gap-1.5 flex-1">
                          <span className="text-[8px] text-slate-500 uppercase font-black">H-Align</span>
                          <div className="flex bg-slate-950 border border-slate-700 rounded overflow-hidden">
                            {(["left", "center", "right"] as const).map((a) => (
                              <button key={a} onClick={() => updateElement(activeElement.id, { align: a })} className={`flex-1 px-2 py-1 text-[10px] font-bold ${activeElement.align === a ? "bg-amber-500 text-black" : "text-slate-400 hover:text-white"}`}>{a.charAt(0).toUpperCase()}</button>
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5 flex-1">
                          <span className="text-[8px] text-slate-500 uppercase font-black">V-Align</span>
                          <div className="flex bg-slate-950 border border-slate-700 rounded overflow-hidden">
                            {(["top", "middle", "bottom"] as const).map((a) => (
                              <button key={a} onClick={() => updateElement(activeElement.id, { v_align: a })} className={`flex-1 px-2 py-1 text-[10px] font-bold ${(activeElement.v_align === a || (!activeElement.v_align && a === 'top')) ? "bg-amber-500 text-black" : "text-slate-400 hover:text-white"}`}>{a.charAt(0).toUpperCase()}</button>
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[8px] text-slate-500 uppercase font-black">Style</span>
                          <div className="flex bg-slate-950 border border-slate-700 rounded overflow-hidden">
                            <button onClick={() => updateElement(activeElement.id, { bold: !activeElement.bold })} className={`px-2 py-1 text-[10px] font-bold ${activeElement.bold ? "bg-amber-500 text-black" : "text-slate-400"}`}>B</button>
                            <button onClick={() => updateElement(activeElement.id, { italic: !activeElement.italic })} className={`px-2 py-1 text-[10px] font-serif italic ${activeElement.italic ? "bg-amber-500 text-black" : "text-slate-400"}`}>I</button>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 mt-1">
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                          <input type="checkbox" checked={activeElement.shadow !== false} onChange={e => updateElement(activeElement.id, { shadow: e.target.checked })} className="accent-amber-500" />
                          Drop Shadow
                        </label>
                        {activeElement.shadow !== false && (
                          <input type="color" value={activeElement.shadow_color || "#000000"} onChange={e => updateElement(activeElement.id, { shadow_color: e.target.value })} className="w-6 h-6 rounded cursor-pointer border border-slate-700 bg-transparent shrink-0 ml-auto" />
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Shape Content */}
                {activeElement.kind === "shape" && (
                  <div className="flex flex-col gap-3 pt-3 border-t border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">Color</span>
                      <input type="color" value={activeElement.color} onChange={e => updateElement(activeElement.id, { color: e.target.value })} className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent shrink-0" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 w-12">Opacity</span>
                      <input type="range" min={0} max={1} step={0.1} value={activeElement.opacity ?? 1} onChange={e => updateElement(activeElement.id, { opacity: Number(e.target.value) })} className="flex-1 accent-amber-500" />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {showBgImagePicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => {
            const rel = relativizePath(path, appDataDir);
            updateSlide({ ...slide, backgroundImage: rel });
            setShowBgImagePicker(false);
          }}
          onClose={() => setShowBgImagePicker(false)}
          onUpload={async () => {
            try {
              const selected = await openDialog({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
              });
              if (typeof selected !== "string") return;
              await invoke("add_media", { path: selected });
            } catch (err) {
              console.error("Upload failed", err);
            }
          }}
        />
      )}

      {showElementImagePicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => {
            const rel = relativizePath(path, appDataDir);
            const newEl: SlideElement = {
              id: stableId(), kind: "image",
              x: 20, y: 20, w: 60, h: 60, z_index: slide.elements.length + 1,
              content: rel
            };
            setPres(prev => {
              const currentSlide = prev.slides[activeSlideIdx];
              const nextSlides = [...prev.slides];
              nextSlides[activeSlideIdx] = { ...currentSlide, elements: [...currentSlide.elements, newEl] };
              return { ...prev, slides: nextSlides };
            });
            setActiveElementId(newEl.id);
            setShowElementImagePicker(false);
          }}
          onClose={() => setShowElementImagePicker(false)}
          onUpload={async () => {
            try {
              const selected = await openDialog({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
              });
              if (typeof selected !== "string") return;
              await invoke("add_media", { path: selected });
            } catch (err) {
              console.error("Upload failed", err);
            }
          }}
        />
      )}
    </div>
  );
}
