import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Edit2, Play, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { useAppStore } from "../store";
import { SlideThumbnail } from "./shared/Renderers";
import type { CustomPresentation, CustomSlide, CustomSlideDisplayData, DisplayItem } from "../types";

interface StudioTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onOpenEditor: (id: string) => void;
  onNewPresentation: () => void;
}

export function StudioTab({ onStage, onLive, onOpenEditor, onNewPresentation }: StudioTabProps) {
  const {
    studioList, setStudioList,
    expandedStudioPresId, setExpandedStudioPresId,
    studioSlides, setStudioSlides,
  } = useAppStore();

  const handlePresentStudio = async (id: string) => {
    if (expandedStudioPresId === id) {
      setExpandedStudioPresId(null);
      return;
    }
    if (!studioSlides[id]) {
      try {
        const data: any = await invoke("load_studio_presentation", { id });
        const pres = data as CustomPresentation;
        setStudioSlides({ ...studioSlides, [id]: pres.slides });
      } catch (err) {
        console.error("Failed to load slides:", err);
        return;
      }
    }
    setExpandedStudioPresId(id);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this presentation?")) return;
    try {
      await invoke("delete_studio_presentation", { id });
      setStudioList(studioList.filter((p) => p.id !== id));
      if (expandedStudioPresId === id) setExpandedStudioPresId(null);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const buildCustomSlideItem = (presItem: { id: string; name: string; slide_count: number }, slides: CustomSlide[], slideIdx: number): DisplayItem => {
    const slide = slides[slideIdx];
    return {
      type: "CustomSlide",
      data: {
        presentation_id: presItem.id,
        presentation_name: presItem.name,
        slide_index: slideIdx,
        slide_count: slides.length,
        background_color: slide.backgroundColor,
        background_image: slide.backgroundImage,
        header_enabled: slide.headerEnabled ?? true,
        header_height_pct: slide.headerHeightPct ?? 35,
        header: { text: slide.header.text, font_size: slide.header.fontSize, font_family: slide.header.fontFamily, color: slide.header.color, bold: slide.header.bold, italic: slide.header.italic, align: slide.header.align },
        body:   { text: slide.body.text,   font_size: slide.body.fontSize,   font_family: slide.body.fontFamily,   color: slide.body.color,   bold: slide.body.bold,   italic: slide.body.italic,   align: slide.body.align },
      } as CustomSlideDisplayData,
    };
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Studio Presentations</h2>
        <button
          onClick={onNewPresentation}
          className="text-[10px] bg-purple-600 hover:bg-purple-500 text-white font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1.5"
        >
          <Plus size={11} /> CREATE
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {studioList.map((pres) => (
          <div key={pres.id} className="flex flex-col bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 p-3">
              <div className="w-8 h-8 bg-purple-900/30 rounded flex items-center justify-center text-purple-400 font-bold text-xs shrink-0">
                BP
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-200 truncate">{pres.name}</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{pres.slide_count} slides</p>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => handlePresentStudio(pres.id)}
                  className={`p-1.5 rounded transition-all ${expandedStudioPresId === pres.id ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
                  title="Present"
                >
                  {expandedStudioPresId === pres.id ? <ChevronUp size={14} /> : <Play size={14} />}
                </button>
                <button
                  onClick={() => onOpenEditor(pres.id)}
                  className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded transition-all"
                  title="Edit"
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => handleDelete(pres.id)}
                  className="p-1.5 bg-slate-800 hover:bg-red-900 text-slate-400 hover:text-red-400 rounded transition-all"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {expandedStudioPresId === pres.id && studioSlides[pres.id] && (
              <div className="p-3 bg-black/20 border-t border-slate-800">
                <div className="grid grid-cols-2 gap-2">
                  {studioSlides[pres.id].map((slide, idx) => (
                    <SlideThumbnail
                      key={slide.id}
                      slide={slide}
                      index={idx}
                      onStage={() => onStage(buildCustomSlideItem(pres, studioSlides[pres.id], idx))}
                      onLive={() => onLive(buildCustomSlideItem(pres, studioSlides[pres.id], idx))}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {studioList.length === 0 && (
          <p className="text-slate-700 text-xs italic text-center py-8">
            No presentations yet. Click CREATE to start.
          </p>
        )}
      </div>
    </div>
  );
}
