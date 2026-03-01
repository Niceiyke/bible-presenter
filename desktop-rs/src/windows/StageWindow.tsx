import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DisplayItem } from "../types";
import { displayItemLabel } from "../utils";
import { CustomSlideRenderer, SlideRenderer } from "../components/shared/Renderers";
import { useAppStore } from "../store";
import { loadPptxZip, parseSingleSlide } from "../pptxParser";
import type { ParsedSlide } from "../pptxParser";

export function StageWindow() {
  const { appDataDir, setAppDataDir } = useAppStore();
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [clock, setClock] = useState("");
  
  const [liveSlide, setLiveSlide] = useState<ParsedSlide | null>(null);
  const [stagedSlide, setStagedSlide] = useState<ParsedSlide | null>(null);
  const stageZipsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    invoke<DisplayItem>("get_current_item").then(setLiveItem).catch(() => {});
    invoke<DisplayItem>("get_staged_item").then(setStagedItem).catch(() => {});
    invoke<string>("get_app_data_dir").then(setAppDataDir).catch(() => {});

    const tick = () => {
      const d = new Date();
      const h = d.getHours().toString().padStart(2, "0");
      const m = d.getMinutes().toString().padStart(2, "0");
      const s = d.getSeconds().toString().padStart(2, "0");
      setClock(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unlisten1 = listen<{ text: string; detected_item: DisplayItem | null; source: string }>(
      "transcription-update",
      (ev) => {
        if (ev.payload.source === "manual" && ev.payload.detected_item) {
          setLiveItem(ev.payload.detected_item);
        } else if (ev.payload.source === "manual" && !ev.payload.detected_item) {
          setLiveItem(null);
        }
      }
    );
    const unlisten2 = listen<DisplayItem | null>("item-staged", (ev) => {
      setStagedItem(ev.payload ?? null);
    });
    return () => { 
      unlisten1.then((f) => f()); 
      unlisten2.then((f) => f()); 
    };
  }, []);

  function itemSummary(item: DisplayItem | null): string {
    if (!item) return "—";
    return displayItemLabel(item);
  }

  function itemDetail(item: DisplayItem | null): string {
    if (!item) return "";
    if (item.type === "Verse") return item.data.text;
    if (item.type === "Song") return item.data.lines.join("\n");
    if (item.type === "Media") return `Media: ${item.data.name} (${item.data.media_type})`;
    if (item.type === "PresentationSlide") return `${item.data.presentation_name} (Slide ${item.data.slide_index + 1})`;
    if (item.type === "Timer") return `${item.data.timer_type}${item.data.duration_secs ? ` · ${Math.floor(item.data.duration_secs / 60)}:${String(item.data.duration_secs % 60).padStart(2,"0")}` : ""}`;
    if (item.type === "CustomSlide") {
      if (item.data.elements && item.data.elements.length > 0) {
        return item.data.elements.filter(e => e.kind === "text").map(e => e.content).join("\n");
      }
      return item.data.body?.text || "";
    }
    return "";
  }

  // PPTX slide loaders for Stage Display
  useEffect(() => {
    if (liveItem?.type !== "PresentationSlide") { setLiveSlide(null); return; }
    const { presentation_id, presentation_path, slide_index } = liveItem.data;
    (async () => {
      try {
        let zip = stageZipsRef.current[presentation_id];
        if (!zip) { zip = await loadPptxZip(presentation_path); stageZipsRef.current[presentation_id] = zip; }
        setLiveSlide(await parseSingleSlide(zip, slide_index));
      } catch { setLiveSlide(null); }
    })();
  }, [liveItem]);

  useEffect(() => {
    if (stagedItem?.type !== "PresentationSlide") { setStagedSlide(null); return; }
    const { presentation_id, presentation_path, slide_index } = stagedItem.data;
    (async () => {
      try {
        let zip = stageZipsRef.current[presentation_id];
        if (!zip) { zip = await loadPptxZip(presentation_path); stageZipsRef.current[presentation_id] = zip; }
        setStagedSlide(await parseSingleSlide(zip, slide_index));
      } catch { setStagedSlide(null); }
    })();
  }, [stagedItem]);

  return (
    <div className="h-screen w-screen bg-slate-950 text-white flex flex-col overflow-hidden select-none font-sans">
      <div className="flex items-center justify-between px-8 py-3 bg-slate-900 border-b border-slate-800 shrink-0">
        <span className="text-slate-500 text-sm font-bold uppercase tracking-widest">Stage Display</span>
        <span className="font-mono text-4xl font-black text-white tracking-widest">{clock}</span>
        <span className="text-slate-500 text-sm font-bold uppercase tracking-widest">Bible Presenter</span>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
        <div className="flex flex-col p-8 border-r border-slate-800 overflow-hidden">
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-black uppercase tracking-widest text-red-400">Now Live</span>
          </div>
          <p className="text-xl font-bold text-slate-300 mb-3 shrink-0 truncate">{itemSummary(liveItem)}</p>
          <div className="text-4xl font-serif leading-snug text-white flex-1 overflow-hidden">
            {liveItem?.type === "CustomSlide" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                <CustomSlideRenderer slide={liveItem.data} scale={0.2} appDataDir={appDataDir} />
              </div>
            ) : liveItem?.type === "PresentationSlide" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                {liveSlide ? <SlideRenderer slide={liveSlide} scale={0.2} /> : <p className="text-slate-500 italic text-xl">Loading PPTX...</p>}
              </div>
            ) : (
              <p className="line-clamp-[8]">{itemDetail(liveItem)}</p>
            )}
          </div>
        </div>

        <div className="flex flex-col p-8 border-2 border-amber-500/40 bg-amber-950/10 overflow-hidden">
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <span className="text-xs font-black uppercase tracking-widest text-amber-400">Up Next ▶</span>
          </div>
          <p className="text-xl font-bold text-amber-300 mb-3 shrink-0 truncate">{itemSummary(stagedItem)}</p>
          <div className="text-4xl font-serif leading-snug text-amber-100 flex-1 overflow-hidden">
            {stagedItem?.type === "CustomSlide" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                <CustomSlideRenderer slide={stagedItem.data} scale={0.2} appDataDir={appDataDir} />
              </div>
            ) : stagedItem?.type === "PresentationSlide" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                {stagedSlide ? <SlideRenderer slide={stagedSlide} scale={0.2} /> : <p className="text-slate-500 italic text-xl">Loading PPTX...</p>}
              </div>
            ) : (
              <p className="line-clamp-[8]">{itemDetail(stagedItem)}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
