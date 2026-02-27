import React, { useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { loadPptxZip, parseSingleSlide, getSlideCount } from "../pptxParser";
import type { ParsedSlide } from "../pptxParser";
import { useAppStore } from "../store";
import { SlideThumbnail } from "./shared/Renderers";
import type { DisplayItem, PresentationFile } from "../types";

// ─── PNG Slide Thumbnail (LibreOffice rendered) ───────────────────────────────

function PngSlideThumbnail({
  pngPath,
  index,
  onStage,
  onLive,
}: {
  pngPath: string;
  index: number;
  onStage: () => void;
  onLive: () => void;
}) {
  return (
    <div className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer bg-slate-900">
      <img src={convertFileSrc(pngPath)} className="w-full h-full object-contain" alt={`Slide ${index + 1}`} />
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
        <button
          onClick={(e) => { e.stopPropagation(); onStage(); }}
          className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
        >
          STAGE
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onLive(); }}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
        >
          DISPLAY
        </button>
      </div>
    </div>
  );
}

// ─── PresentationsTab ─────────────────────────────────────────────────────────

interface PresentationsTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

export function PresentationsTab({ onStage, onLive, onAddToSchedule }: PresentationsTabProps) {
  const {
    presentations, setPresentations,
    selectedPresId, setSelectedPresId,
    loadedSlides, setLoadedSlides,
    libreOfficeAvailable, setLibreOfficeAvailable,
    pptxPngSlides, setPptxPngSlides,
  } = useAppStore();

  const presZipsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    invoke<boolean>("check_libreoffice").then(setLibreOfficeAvailable).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedPresId) return;
    const pres = presentations.find((p) => p.id === selectedPresId);
    if (!pres) return;

    if (libreOfficeAvailable) {
      if (pptxPngSlides[selectedPresId]) return;
      invoke<string[]>("convert_pptx_slides", { path: pres.path, presId: selectedPresId })
        .then((paths) => setPptxPngSlides((prev) => ({ ...prev, [selectedPresId]: paths })))
        .catch(console.error);
    } else {
      if (loadedSlides[selectedPresId]) return;
      (async () => {
        try {
          let zip = presZipsRef.current[selectedPresId];
          if (!zip) {
            zip = await loadPptxZip(pres.path);
            presZipsRef.current[selectedPresId] = zip;
          }
          const count = await getSlideCount(zip);
          const slides: ParsedSlide[] = [];
          for (let i = 0; i < count; i++) {
            slides.push(await parseSingleSlide(zip, i));
          }
          setLoadedSlides({ ...loadedSlides, [selectedPresId]: slides });
          setPresentations(presentations.map((p) => p.id === selectedPresId ? { ...p, slide_count: count } : p));
        } catch (err) {
          console.error("Failed to parse PPTX:", err);
        }
      })();
    }
  }, [selectedPresId, libreOfficeAvailable]);

  const handleImport = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
      });
      if (typeof selected !== "string") return;
      const pres: PresentationFile = await invoke("add_presentation", { path: selected });
      setPresentations([...presentations, pres]);
      setSelectedPresId(pres.id);
    } catch (err) {
      console.error("Import failed:", err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_presentation", { id });
      setPresentations(presentations.filter((p) => p.id !== id));
      const next = { ...loadedSlides };
      delete next[id];
      setLoadedSlides(next);
      delete presZipsRef.current[id];
      if (selectedPresId === id) setSelectedPresId(null);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const makePresentationItem = (pres: PresentationFile, slideIndex: number, slideCount: number): DisplayItem => ({
    type: "PresentationSlide",
    data: {
      presentation_id: pres.id,
      presentation_name: pres.name,
      presentation_path: pres.path,
      slide_index: slideIndex,
      slide_count: slideCount,
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Presentations</h2>
          {libreOfficeAvailable && (
            <span className="text-[8px] font-bold text-green-400 bg-green-500/10 border border-green-500/30 px-1.5 py-0.5 rounded">⚡ LibreOffice</span>
          )}
        </div>
        <button onClick={handleImport} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all">
          + IMPORT
        </button>
      </div>

      {presentations.length === 0 ? (
        <p className="text-slate-700 text-xs italic text-center pt-8">
          No presentations. Click + IMPORT to add a .pptx file.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {presentations.map((pres) => (
              <button
                key={pres.id}
                onClick={() => setSelectedPresId(pres.id)}
                className={`flex items-center gap-2 p-2 rounded-lg border text-left text-xs transition-all ${
                  selectedPresId === pres.id
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                    : "border-slate-700/50 bg-slate-800/40 text-slate-300 hover:bg-slate-800 hover:border-slate-600"
                }`}
              >
                <span className="text-orange-400 font-black text-[9px] bg-orange-400/10 px-1.5 py-0.5 rounded shrink-0">
                  PPTX
                </span>
                <span className="flex-1 truncate text-left">{pres.name}</span>
                {pres.slide_count > 0 && (
                  <span className="text-slate-500 text-[9px] shrink-0">
                    {pres.slide_count} slides
                  </span>
                )}
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); handleDelete(pres.id); }}
                  className="shrink-0 text-red-500/50 hover:text-red-400 text-xs px-1 cursor-pointer"
                >
                  ✕
                </span>
              </button>
            ))}
          </div>

          {selectedPresId && (() => {
            const pres = presentations.find((p) => p.id === selectedPresId)!;
            const pngSlides = pptxPngSlides[selectedPresId];
            const jsSlides = loadedSlides[selectedPresId];

            if (libreOfficeAvailable) {
              if (!pngSlides) return <p className="text-slate-600 text-xs italic text-center py-4">Converting slides...</p>;
              return (
                <div>
                  <p className="text-[9px] text-slate-600 uppercase font-bold mb-2 tracking-widest">Slides</p>
                  <div className="grid grid-cols-2 gap-2">
                    {pngSlides.map((pngPath, idx) => (
                      <PngSlideThumbnail
                        key={idx}
                        pngPath={pngPath}
                        index={idx}
                        onStage={() => onStage(makePresentationItem(pres, idx, pngSlides.length))}
                        onLive={() => onLive(makePresentationItem(pres, idx, pngSlides.length))}
                      />
                    ))}
                  </div>
                </div>
              );
            } else {
              if (!jsSlides) return <p className="text-slate-600 text-xs italic text-center py-4">Parsing slides...</p>;
              return (
                <div>
                  <p className="text-[9px] text-slate-600 uppercase font-bold mb-2 tracking-widest">Slides</p>
                  <div className="grid grid-cols-2 gap-2">
                    {jsSlides.map((slide, idx) => (
                      <SlideThumbnail
                        key={idx}
                        slide={slide}
                        index={idx}
                        onStage={() => onStage(makePresentationItem(pres, idx, jsSlides.length))}
                        onLive={() => onLive(makePresentationItem(pres, idx, jsSlides.length))}
                      />
                    ))}
                  </div>
                </div>
              );
            }
          })()}
        </>
      )}
    </div>
  );
}
