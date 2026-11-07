import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock3, StickyNote, X } from "lucide-react";
import { motion } from "framer-motion";
import type { CustomPresentation } from "../../../types";
import { CustomSlideRenderer } from "../../shared/Renderers";
import { SlideThumbnail } from "../../shared/SlideThumbnail";
import { getTransitionVariants } from "../../../utils";
import { useReferenceHeight } from "../../../hooks/useReferenceHeight";

export function RehearsalMode({ presentation, initialIndex, appDataDir, onClose }: { presentation: CustomPresentation; initialIndex: number; appDataDir: string | null; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [elapsed, setElapsed] = useState(0);
  const slide = presentation.slides[index];
  const next = presentation.slides[index + 1];
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const referenceHeight = useReferenceHeight();

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" || event.key === " ") setIndex((value) => Math.min(presentation.slides.length - 1, value + 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, presentation.slides.length]);
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const update = () => setScale(node.clientHeight / referenceHeight);
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    return () => observer.disconnect();
  }, [referenceHeight]);

  const seconds = Math.floor(elapsed / 1000);
  const transition = slide.transition ?? { type: "fade" as const, duration: 350 };
  return (
    <div className="fixed inset-0 z-[190] flex flex-col bg-[#070a0f] text-white" role="dialog" aria-label="Presentation rehearsal mode">
      <header className="flex h-16 items-center gap-4 border-b border-white/10 bg-black/35 px-5">
        <div className="flex-1"><p className="text-[9px] font-black uppercase tracking-[0.18em] text-tool-design">Rehearsal · not live</p><h2 className="mt-0.5 text-sm font-black">{presentation.name}</h2></div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2"><Clock3 size={14} className="text-state-stage" /><span className="font-mono text-sm font-bold tabular-nums">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span></div>
        <span className="text-xs font-bold text-white/60">{index + 1} / {presentation.slides.length}</span>
        <button onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Close rehearsal"><X size={18} /></button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-4 p-4">
        <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
          <motion.div key={slide.id} ref={stageRef} className="aspect-video w-[min(100%,calc((100vh-120px)*16/9))] overflow-hidden" {...getTransitionVariants(transition.type, transition.duration / 1000)}>
            <CustomSlideRenderer slide={slide} scale={scale} appDataDir={appDataDir} theme={presentation.theme} entranceEnabled />
          </motion.div>
          <button disabled={index === 0} onClick={() => setIndex(index - 1)} className="absolute left-4 flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur disabled:opacity-20"><ChevronLeft size={22} /></button>
          <button disabled={index === presentation.slides.length - 1} onClick={() => setIndex(index + 1)} className="absolute right-4 flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur disabled:opacity-20"><ChevronRight size={22} /></button>
        </div>
        <aside className="flex min-h-0 flex-col gap-3">
          <section className="rounded-2xl border border-white/10 bg-white/5 p-3"><p className="mb-2 text-[9px] font-black uppercase tracking-wider text-white/50">Up next</p>{next ? <div className="aspect-video overflow-hidden rounded-xl border border-white/10"><SlideThumbnail slide={next} appDataDir={appDataDir} theme={presentation.theme} className="h-full w-full" /></div> : <div className="flex aspect-video items-center justify-center rounded-xl bg-black/30 text-xs text-white/35">End of presentation</div>}</section>
          <section className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-4"><p className="mb-3 flex items-center gap-2 text-[9px] font-black uppercase tracking-wider text-white/50"><StickyNote size={13} /> Speaker notes</p><p className="whitespace-pre-wrap text-sm leading-7 text-white/80">{slide.notes?.trim() || "No speaker notes for this slide."}</p></section>
          <p className="text-center text-[9px] text-white/35">← / → navigate · Space advances · Esc exits</p>
        </aside>
      </main>
    </div>
  );
}
