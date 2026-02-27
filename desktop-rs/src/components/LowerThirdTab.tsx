import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useAppStore } from "../store";
import type { LowerThirdData, LowerThirdTemplate, MediaItem } from "../App";

// ─── Constants ────────────────────────────────────────────────────────────────

const FONTS = [
  "Arial", "Verdana", "Helvetica", "Trebuchet MS",
  "Georgia", "Times New Roman", "Palatino",
  "Impact", "Arial Black", "Courier New",
];

function stableId(): string {
  return crypto.randomUUID();
}

// ─── Lower Third helpers ──────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
}

function buildLtPositionStyle(t: LowerThirdTemplate): React.CSSProperties {
  const style: React.CSSProperties = { position: "absolute", zIndex: 50, width: `${t.widthPct}%` };
  let tx = "";
  let ty = "";
  if (t.hAlign === "left") { style.left = t.offsetX; }
  else if (t.hAlign === "right") { style.right = t.offsetX; }
  else { style.left = "50%"; tx = "-50%"; }
  if (t.vAlign === "top") { style.top = t.offsetY; }
  else if (t.vAlign === "bottom") { style.bottom = t.offsetY; }
  else { style.top = "50%"; ty = "-50%"; }
  if (tx || ty) style.transform = `translate(${tx || "0"}, ${ty || "0"})`;
  return style;
}

function buildLtContainerStyle(t: LowerThirdTemplate): React.CSSProperties {
  const style: React.CSSProperties = {
    paddingLeft: t.paddingX, paddingRight: t.paddingX,
    paddingTop: t.paddingY, paddingBottom: t.paddingY,
    borderRadius: t.borderRadius, overflow: "hidden",
    backdropFilter: t.bgBlur ? "blur(8px)" : undefined,
  };
  if (t.bgType === "solid") {
    style.background = hexToRgba(t.bgColor, t.bgOpacity);
  } else if (t.bgType === "gradient") {
    style.background = `linear-gradient(135deg, ${hexToRgba(t.bgColor, t.bgOpacity)} 0%, ${hexToRgba(t.bgGradientEnd, t.bgOpacity)} 100%)`;
  } else if (t.bgType === "image" && t.bgImagePath) {
    style.backgroundImage = `url("${convertFileSrc(t.bgImagePath)}")`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
    style.backgroundRepeat = "no-repeat";
  } else {
    style.background = "transparent";
  }
  if (t.accentEnabled) {
    const border = `${t.accentWidth}px solid ${t.accentColor}`;
    if (t.accentSide === "left") style.borderLeft = border;
    else if (t.accentSide === "right") style.borderRight = border;
    else if (t.accentSide === "top") style.borderTop = border;
    else style.borderBottom = border;
  }
  return style;
}

function buildLtTextStyle(
  font: string, size: number, color: string,
  bold: boolean, italic: boolean, uppercase: boolean
): React.CSSProperties {
  return {
    fontFamily: font, fontSize: size, color,
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    textTransform: uppercase ? "uppercase" : undefined,
    lineHeight: 1.25, margin: 0,
  };
}

function buildLtLabelStyle(t: LowerThirdTemplate): React.CSSProperties {
  return {
    ...buildLtTextStyle(t.secondaryFont, t.labelSize, t.labelColor, true, false, t.labelUppercase),
    letterSpacing: "0.1em", marginBottom: 4,
  };
}

function ltBuildLyricsPayload(
  ltFlatLines: { text: string; sectionLabel: string }[],
  lineIndex: number,
  linesPerDisplay: 1 | 2,
): LowerThirdData | null {
  if (ltFlatLines.length === 0) return null;
  const line1 = ltFlatLines[lineIndex];
  if (!line1) return null;
  const line2Entry = linesPerDisplay === 2 ? ltFlatLines[lineIndex + 1] : undefined;
  return {
    kind: "Lyrics",
    data: { line1: line1.text, line2: line2Entry?.text, section_label: line1.sectionLabel },
  };
}

// ─── Lower Third Overlay ──────────────────────────────────────────────────────

function LowerThirdOverlay({ data, template: t }: { data: LowerThirdData; template: LowerThirdTemplate }) {
  const containerStyle = buildLtContainerStyle(t);

  const getVariants = () => {
    switch (t.animation) {
      case "fade":
        return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
      case "slide-up":
        return { initial: { opacity: 0, y: 30 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 30 } };
      case "slide-left":
        return { initial: { opacity: 0, x: 50 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 50 } };
      default:
        return { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 } };
    }
  };

  const variants = getVariants();

  return (
    <motion.div
      style={buildLtPositionStyle(t)}
      initial={variants.initial}
      animate={variants.animate}
      exit={variants.exit}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div style={containerStyle}>
        {data.kind === "Nameplate" && (
          <div className="w-full">
            {t.variant === "modern" ? (
              <div className="flex flex-col items-center text-center">
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {data.data.name}
                </p>
                {data.data.title && (
                  <>
                    <div className="w-1/4 h-px my-2 opacity-30" style={{ backgroundColor: t.secondaryColor }} />
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {data.data.title}
                    </p>
                  </>
                )}
              </div>
            ) : t.variant === "banner" ? (
              <div className="flex items-center gap-4">
                <div className="shrink-0 py-1 px-4 rounded" style={{ background: t.accentColor, color: t.bgColor }}>
                   <p className="font-black text-xl uppercase tracking-tighter">LIVE</p>
                </div>
                <div className="flex-1 min-w-0">
                  <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                    {data.data.name}
                  </p>
                  {data.data.title && (
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {data.data.title}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {data.data.name}
                </p>
                {data.data.title && (
                  <p style={{ ...buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase), marginTop: 4 }}>
                    {data.data.title}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {data.kind === "Lyrics" && (
          <>
            {data.data.section_label && t.labelVisible && (
              <p style={buildLtLabelStyle(t)}>{data.data.section_label}</p>
            )}
            <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
              {data.data.line1}
            </p>
            {data.data.line2 && (
              <p style={{ ...buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase), marginTop: 4 }}>
                {data.data.line2}
              </p>
            )}
          </>
        )}
        {data.kind === "FreeText" && (
          t.scrollEnabled ? (
            <div style={{ overflow: "hidden", whiteSpace: "nowrap" }}>
              <span style={{
                ...buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase),
                display: "inline-block",
                paddingLeft: "100%",
                paddingRight: "0",
                animation: `lt-scroll-${t.scrollDirection} ${(11 - t.scrollSpeed) * 4}s linear infinite`,
                willChange: "transform",
              }}>
                {data.data.text}
              </span>
            </div>
          ) : (
            <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
              {data.data.text}
            </p>
          )
        )}
      </div>
    </motion.div>
  );
}

// ─── Media Picker Modal (local copy) ─────────────────────────────────────────

function MediaPickerModal({
  images,
  onSelect,
  onClose,
  onUpload,
}: {
  images: MediaItem[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onUpload: () => Promise<void>;
}) {
  const [uploading, setUploading] = React.useState(false);

  const handleUpload = async () => {
    setUploading(true);
    try { await onUpload(); } finally { setUploading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col w-full max-w-2xl" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
          <span className="text-sm font-bold text-slate-200">Media Library — Pick Image</span>
          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="text-[10px] bg-amber-500 hover:bg-amber-400 text-black font-bold px-3 py-1.5 rounded transition-all disabled:opacity-50"
            >
              {uploading ? "Uploading..." : "+ Upload New"}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {images.length === 0 ? (
            <p className="text-slate-600 text-xs italic text-center py-12">
              No images in library yet. Click "+ Upload New" to add images.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((img) => (
                <button
                  key={img.id}
                  onClick={() => { onSelect(img.path); onClose(); }}
                  className="aspect-video rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500 transition-all group relative"
                >
                  <img src={convertFileSrc(img.path)} className="w-full h-full object-cover" alt={img.name} />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">SELECT</span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                    <p className="text-[8px] text-white truncate">{img.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── LowerThirdTab ────────────────────────────────────────────────────────────

interface LowerThirdTabProps {
  onLoadMedia: () => Promise<void>;
  onSetToast: (msg: string) => void;
}

export default function LowerThirdTab({ onLoadMedia, onSetToast }: LowerThirdTabProps) {
  const {
    activeTab,
    songs,
    media,
    ltMode, setLtMode,
    ltVisible, setLtVisible,
    ltTemplate, setLtTemplate,
    ltSavedTemplates, setLtSavedTemplates,
    ltDesignOpen, setLtDesignOpen,
    showLtImgPicker, setShowLtImgPicker,
    ltName, setLtName,
    ltTitle, setLtTitle,
    ltFreeText, setLtFreeText,
    ltSongId, setLtSongId,
    ltLineIndex, setLtLineIndex,
    ltLinesPerDisplay, setLtLinesPerDisplay,
    ltAutoAdvance, setLtAutoAdvance,
    ltAutoSeconds, setLtAutoSeconds,
    ltAtEnd, setLtAtEnd,
  } = useAppStore();

  const ltAutoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ltSelectedSong = useMemo(
    () => songs.find((s) => s.id === ltSongId) ?? null,
    [songs, ltSongId],
  );

  const ltFlatLines = useMemo((): { text: string; sectionLabel: string }[] => {
    if (!ltSelectedSong) return [];
    const flat: { text: string; sectionLabel: string }[] = [];
    const arr = ltSelectedSong.arrangement;
    const sections = ltSelectedSong.sections;
    if (arr && arr.length > 0) {
      for (const label of arr) {
        const sec = sections.find((s) => s.label === label);
        if (sec) {
          for (const line of sec.lines) {
            flat.push({ text: line, sectionLabel: sec.label });
          }
        }
      }
    } else {
      for (const section of sections) {
        for (const line of section.lines) {
          flat.push({ text: line, sectionLabel: section.label });
        }
      }
    }
    return flat;
  }, [ltSelectedSong]);

  const ltSendCurrent = useCallback(async (index: number) => {
    if (ltFlatLines.length === 0) return;
    const clampedIndex = Math.max(0, Math.min(index, ltFlatLines.length - 1));
    const payload = ltBuildLyricsPayload(ltFlatLines, clampedIndex, ltLinesPerDisplay);
    if (!payload) return;
    await invoke("show_lower_third", { data: payload, template: ltTemplate });
  }, [ltFlatLines, ltLinesPerDisplay, ltTemplate]);

  const ltAdvance = useCallback(async (dir: 1 | -1) => {
    if (ltFlatLines.length === 0) return;
    const next = Math.max(0, Math.min(ltLineIndex + dir * ltLinesPerDisplay, ltFlatLines.length - 1));
    setLtLineIndex(next);
    setLtAtEnd(next >= ltFlatLines.length - 1);
    if (ltVisible) await ltSendCurrent(next);
  }, [ltFlatLines, ltLinesPerDisplay, ltLineIndex, ltVisible, ltSendCurrent]);

  // Keyboard shortcuts (Space/→ = next, ← = prev, H = show/hide)
  useEffect(() => {
    if (activeTab !== "lower-third" || ltMode !== "lyrics") return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); ltAdvance(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); ltAdvance(-1); }
      if (e.key === "h" || e.key === "H") {
        if (ltVisible) {
          invoke("hide_lower_third").then(() => setLtVisible(false)).catch(console.error);
        } else {
          if (!ltSongId || ltFlatLines.length === 0) return;
          const payload = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
          if (!payload) return;
          invoke("show_lower_third", { data: payload, template: ltTemplate })
            .then(() => setLtVisible(true))
            .catch(console.error);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, ltMode, ltAdvance, ltVisible, ltSongId, ltFlatLines, ltLineIndex, ltLinesPerDisplay, ltTemplate]);

  // Auto-advance interval
  useEffect(() => {
    if (ltAutoRef.current) clearInterval(ltAutoRef.current);
    if (ltAutoAdvance && ltVisible && ltMode === "lyrics") {
      ltAutoRef.current = setInterval(() => {
        setLtLineIndex((prev) => {
          const maxIdx = ltFlatLines.length - 1;
          if (prev >= maxIdx) {
            if (ltAutoRef.current) clearInterval(ltAutoRef.current);
            setLtAtEnd(true);
            return prev;
          }
          const next = Math.min(prev + ltLinesPerDisplay, maxIdx);
          Promise.resolve().then(() => ltSendCurrent(next)).catch(console.error);
          if (next >= maxIdx) setLtAtEnd(true);
          return next;
        });
      }, ltAutoSeconds * 1000);
    }
    return () => { if (ltAutoRef.current) clearInterval(ltAutoRef.current); };
  }, [ltAutoAdvance, ltVisible, ltMode, ltAutoSeconds, ltLinesPerDisplay, ltFlatLines, ltSendCurrent]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Lower Third</h2>

      {/* ── Design Panel ── */}
      <div className="border border-slate-700 rounded-xl overflow-hidden">
        <button
          onClick={() => setLtDesignOpen(!ltDesignOpen)}
          className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-750 text-xs font-bold text-slate-300 uppercase tracking-widest"
        >
          <span>Design</span>
          <span className="text-slate-500">{ltDesignOpen ? "▲" : "▼"}</span>
        </button>

        {ltDesignOpen && (
          <div className="p-3 flex flex-col gap-4">

            {/* Template selector */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Template</p>
              <div className="flex gap-1.5">
                <input
                  className="flex-1 bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700"
                  placeholder="Template name"
                  value={ltTemplate.name}
                  onChange={(e) => setLtTemplate((t) => ({ ...t, name: e.target.value }))}
                />
              </div>
              <div className="flex gap-1.5">
                <select
                  className="flex-1 bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700"
                  value={ltTemplate.id}
                  onChange={(e) => {
                    const found = ltSavedTemplates.find((t) => t.id === e.target.value);
                    if (found) {
                      setLtTemplate(found);
                      localStorage.setItem("activeLtTemplateId", found.id);
                    }
                  }}
                >
                  {ltSavedTemplates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const newId = stableId();
                    const newTpl: LowerThirdTemplate = { ...ltTemplate, id: newId, name: "New Template" };
                    setLtTemplate(newTpl);
                    setLtSavedTemplates([...ltSavedTemplates, newTpl]);
                    localStorage.setItem("activeLtTemplateId", newId);
                  }}
                  className="px-2 py-1 bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold rounded"
                >+ New</button>
                <button
                  onClick={async () => {
                    const updated = ltSavedTemplates.some((t) => t.id === ltTemplate.id)
                      ? ltSavedTemplates.map((t) => t.id === ltTemplate.id ? ltTemplate : t)
                      : [...ltSavedTemplates, ltTemplate];
                    setLtSavedTemplates(updated);
                    localStorage.setItem("activeLtTemplateId", ltTemplate.id);
                    await invoke("save_lt_templates", { templates: updated });
                    onSetToast("Template saved");
                  }}
                  className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold rounded"
                >Save</button>
                <button
                  onClick={async () => {
                    if (ltSavedTemplates.length <= 1) { onSetToast("Cannot delete the last template"); return; }
                    if (!confirm(`Delete template "${ltTemplate.name}"?`)) return;
                    const updated = ltSavedTemplates.filter((t) => t.id !== ltTemplate.id);
                    const next = updated[0];
                    if (!next) return;
                    setLtSavedTemplates(updated);
                    setLtTemplate(next);
                    localStorage.setItem("activeLtTemplateId", next.id);
                    await invoke("save_lt_templates", { templates: updated });
                  }}
                  className="px-2 py-1 bg-red-800 hover:bg-red-700 text-white text-[10px] font-bold rounded"
                >Del</button>
              </div>
            </div>

            <div className="border-t border-slate-700" />

            {/* Background */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Background</p>
              <div className="flex gap-1">
                {(["solid", "gradient", "image", "transparent"] as const).map((bt) => (
                  <button key={bt} onClick={() => setLtTemplate((t) => ({ ...t, bgType: bt }))}
                    className={`flex-1 py-1 text-[10px] font-bold rounded ${ltTemplate.bgType === bt ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-400"}`}>
                    {bt === "solid" ? "Solid" : bt === "gradient" ? "Grad" : bt === "image" ? "Image" : "None"}
                  </button>
                ))}
              </div>
              {ltTemplate.bgType === "image" && (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => {
                      if (media.filter((m) => m.media_type === "Image").length > 0) {
                        setShowLtImgPicker(true);
                      } else {
                        onSetToast("No images in media library. Upload images in the Media tab first.");
                      }
                    }}
                    className="w-full py-1.5 text-[10px] font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600"
                  >
                    {ltTemplate.bgImagePath ? "Change Image" : "Pick Image from Library"}
                  </button>
                  {ltTemplate.bgImagePath && (
                    <div className="relative rounded overflow-hidden border border-slate-700" style={{ aspectRatio: "16/9" }}>
                      <img src={convertFileSrc(ltTemplate.bgImagePath)} className="w-full h-full object-cover" alt="Background preview" />
                      <button
                        onClick={() => setLtTemplate((t) => ({ ...t, bgImagePath: undefined }))}
                        className="absolute top-1 right-1 bg-black/70 text-white text-[10px] rounded px-1 hover:bg-red-700"
                      >✕</button>
                    </div>
                  )}
                </div>
              )}
              {(ltTemplate.bgType === "solid" || ltTemplate.bgType === "gradient") && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-slate-400 w-12">Color</label>
                    <input type="color" value={ltTemplate.bgColor}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, bgColor: e.target.value }))}
                      className="w-8 h-6 rounded cursor-pointer border-0 bg-transparent" />
                    <label className="text-[10px] text-slate-400">Opacity</label>
                    <input type="range" min={0} max={100} value={ltTemplate.bgOpacity}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, bgOpacity: Number(e.target.value) }))}
                      className="flex-1" />
                    <span className="text-[10px] text-slate-400 w-8 text-right">{ltTemplate.bgOpacity}%</span>
                  </div>
                  {ltTemplate.bgType === "gradient" && (
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-400 w-12">End</label>
                      <input type="color" value={ltTemplate.bgGradientEnd}
                        onChange={(e) => setLtTemplate((t) => ({ ...t, bgGradientEnd: e.target.value }))}
                        className="w-8 h-6 rounded cursor-pointer border-0 bg-transparent" />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-slate-400">Blur</label>
                    <input type="checkbox" checked={ltTemplate.bgBlur}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, bgBlur: e.target.checked }))} />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-700" />

            {/* Accent Bar */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Accent Bar</p>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={ltTemplate.accentEnabled}
                  onChange={(e) => setLtTemplate((t) => ({ ...t, accentEnabled: e.target.checked }))} />
                <label className="text-[10px] text-slate-400">Enabled</label>
              </div>
              {ltTemplate.accentEnabled && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-slate-400 w-12">Color</label>
                    <input type="color" value={ltTemplate.accentColor}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, accentColor: e.target.value }))}
                      className="w-8 h-6 rounded cursor-pointer border-0 bg-transparent" />
                    <label className="text-[10px] text-slate-400">Side</label>
                    <div className="flex gap-1">
                      {(["left", "right", "top", "bottom"] as const).map((s) => (
                        <button key={s} onClick={() => setLtTemplate((t) => ({ ...t, accentSide: s }))}
                          className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${ltTemplate.accentSide === s ? "bg-amber-600 text-white" : "bg-slate-700 text-slate-400"}`}>
                          {s[0].toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-slate-400 w-12">Width</label>
                    <input type="range" min={1} max={20} value={ltTemplate.accentWidth}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, accentWidth: Number(e.target.value) }))}
                      className="flex-1" />
                    <span className="text-[10px] text-slate-400 w-6 text-right">{ltTemplate.accentWidth}</span>
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-slate-700" />

            {/* Position & Size */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Position & Size</p>
              <div className="grid grid-cols-3 gap-1">
                {(["top","middle","bottom"] as const).map((v) =>
                  (["left","center","right"] as const).map((h) => (
                    <button key={`${v}-${h}`}
                      onClick={() => setLtTemplate((t) => ({ ...t, vAlign: v, hAlign: h }))}
                      className={`py-1.5 text-[9px] rounded border transition-all ${ltTemplate.vAlign === v && ltTemplate.hAlign === h ? "border-amber-500 bg-amber-900/40 text-amber-300" : "border-slate-700 bg-slate-900 text-slate-500 hover:border-slate-500"}`}>
                      {v[0].toUpperCase()}{h[0].toUpperCase()}
                    </button>
                  ))
                )}
              </div>
              {[
                { label: "Offset X", key: "offsetX" as const, min: 0, max: 200, unit: "px" },
                { label: "Offset Y", key: "offsetY" as const, min: 0, max: 200, unit: "px" },
                { label: "Width %", key: "widthPct" as const, min: 10, max: 100, unit: "%" },
                { label: "Pad X", key: "paddingX" as const, min: 0, max: 80, unit: "px" },
                { label: "Pad Y", key: "paddingY" as const, min: 0, max: 80, unit: "px" },
                { label: "Radius", key: "borderRadius" as const, min: 0, max: 40, unit: "px" },
              ].map(({ label, key, min, max, unit }) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-[10px] text-slate-400 w-14">{label}</label>
                  <input type="range" min={min} max={max} value={ltTemplate[key] as number}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, [key]: Number(e.target.value) }))}
                    className="flex-1" />
                  <span className="text-[10px] text-slate-400 w-8 text-right">{ltTemplate[key] as number}{unit}</span>
                </div>
              ))}
            </div>

            <div className="border-t border-slate-700" />

            {/* Typography */}
            <div className="flex flex-col gap-3">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Typography</p>
              {/* Primary */}
              <div className="flex flex-col gap-1">
                <p className="text-[9px] text-slate-600 uppercase tracking-widest">Primary (name / line 1 / text)</p>
                <div className="flex gap-1.5 flex-wrap items-center">
                  <select value={ltTemplate.primaryFont}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, primaryFont: e.target.value }))}
                    className="bg-slate-900 text-slate-200 text-[10px] rounded px-1 py-0.5 border border-slate-700 flex-1 min-w-0">
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <input type="number" min={8} max={120} value={ltTemplate.primarySize}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, primarySize: Number(e.target.value) }))}
                    className="w-12 bg-slate-900 text-slate-200 text-[10px] rounded px-1 py-0.5 border border-slate-700 text-center" />
                  <input type="color" value={ltTemplate.primaryColor}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, primaryColor: e.target.value }))}
                    className="w-7 h-6 rounded cursor-pointer border-0 bg-transparent" />
                  <button onClick={() => setLtTemplate((t) => ({ ...t, primaryBold: !t.primaryBold }))}
                    className={`px-1.5 py-0.5 text-[10px] font-black rounded ${ltTemplate.primaryBold ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>B</button>
                  <button onClick={() => setLtTemplate((t) => ({ ...t, primaryItalic: !t.primaryItalic }))}
                    className={`px-1.5 py-0.5 text-[10px] italic rounded ${ltTemplate.primaryItalic ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>I</button>
                  <button onClick={() => setLtTemplate((t) => ({ ...t, primaryUppercase: !t.primaryUppercase }))}
                    className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${ltTemplate.primaryUppercase ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>AA</button>
                </div>
              </div>
              {/* Secondary */}
              <div className="flex flex-col gap-1">
                <p className="text-[9px] text-slate-600 uppercase tracking-widest">Secondary (title / line 2)</p>
                <div className="flex gap-1.5 flex-wrap items-center">
                  <select value={ltTemplate.secondaryFont}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, secondaryFont: e.target.value }))}
                    className="bg-slate-900 text-slate-200 text-[10px] rounded px-1 py-0.5 border border-slate-700 flex-1 min-w-0">
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <input type="number" min={8} max={120} value={ltTemplate.secondarySize}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, secondarySize: Number(e.target.value) }))}
                    className="w-12 bg-slate-900 text-slate-200 text-[10px] rounded px-1 py-0.5 border border-slate-700 text-center" />
                  <input type="color" value={ltTemplate.secondaryColor}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, secondaryColor: e.target.value }))}
                    className="w-7 h-6 rounded cursor-pointer border-0 bg-transparent" />
                  <button onClick={() => setLtTemplate((t) => ({ ...t, secondaryBold: !t.secondaryBold }))}
                    className={`px-1.5 py-0.5 text-[10px] font-black rounded ${ltTemplate.secondaryBold ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>B</button>
                  <button onClick={() => setLtTemplate((t) => ({ ...t, secondaryItalic: !t.secondaryItalic }))}
                    className={`px-1.5 py-0.5 text-[10px] italic rounded ${ltTemplate.secondaryItalic ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>I</button>
                  <button onClick={() => setLtTemplate((t) => ({ ...t, secondaryUppercase: !t.secondaryUppercase }))}
                    className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${ltTemplate.secondaryUppercase ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>AA</button>
                </div>
              </div>
              {/* Label */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <p className="text-[9px] text-slate-600 uppercase tracking-widest flex-1">Section Label</p>
                  <input type="checkbox" checked={ltTemplate.labelVisible}
                    onChange={(e) => setLtTemplate((t) => ({ ...t, labelVisible: e.target.checked }))} />
                </div>
                {ltTemplate.labelVisible && (
                  <div className="flex gap-1.5 flex-wrap items-center">
                    <input type="number" min={8} max={60} value={ltTemplate.labelSize}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, labelSize: Number(e.target.value) }))}
                      className="w-12 bg-slate-900 text-slate-200 text-[10px] rounded px-1 py-0.5 border border-slate-700 text-center" />
                    <input type="color" value={ltTemplate.labelColor}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, labelColor: e.target.value }))}
                      className="w-7 h-6 rounded cursor-pointer border-0 bg-transparent" />
                    <button onClick={() => setLtTemplate((t) => ({ ...t, labelUppercase: !t.labelUppercase }))}
                      className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${ltTemplate.labelUppercase ? "bg-slate-500 text-white" : "bg-slate-800 text-slate-500"}`}>AA</button>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-slate-700" />

            {/* Design Variant */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Design Variant</p>
              <div className="flex gap-1">
                {(["classic", "modern", "banner"] as const).map((v) => (
                  <button key={v} onClick={() => setLtTemplate((t) => ({ ...t, variant: v }))}
                    className={`flex-1 py-1 text-[9px] font-bold rounded uppercase ${ltTemplate.variant === v ? "bg-amber-700 text-white" : "bg-slate-800 text-slate-400"}`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-slate-700" />

            {/* Animation */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Animation</p>
              <div className="flex gap-1">
                {(["fade","slide-up","slide-left","none"] as const).map((a) => (
                  <button key={a} onClick={() => setLtTemplate((t) => ({ ...t, animation: a }))}
                    className={`flex-1 py-1 text-[9px] font-bold rounded ${ltTemplate.animation === a ? "bg-amber-700 text-white" : "bg-slate-800 text-slate-400"}`}>
                    {a === "slide-up" ? "↑" : a === "slide-left" ? "←" : a === "fade" ? "Fade" : "None"}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-slate-700" />

            {/* Preview */}
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Preview</p>
              <div className="relative bg-black rounded overflow-hidden" style={{ width: 240, height: 135 }}>
                <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                  <div style={{ width: 1920, height: 1080, position: "absolute", top: 0, left: 0, transformOrigin: "top left", transform: `scale(${240 / 1920})` }}>
                    <LowerThirdOverlay
                      template={ltTemplate}
                      data={
                        ltMode === "nameplate"
                          ? { kind: "Nameplate", data: { name: ltName || "Name Here", title: ltTitle || "Title / Role" } }
                          : ltMode === "freetext"
                          ? { kind: "FreeText", data: { text: ltFreeText || "Lower third text" } }
                          : { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Song Line 1", line2: ltLinesPerDisplay === 2 ? (ltFlatLines[ltLineIndex + 1]?.text || "Song Line 2") : undefined, section_label: ltFlatLines[ltLineIndex]?.sectionLabel || "Verse 1" } }
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Mode selector */}
      <div className="flex rounded-lg overflow-hidden border border-slate-700">
        {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
          <button key={m} onClick={() => setLtMode(m)}
            className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all ${ltMode === m ? "bg-slate-700 text-amber-400" : "text-slate-500 hover:text-slate-300"}`}>
            {m === "freetext" ? "Free Text" : m === "nameplate" ? "Nameplate" : "Lyrics"}
          </button>
        ))}
      </div>

      {/* ── Nameplate mode ── */}
      {ltMode === "nameplate" && (
        <div className="flex flex-col gap-3">
          <input
            className="w-full bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700 placeholder-slate-500"
            placeholder="Name"
            value={ltName}
            onChange={(e) => setLtName(e.target.value)}
          />
          <input
            className="w-full bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700 placeholder-slate-500"
            placeholder="Title / Role (optional)"
            value={ltTitle}
            onChange={(e) => setLtTitle(e.target.value)}
          />
        </div>
      )}

      {/* ── Free text mode ── */}
      {ltMode === "freetext" && (
        <div className="flex flex-col gap-2">
          <textarea
            className="w-full bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700 placeholder-slate-500 resize-none h-24"
            placeholder="Type your message..."
            value={ltFreeText}
            onChange={(e) => setLtFreeText(e.target.value)}
          />
          <div className="flex gap-1.5 items-center">
            <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Scroll:</span>
            {([
              { label: "Static", enabled: false, dir: null },
              { label: "→→ Scroll", enabled: true, dir: "ltr" as const },
              { label: "←← Scroll", enabled: true, dir: "rtl" as const },
            ] as const).map((opt) => {
              const active = !ltTemplate.scrollEnabled && !opt.enabled
                ? true
                : opt.enabled && ltTemplate.scrollEnabled && ltTemplate.scrollDirection === opt.dir;
              return (
                <button
                  key={opt.label}
                  onClick={() => setLtTemplate((p) => ({
                    ...p,
                    scrollEnabled: opt.enabled,
                    ...(opt.dir ? { scrollDirection: opt.dir } : {}),
                  }))}
                  className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${active ? "bg-amber-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {ltTemplate.scrollEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 uppercase font-bold whitespace-nowrap">Speed:</span>
              <input
                type="range" min={1} max={10} step={1}
                value={ltTemplate.scrollSpeed}
                onChange={(e) => setLtTemplate((p) => ({ ...p, scrollSpeed: Number(e.target.value) }))}
                className="flex-1 accent-amber-500"
              />
              <span className="text-[10px] text-slate-400 w-4 text-right">{ltTemplate.scrollSpeed}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Lyrics mode ── */}
      {ltMode === "lyrics" && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 items-center">
            <select
              className="flex-1 bg-slate-800 text-slate-200 text-xs rounded-lg px-2 py-2 border border-slate-700"
              value={ltSongId || ""}
              onChange={(e) => { setLtSongId(e.target.value || null); setLtLineIndex(0); setLtAtEnd(false); }}
            >
              <option value="">— Select a song —</option>
              {songs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </div>

          <div className="flex gap-3 items-center flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 uppercase font-bold">Lines:</span>
              {([1, 2] as const).map((n) => (
                <button key={n} onClick={() => setLtLinesPerDisplay(n)}
                  className={`text-[10px] font-bold w-6 h-6 rounded ${ltLinesPerDisplay === n ? "bg-amber-600 text-white" : "bg-slate-700 text-slate-400"}`}>
                  {n}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLtAutoAdvance(!ltAutoAdvance)}
                className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${ltAutoAdvance ? "bg-amber-600 text-white" : "bg-slate-700 text-slate-400"}`}>
                Auto {ltAutoAdvance ? "ON" : "OFF"}
              </button>
              {ltAutoAdvance && (
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={30}
                    className="w-12 bg-slate-800 text-slate-200 text-xs rounded px-1 py-1 border border-slate-700 text-center"
                    value={ltAutoSeconds}
                    onChange={(e) => setLtAutoSeconds(Number(e.target.value))}
                  />
                  <span className="text-[10px] text-slate-500">sec</span>
                </div>
              )}
            </div>
          </div>

          {ltSongId && ltFlatLines.length > 0 && (
            <div className="flex flex-col gap-2 bg-slate-900 border border-slate-800 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <p className="text-[9px] text-slate-600 uppercase font-bold tracking-widest">Now Live</p>
                <p className="text-[9px] text-slate-600 tabular-nums">{ltLineIndex + 1} / {ltFlatLines.length}</p>
              </div>
              <div className="bg-slate-800 rounded-lg px-3 py-2">
                <p className="text-[9px] text-amber-500 font-bold uppercase mb-0.5">{ltFlatLines[ltLineIndex]?.sectionLabel}</p>
                <p className="text-sm text-slate-200 font-semibold">{ltFlatLines[ltLineIndex]?.text}</p>
                {ltLinesPerDisplay === 2 && ltFlatLines[ltLineIndex + 1] && (
                  <p className="text-sm text-slate-300">{ltFlatLines[ltLineIndex + 1].text}</p>
                )}
              </div>
              {ltAtEnd ? (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-900/20 rounded border border-amber-800/40">
                  <span className="text-[9px] text-amber-500 font-bold uppercase tracking-widest">End of Song</span>
                </div>
              ) : ltFlatLines[ltLineIndex + ltLinesPerDisplay] ? (
                <div className="px-3 py-1.5">
                  <p className="text-[9px] text-slate-600 uppercase font-bold tracking-widest mb-0.5">Up Next</p>
                  <p className="text-xs text-slate-500 italic">{ltFlatLines[ltLineIndex + ltLinesPerDisplay]?.text}</p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* ── Show / Hide + Nav controls ── */}
      <div className="flex flex-col gap-2 mt-2">
        {ltMode === "lyrics" && (
          <div className="flex gap-2">
            <button
              onClick={() => ltAdvance(-1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg"
            >◀ PREV</button>
            <button
              onClick={() => ltAdvance(1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg"
            >NEXT ▶</button>
          </div>
        )}
        <button
          onClick={async () => {
            if (ltVisible) {
              try {
                await invoke("hide_lower_third");
                setLtVisible(false);
              } catch (err) { console.error("hide_lower_third failed:", err); }
            } else {
              let payload: LowerThirdData | null = null;
              if (ltMode === "nameplate") {
                payload = { kind: "Nameplate", data: { name: ltName, title: ltTitle || undefined } };
              } else if (ltMode === "freetext") {
                payload = { kind: "FreeText", data: { text: ltFreeText } };
              } else {
                if (!ltSongId || ltFlatLines.length === 0) return;
                payload = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
              }
              if (!payload) return;
              try {
                await invoke("show_lower_third", { data: payload, template: ltTemplate });
                setLtVisible(true);
              } catch (err) { console.error("show_lower_third failed:", err); }
            }
          }}
          className={`w-full py-3 text-sm font-black uppercase rounded-xl transition-all ${ltVisible ? "bg-red-700 hover:bg-red-600 text-white" : "bg-green-700 hover:bg-green-600 text-white"}`}
        >
          {ltVisible ? "HIDE Lower Third" : "SHOW Lower Third"}
        </button>
      </div>

      {/* Keyboard shortcut legend */}
      <div className="mt-2 border-t border-slate-800 pt-3">
        <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest mb-2">Keyboard Shortcuts</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {([
            ["Ctrl+Space", "Show / Hide"],
            ["H (LT tab)", "Show / Hide (Lyrics)"],
            ["Space / →", "Next line (LT tab)"],
            ["← Arrow", "Prev line (LT tab)"],
            ["Page Down", "Next line (global)"],
            ["Page Up", "Prev line (global)"],
          ] as const).map(([key, desc]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="text-[8px] font-mono bg-slate-800 text-slate-400 px-1 py-0.5 rounded border border-slate-700 whitespace-nowrap">{key}</span>
              <span className="text-[9px] text-slate-600">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* LT background image picker modal */}
      {showLtImgPicker && (
        <MediaPickerModal
          images={media.filter((m) => m.media_type === "Image")}
          onSelect={(path) => {
            setLtTemplate((t) => ({ ...t, bgType: "image", bgImagePath: path }));
          }}
          onClose={() => setShowLtImgPicker(false)}
          onUpload={async () => {
            const selected = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
            if (selected) {
              await invoke("add_media", { path: selected });
              await onLoadMedia();
            }
          }}
        />
      )}
    </div>
  );
}
