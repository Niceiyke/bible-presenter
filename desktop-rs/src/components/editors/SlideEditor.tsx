import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Plus, Trash2, Save, X, ChevronLeft, ChevronRight } from "lucide-react";
import { ZoneEditor } from "./ZoneEditor";
import { CustomSlideRenderer } from "../shared/Renderers";
import { MediaPickerModal } from "../MediaPickerModal";
import { newDefaultSlide } from "../../utils";
import type { CustomPresentation, CustomSlide, MediaItem } from "../../types";

interface SlideEditorProps {
  initialPres: CustomPresentation;
  mediaImages: MediaItem[];
  onClose: (saved: boolean) => void;
}

export function SlideEditor({ initialPres, mediaImages, onClose }: SlideEditorProps) {
  const [pres, setPres] = useState<CustomPresentation>(JSON.parse(JSON.stringify(initialPres)));
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [showBgImagePicker, setShowBgImagePicker] = useState(false);

  const slide = pres.slides[activeSlideIdx] || pres.slides[0];

  const updateSlide = (next: CustomSlide) => {
    const nextSlides = [...pres.slides];
    nextSlides[activeSlideIdx] = next;
    setPres({ ...pres, slides: nextSlides });
  };

  const handleSave = async () => {
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      onClose(true);
    } catch (err) {
      console.error("Save failed", err);
    }
  };

  const handleAddSlide = () => {
    const nextSlides = [...pres.slides];
    nextSlides.splice(activeSlideIdx + 1, 0, { ...newDefaultSlide(), id: crypto.randomUUID() });
    setPres({ ...pres, slides: nextSlides });
    setActiveSlideIdx(activeSlideIdx + 1);
  };

  const handleDeleteSlide = () => {
    if (pres.slides.length <= 1) return;
    const nextSlides = pres.slides.filter((_, i) => i !== activeSlideIdx);
    setPres({ ...pres, slides: nextSlides });
    setActiveSlideIdx(Math.max(0, activeSlideIdx - 1));
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
        updateSlide({ ...slide, backgroundImage: selected });
      } catch (err) {
        console.error("Pick failed", err);
      }
    }
  };

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
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black uppercase text-xs rounded-full transition-all shadow-lg"
          >
            <Save size={16} /> Save Changes
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar: Thumbnails */}
        <aside className="w-64 border-r border-slate-800 bg-slate-900/30 flex flex-col overflow-hidden shrink-0">
          <div className="p-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Slides</span>
            <button onClick={handleAddSlide} className="p-1 hover:bg-slate-800 rounded text-amber-500 transition-all">
              <Plus size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {pres.slides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setActiveSlideIdx(i)}
                className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all shrink-0 ${
                  activeSlideIdx === i ? "border-amber-500 shadow-lg scale-105 z-10" : "border-slate-800 hover:border-slate-600"
                }`}
              >
                <CustomSlideRenderer slide={s} scale={0.06} />
                <div className="absolute bottom-1 left-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold text-white">
                  {i + 1}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Main: Preview & Editor */}
        <div className="flex-1 flex flex-col overflow-hidden bg-black/40">
          {/* Canvas */}
          <div className="flex-1 flex items-center justify-center p-12 overflow-hidden relative">
            <div className="w-full max-w-4xl shadow-2xl ring-1 ring-slate-800 rounded-lg overflow-hidden" style={{ aspectRatio: "16/9" }}>
              <CustomSlideRenderer slide={slide} />
            </div>

            {/* Navigation Overlays */}
            <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col gap-2">
              <button
                disabled={activeSlideIdx === 0}
                onClick={() => setActiveSlideIdx(activeSlideIdx - 1)}
                className="p-3 bg-slate-900/80 hover:bg-slate-800 text-white rounded-full disabled:opacity-20 transition-all"
              >
                <ChevronLeft size={24} />
              </button>
            </div>
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-2">
              <button
                disabled={activeSlideIdx === pres.slides.length - 1}
                onClick={() => setActiveSlideIdx(activeSlideIdx + 1)}
                className="p-3 bg-slate-900/80 hover:bg-slate-800 text-white rounded-full disabled:opacity-20 transition-all"
              >
                <ChevronRight size={24} />
              </button>
            </div>
          </div>

          {/* Editor Panel */}
          <div className="h-80 border-t border-slate-800 bg-slate-900/90 backdrop-blur-md overflow-y-auto p-6 shrink-0">
            <div className="max-w-5xl mx-auto grid grid-cols-2 gap-8">
              {/* Content Column */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Content Editor</h3>
                  <button onClick={handleDeleteSlide} className="text-red-500 hover:text-red-400 transition-all flex items-center gap-1.5 px-2 py-1 rounded hover:bg-red-500/10">
                    <Trash2 size={12} /> <span className="text-[10px] font-bold">Delete Slide</span>
                  </button>
                </div>
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <label className="flex items-center gap-2 cursor-pointer mb-1">
                    <input
                      type="checkbox"
                      checked={slide.headerEnabled !== false}
                      onChange={(e) => updateSlide({ ...slide, headerEnabled: e.target.checked })}
                      className="accent-amber-500"
                    />
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Header Zone</span>
                  </label>
                  {slide.headerEnabled !== false && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-slate-500 shrink-0">Height: {slide.headerHeightPct ?? 35}%</span>
                        <input
                          type="range" min={10} max={60} step={5}
                          value={slide.headerHeightPct ?? 35}
                          onChange={(e) => updateSlide({ ...slide, headerHeightPct: parseInt(e.target.value) })}
                          className="flex-1 accent-amber-500"
                        />
                      </div>
                      <ZoneEditor label="Header text" zone={slide.header} onChange={(z) => updateSlide({ ...slide, header: z })} />
                    </>
                  )}
                </div>
                <ZoneEditor label="Body text" zone={slide.body} onChange={(z) => updateSlide({ ...slide, body: z })} />
              </div>

              {/* Background Column */}
              <div className="flex flex-col gap-4">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 px-1">Visual Settings</h3>
                <div className="flex flex-col gap-4 p-4 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Background Style</p>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={slide.backgroundColor}
                          onChange={(e) => updateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined })}
                          className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
                        />
                        <span className="text-xs text-slate-500 font-mono uppercase">{slide.backgroundColor}</span>
                      </div>
                      <div className="h-8 w-px bg-slate-800" />
                      <button
                        onClick={handlePickBgImage}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg border border-slate-700 transition-all"
                      >
                        {slide.backgroundImage ? "Change Background..." : "Choose Background Image..."}
                      </button>
                    </div>
                    {slide.backgroundImage && (
                      <div className="mt-3 flex items-center justify-between bg-slate-950 p-2 rounded border border-slate-800">
                        <span className="text-[9px] text-slate-500 truncate max-w-[200px]" title={slide.backgroundImage}>
                          {slide.backgroundImage.split(/[/\\]/).pop()}
                        </span>
                        <button onClick={() => updateSlide({ ...slide, backgroundImage: undefined })} className="text-red-500/70 hover:text-red-400 text-[10px] font-bold">Clear</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showBgImagePicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => updateSlide({ ...slide, backgroundImage: path })}
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
    </div>
  );
}
