/**
 * SlideEditorModals — template gallery, unsaved-changes confirmation, and
 * the media / background / bible pickers for the slide editor (P1.4).
 * Pure presentation: all handlers are passed in from the controller hook.
 */

import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Trash2, X, Plus } from "lucide-react";
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
  return (
    <>
      {/* ── Template Gallery Modal ── */}
      {showTemplateGallery && (
        <div className="absolute inset-0 z-[100] bg-black/70 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-[#131326] border border-white/10 rounded-2xl p-5 w-full max-w-lg mx-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <p className="text-sm font-bold text-white">Slide Templates</p>
              <button onClick={() => setShowTemplateGallery(false)} className="text-slate-400 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {/* P4.1: built-in starter decks are always offered. */}
              {BUILTIN_DECKS.length + templates.length === 0 ? (
                <p className="text-slate-600 text-xs text-center py-8">No templates yet. Save a slide as template from the right panel.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {BUILTIN_DECKS.map((deck, di) => (
                    <div key={`builtin-${di}`} className="group relative rounded-xl border border-white/8 bg-white/4 overflow-hidden">
                      <div className="flex gap-1 p-1 bg-black/30">
                        {deck.slides().slice(0, 3).map(s => (
                          <div key={s.id} className="flex-1 min-w-0">
                            <SlideThumbnail slide={s} width={60} height={34} appDataDir={appDataDir} alt={s.id} />
                          </div>
                        ))}
                      </div>
                      <div className="p-2 flex items-center justify-between bg-white/4">
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold text-slate-300 truncate">{deck.name}</p>
                          <p className="text-[8px] text-slate-600">{deck.category} · {deck.slides().length} slides</p>
                        </div>
                        <button
                          onClick={() => onInsertTemplate({ id: stableId(), name: deck.name, category: deck.category, slides: deck.slides(), created_at: Date.now() })}
                          className="p-1.5 bg-purple-600/30 hover:bg-purple-600 text-purple-300 hover:text-white rounded-lg transition-all shrink-0 ml-2"
                          title="Insert deck"
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {templates.map(tpl => (
                    <div key={tpl.id} className="group relative rounded-xl border border-white/8 bg-white/4 overflow-hidden">
                      <SlideThumbnail slide={(tpl.slides ?? [tpl.slide].filter(Boolean))[0] ?? { id: "x", background: { type: "color", value: "#1a1a2e" }, elements: [] }} width={120} height={68} appDataDir={appDataDir} alt={tpl.name} />
                      <div className="p-2 flex items-center justify-between bg-white/4">
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold text-slate-300 truncate">{tpl.name}</p>
                          <p className="text-[8px] text-slate-600">{tpl.category}</p>
                        </div>
                        <div className="flex gap-1 shrink-0 ml-2">
                          <button onClick={() => onInsertTemplate(tpl)} className="p-1.5 bg-purple-600/30 hover:bg-purple-600 text-purple-300 hover:text-white rounded-lg transition-all" title="Insert slide"><Plus size={11} /></button>
                          <button onClick={() => onDeleteTemplate(tpl.id)} className="p-1.5 bg-red-500/10 hover:bg-red-500/30 text-red-400 hover:text-red-300 rounded-lg transition-all" title="Delete template"><Trash2 size={11} /></button>
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
              <button onClick={onDiscardChanges} className="flex-1 py-2.5 bg-white/6 hover:bg-red-500/20 text-slate-400 hover:text-red-400 text-[11px] font-bold rounded-lg transition-all">Discard</button>
              <button onClick={() => setShowUnsavedConfirm(false)} className="flex-1 py-2.5 bg-white/8 hover:bg-white/12 text-slate-300 text-[11px] font-bold rounded-lg transition-all">Cancel</button>
              <button onClick={onSaveAndClose} className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 text-black text-[11px] font-bold rounded-lg transition-all">Save</button>
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