import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useAppStore } from "../store";
import type { LowerThirdData, LowerThirdTemplate } from "../App";

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

// ─── LowerThirdTab — Fire-Only Operator Panel ─────────────────────────────────
// Design controls (bg/accent/position/typography/animation) live in Design Hub.

interface LowerThirdTabProps {
  onLoadMedia: () => Promise<void>;
  onSetToast: (msg: string) => void;
}

export default function LowerThirdTab({ onSetToast }: LowerThirdTabProps) {
  const {
    activeTab,
    songs,
    ltMode, setLtMode,
    ltVisible, setLtVisible,
    ltTemplate, setLtTemplate,
    ltSavedTemplates,
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
          for (const line of sec.lines) flat.push({ text: line, sectionLabel: sec.label });
        }
      }
    } else {
      for (const section of sections) {
        for (const line of section.lines) flat.push({ text: line, sectionLabel: section.label });
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

  // Keyboard shortcuts (Space/→ = next, ← = prev, H = show/hide) — active in LT tab lyrics mode
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
    <div className="flex flex-col gap-3 p-3">

      {/* ── Template selector ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Template</span>
          <span className="text-[9px] text-purple-400/60 italic">Edit in Design Hub ↗</span>
        </div>
        <select
          className="w-full bg-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 border border-slate-700 focus:outline-none focus:border-amber-500"
          value={ltTemplate.id}
          onChange={(e) => {
            const found = ltSavedTemplates.find((t) => t.id === e.target.value);
            if (found) { setLtTemplate(found); localStorage.setItem("activeLtTemplateId", found.id); }
          }}
        >
          {ltSavedTemplates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* ── Mode selector ── */}
      <div className="flex rounded-lg overflow-hidden border border-slate-700 shrink-0">
        {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
          <button key={m} onClick={() => setLtMode(m)}
            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${ltMode === m ? "bg-slate-700 text-amber-400" : "text-slate-500 hover:text-slate-300"}`}>
            {m === "freetext" ? "Free Text" : m === "nameplate" ? "Nameplate" : "Lyrics"}
          </button>
        ))}
      </div>

      {/* ── Nameplate mode ── */}
      {ltMode === "nameplate" && (
        <div className="flex flex-col gap-2">
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
          <div className="flex gap-1.5 items-center flex-wrap">
            <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Scroll:</span>
            {([
              { label: "Static", enabled: false, dir: null },
              { label: "→→", enabled: true, dir: "ltr" as const },
              { label: "←←", enabled: true, dir: "rtl" as const },
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
                <div className="px-3 py-1.5 bg-amber-900/20 rounded border border-amber-800/40">
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

      {/* ── PREV / NEXT + SHOW/HIDE ── */}
      <div className="flex flex-col gap-2 pt-1">
        {ltMode === "lyrics" && (
          <div className="flex gap-2">
            <button
              onClick={() => ltAdvance(-1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-all"
            >◀ PREV</button>
            <button
              onClick={() => ltAdvance(1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-all"
            >NEXT ▶</button>
          </div>
        )}
        <button
          onClick={async () => {
            if (ltVisible) {
              try { await invoke("hide_lower_third"); setLtVisible(false); }
              catch (err) { console.error("hide_lower_third failed:", err); }
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
              try { await invoke("show_lower_third", { data: payload, template: ltTemplate }); setLtVisible(true); }
              catch (err) { console.error("show_lower_third failed:", err); }
            }
          }}
          className={`w-full py-3 text-sm font-black uppercase rounded-xl transition-all ${
            ltVisible
              ? "bg-red-700 hover:bg-red-600 text-white shadow-[0_0_16px_rgba(185,28,28,0.4)]"
              : "bg-green-700 hover:bg-green-600 text-white"
          }`}
        >
          {ltVisible ? "■ HIDE Lower Third" : "▶ SHOW Lower Third"}
        </button>
      </div>

      {/* ── Keyboard shortcut legend ── */}
      <div className="border-t border-slate-800 pt-3">
        <p className="text-[9px] font-black text-slate-700 uppercase tracking-widest mb-2">Keyboard (LT tab active)</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {([
            ["Space / →", "Next line"],
            ["← Arrow", "Prev line"],
            ["H", "Show / Hide"],
          ] as const).map(([key, desc]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="text-[8px] font-mono bg-slate-800 text-slate-400 px-1 py-0.5 rounded border border-slate-700 whitespace-nowrap">{key}</span>
              <span className="text-[9px] text-slate-600">{desc}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
