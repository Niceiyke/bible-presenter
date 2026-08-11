/**
 * SlideEditorModals — template gallery, unsaved-changes confirmation, and
 * the media / background / bible pickers for the slide editor (P1.4).
 * Pure presentation: all handlers are passed in from the controller hook.
 */

import React, { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Trash2, X, Plus, Layers } from "lucide-react";
import { SlideThumbnail } from "./SlideThumbnail";
import { MediaPickerModal } from "../../MediaPickerModal";
import { BiblePickerModal } from "../../BiblePickerModal";
import { BUILTIN_DECKS, stableId } from "../../../utils";
import type { CustomPresentation, CustomSlide, MediaItem, SlideTemplate } from "../../../types";

export interface SlideEditorModalsProps {
  pres: CustomPresentation;
  slide: CustomSlide;
  media: MediaItem[];
  mediaImages: MediaItem[];
  appDataDir: string | null;
  templates: SlideTemplate[];
  showTemplateGallery: boolean;
  setShowTemplateGallery: (v: boolean) => void;
  showUnsavedConfirm: boolean;
  setShowUnsavedConfirm: (v: boolean) => void;
  /** True while a save is in flight; the close/discard flow waits for it. */
  saving?: boolean;
  showBgPicker: boolean;
  setShowBgPicker: (v: boolean) => void;
  showBgVideoPicker: boolean;
  setShowBgVideoPicker: (v: boolean) => void;
  showImgPicker: boolean;
  setShowImgPicker: (v: boolean) => void;
  showVideoPicker: boolean;
  setShowVideoPicker: (v: boolean) => void;
  showBiblePicker: boolean;
  setShowBiblePicker: (v: boolean) => void;
  onInsertTemplate: (tpl: SlideTemplate) => void;
  onDeleteTemplate: (id: string) => void;
  onDiscardChanges: () => void;
  onSaveAndClose: () => void;
  onBgImageSelect: (path: string) => void;
  onBgVideoSelect: (path: string) => void;
  onImageSelect: (path: string) => void;
  onVideoSelect: (path: string) => void;
  onAddVerse: (verse: { text: string; book: string; chapter: number; verse: number; version: string }) => void;
}

export function SlideEditorModals({
  pres,
  slide,
  media,
  mediaImages,
  appDataDir,
  templates,
  showTemplateGallery,
  setShowTemplateGallery,
  showUnsavedConfirm,
  setShowUnsavedConfirm,
  saving = false,
  showBgPicker,
  setShowBgPicker,
  showBgVideoPicker,
  setShowBgVideoPicker,
  showImgPicker,
  setShowImgPicker,
  showVideoPicker,
  setShowVideoPicker,
  showBiblePicker,
  setShowBiblePicker,
  onInsertTemplate,
  onDeleteTemplate,
  onDiscardChanges,
  onSaveAndClose,
  onBgImageSelect,
  onBgVideoSelect,
  onImageSelect,
  onVideoSelect,
  onAddVerse,
}: SlideEditorModalsProps) {
  // P5: template gallery improvements — category filter + single/deck badge.
  const categories = useMemo(() => {
    const set = new Set<string>(["All"]);
    BUILTIN_DECKS.forEach(d => set.add(d.category));
    templates.forEach(t => t.category && set.add(t.category));
    return Array.from(set);
  }, [templates]);
  const [category, setCategory] = useState("All");

  const decks = BUILTIN_DECKS.filter(d => category === "All" || d.category === category);
  const userTemplates = templates.filter(t => category === "All" || t.category === category);
  const total = decks.length + userTemplates.length;

  return (
    <>
      {/* ── Template Gallery Modal ── */}
      {showTemplateGallery && (
        <div className="absolute inset-0 z-[100] bg-black/70 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-console-surface border border-console-border-strong rounded-2xl p-5 w-full max-w-2xl mx-4 shadow-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <p className="text-sm font-bold text-console-text">Slide Templates</p>
              <button onClick={() => setShowTemplateGallery(false)} className="p-2 text-console-text-muted hover:text-console-text rounded-lg transition-all" aria-label="Close templates"><X size={16} /></button>
            </div>

            {/* Category filter chips */}
            {categories.length > 1 && (
              <div className="flex flex-wrap gap-1 mb-3 shrink-0" role="tablist" aria-label="Template categories">
                {categories.map(c => (
                  <button
                    key={c}
                    role="tab"
                    aria-selected={category === c}
                    onClick={() => setCategory(c)}
                    className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-all border focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                      category === c
                        ? "bg-tool-design/20 text-tool-design border-tool-design/50"
                        : "bg-console-surface-raised text-console-text-muted hover:text-console-text border-console-border"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {total === 0 ? (
                <p className="text-console-text-subtle text-xs text-center py-8">No templates yet. Save a slide as template from the right panel.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {/* Built-in starter decks (deck templates) */}
                  {decks.map((deck, di) => {
                    const slideCount = deck.slides().length;
                    return (
                      <div key={`builtin-${di}`} className="group relative rounded-xl border border-console-border bg-console-surface-raised/40 overflow-hidden">
                        <div className="flex gap-1.5 p-2 bg-black/30">
                          {deck.slides().slice(0, 4).map(s => (
                            <div key={s.id} className="flex-1 min-w-0">
                              <SlideThumbnail slide={s} width={140} height={79} appDataDir={appDataDir} alt={deck.name} />
                            </div>
                          ))}
                        </div>
                        <div className="p-2 flex items-center justify-between bg-console-surface-raised/40">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-tool-design/15 text-tool-design text-[8px] font-black rounded uppercase">
                              <Layers size={9} /> Deck
                            </span>
                            <div className="min-w-0">
                              <p className="text-[11px] font-bold text-console-text truncate">{deck.name}</p>
                              <p className="text-[8px] text-console-text-subtle">{deck.category} · {slideCount} slide{slideCount === 1 ? "" : "s"}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => onInsertTemplate({ id: stableId(), name: deck.name, category: deck.category, slides: deck.slides(), created_at: Date.now() } as SlideTemplate)}
                            className="flex items-center gap-1 px-2.5 py-1.5 bg-tool-design hover:bg-action-primary text-console-canvas text-[10px] font-bold rounded-lg transition-all shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                            aria-label={`Insert deck ${deck.name}`}
                          >
                            <Plus size={11} /> Insert
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* User single-slide templates */}
                  {userTemplates.map(tpl => {
                    const isDeck = !!(tpl.slides && tpl.slides.length > 0);
                    const previewSlide = (tpl.slides ?? [tpl.slide].filter(Boolean))[0] ?? { id: "x", background: { type: "color", value: "#1a1a2e" }, elements: [] } as CustomSlide;
                    return (
                      <div key={tpl.id} className="group relative rounded-xl border border-console-border bg-console-surface-raised/40 overflow-hidden flex">
                        <div className="w-32 shrink-0 bg-black/30 flex items-center justify-center">
                          <SlideThumbnail slide={previewSlide} width={120} height={68} appDataDir={appDataDir} alt={tpl.name} className="rounded-lg overflow-hidden" />
                        </div>
                        <div className="p-2 flex-1 flex items-center justify-between min-w-0">
                          <div className="min-w-0">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-black rounded uppercase mb-1 ${isDeck ? "bg-tool-design/15 text-tool-design" : "bg-console-surface-strong text-console-text-muted"}`}>
                              {isDeck ? <><Layers size={9} /> Deck</> : "Slide"}
                            </span>
                            <p className="text-[11px] font-bold text-console-text truncate">{tpl.name}</p>
                            <p className="text-[8px] text-console-text-subtle">{tpl.category}</p>
                          </div>
                          <div className="flex gap-1 shrink-0 ml-2">
                            <button onClick={() => onInsertTemplate(tpl)} className="flex items-center gap-1 px-2.5 py-1.5 bg-tool-design hover:bg-action-primary text-console-canvas text-[10px] font-bold rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" aria-label={`Insert template ${tpl.name}`}>
                              <Plus size={11} /> Insert
                            </button>
                            <button onClick={() => onDeleteTemplate(tpl.id)} className="p-1.5 bg-state-live/10 hover:bg-state-live-soft text-state-live rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" aria-label={`Delete template ${tpl.name}`}><Trash2 size={11} /></button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Unsaved changes confirmation ── */}
      {showUnsavedConfirm && (
        <div className="absolute inset-0 z-[100] bg-black/70 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-console-surface border border-console-border-strong rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <p className="text-sm font-bold text-console-text mb-1">Unsaved Changes</p>
            <p className="text-xs text-console-text-muted mb-2">You have unsaved changes to "{pres.name}". Save before leaving?</p>
            {saving && (
              <p className="text-[11px] font-bold text-state-stage mb-2">A save is in progress — leaving will wait for it to finish.</p>
            )}
            <div className="flex gap-2">
              <button onClick={onDiscardChanges} className="flex-1 py-2.5 bg-console-surface-raised hover:bg-state-live-soft text-console-text-muted hover:text-state-live text-[11px] font-bold rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">Discard</button>
              <button onClick={() => setShowUnsavedConfirm(false)} className="flex-1 py-2.5 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted text-[11px] font-bold rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">Cancel</button>
              <button onClick={onSaveAndClose} className="flex-1 py-2.5 bg-action-primary hover:bg-action-primary-hover text-black text-[11px] font-bold rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Media / background / bible pickers ── */}
      {showBgPicker && (
        <MediaPickerModal images={mediaImages} onSelect={path => { onBgImageSelect(path); setShowBgPicker(false); }} onClose={() => setShowBgPicker(false)}
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showBgVideoPicker && (
        <MediaPickerModal images={media} onSelect={onBgVideoSelect} onClose={() => setShowBgVideoPicker(false)} mode="video"
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Videos", extensions: ["mp4","webm","mov","avi","mkv"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showImgPicker && (
        <MediaPickerModal images={mediaImages} onSelect={onImageSelect} onClose={() => setShowImgPicker(false)}
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","gif","webp","bmp"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showVideoPicker && (
        <MediaPickerModal images={media} onSelect={onVideoSelect} onClose={() => setShowVideoPicker(false)} mode="video"
          onUpload={async () => { try { const s = await openDialog({ multiple: false, filters: [{ name: "Videos", extensions: ["mp4","webm","mov","avi","mkv"] }] }); if (typeof s === "string") await invoke("add_media", { path: s }); } catch {} }}
        />
      )}
      {showBiblePicker && (
        <BiblePickerModal onClose={() => setShowBiblePicker(false)} onSelect={onAddVerse} />
      )}
    </>
  );
}