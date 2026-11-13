import React, { useMemo, useState } from "react";
import { ChevronLeft, ListTree, Plus, X } from "lucide-react";
import type { CustomSlide } from "../../../types";
import { slideLabel } from "../../../presentations/editorFeatures";

export function PresentationOutlinePanel({ slides, activeSlideIdx, onSelect, onSetSection, onClose }: {
  slides: CustomSlide[];
  activeSlideIdx: number;
  onSelect: (index: number) => void;
  onSetSection: (index: number, section?: string) => void;
  onClose: () => void;
}) {
  const [newSection, setNewSection] = useState("");
  const sections = useMemo(() => {
    const ordered: Array<{ name: string; slides: Array<{ slide: CustomSlide; index: number }> }> = [];
    slides.forEach((slide, index) => {
      const name = slide.section?.trim() || "Ungrouped";
      let section = ordered.find((item) => item.name === name);
      if (!section) { section = { name, slides: [] }; ordered.push(section); }
      section.slides.push({ slide, index });
    });
    return ordered;
  }, [slides]);

  const assign = () => {
    const name = newSection.trim();
    if (!name) return;
    onSetSection(activeSlideIdx, name);
    setNewSection("");
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-console-border bg-console-surface shadow-xl shadow-black/10">
      <header className="flex items-center gap-2 border-b border-console-border bg-gradient-to-r from-tool-design/15 to-transparent p-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-tool-design/15 text-tool-design"><ListTree size={14} /></span>
        <div className="flex-1"><p className="text-[10px] font-black uppercase tracking-wider text-console-text">Outline</p><p className="text-[8px] text-console-text-subtle">{sections.length} sections · {slides.length} slides</p></div>
        <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-console-text-muted hover:bg-console-surface-strong" aria-label="Close outline"><ChevronLeft size={15} /></button>
      </header>

      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-3">
        {sections.map((section) => (
          <section key={section.name}>
            <div className="mb-1.5 flex items-center gap-2 px-1">
              <span className="h-1.5 w-1.5 rounded-full bg-tool-design" />
              <h3 className="flex-1 truncate text-[9px] font-black uppercase tracking-[0.12em] text-console-text-muted">{section.name}</h3>
              <span className="text-[8px] text-console-text-subtle">{section.slides.length}</span>
            </div>
            <div className="space-y-1">
              {section.slides.map(({ slide, index }) => (
                <div key={slide.id} className={`group flex items-start rounded-xl border transition-colors ${index === activeSlideIdx ? "border-tool-design/50 bg-tool-design/15" : "border-transparent bg-console-canvas/35 hover:border-console-border hover:bg-console-surface-raised"}`}>
                  <button onClick={() => onSelect(index)} className="flex min-w-0 flex-1 items-start gap-2 p-2 text-left">
                    <span className={`flex h-6 min-w-6 items-center justify-center rounded-md text-[8px] font-black ${index === activeSlideIdx ? "bg-tool-design text-console-canvas" : "bg-console-surface-strong text-console-text-subtle"}`}>{index + 1}</span>
                    <span className="line-clamp-2 flex-1 text-[10px] font-semibold leading-relaxed text-console-text">{slideLabel(slide, index)}</span>
                  </button>
                  {slide.section && <button onClick={() => onSetSection(index, undefined)} className="mr-1 mt-1.5 hidden p-1 text-console-text-subtle hover:text-state-live group-hover:block group-focus-within:block" aria-label="Remove from section"><X size={11} /></button>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="border-t border-console-border p-3">
        <p className="mb-1.5 text-[8px] font-black uppercase tracking-wider text-console-text-subtle">Section current slide</p>
        <div className="flex gap-1.5">
          <input value={newSection} onChange={(event) => setNewSection(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") assign(); }} placeholder="e.g. Point One" className="min-w-0 flex-1 rounded-lg border border-console-border bg-console-canvas px-2 text-[10px] text-console-text outline-none focus:border-tool-design/60" />
          <button onClick={assign} disabled={!newSection.trim()} className="flex h-9 w-9 items-center justify-center rounded-lg bg-tool-design text-console-canvas disabled:opacity-30" aria-label="Add section"><Plus size={13} /></button>
        </div>
      </div>
    </aside>
  );
}
