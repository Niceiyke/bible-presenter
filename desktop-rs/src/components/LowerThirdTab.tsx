import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ltBuildLyricsPayload } from "../utils";
import type { LowerThirdData } from "../types";

interface LowerThirdTabProps {
  onLoadMedia: () => Promise<void>;
  onSetToast: (msg: string) => void;
}

export function LowerThirdTab({ onSetToast }: LowerThirdTabProps) {
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

      <div className="flex rounded-lg overflow-hidden border border-slate-700 shrink-0">
        {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
          <button key={m} onClick={() => setLtMode(m)}
            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${ltMode === m ? "bg-slate-700 text-amber-400" : "text-slate-500 hover:text-slate-300"}`}>
            {m === "freetext" ? "Free Text" : m === "nameplate" ? "Nameplate" : "Lyrics"}
          </button>
        ))}
      </div>

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
            <button 
              onClick={() => {
                if (ltSongId === "quick-lyrics") {
                  setLtSongId(null);
                } else {
                  setLtSongId("quick-lyrics");
                  if (!songs.find(s => s.id === "quick-lyrics")) {
                    setSongs([...songs, { id: "quick-lyrics", title: "Quick Lyrics", sections: [{ label: "QUICK", lines: [] }], arrangement: ["QUICK"] } as any]);
                  }
                  setLtLineIndex(0);
                }
              }}
              className={`px-3 py-2 rounded-lg border text-[10px] font-bold transition-all ${ltSongId === "quick-lyrics" ? "bg-amber-500 text-black border-amber-400" : "bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200"}`}
              title="Quick Lyrics Entry"
            >
              QUICK
            </button>
          </div>

          {ltSongId === "quick-lyrics" && (
            <div className="flex flex-col gap-2 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
              <p className="text-[9px] text-slate-500 uppercase font-black">Quick Paste (Newlines = Lines)</p>
              <textarea
                className="w-full bg-slate-900 text-slate-200 text-[11px] rounded p-2 border border-slate-700 focus:outline-none focus:border-amber-500/50 resize-none h-20"
                placeholder="Paste lyrics here..."
                onChange={(e) => {
                  const lines = e.target.value.split("\n").filter(l => l.trim());
                  const quickSong = {
                    id: "quick-lyrics",
                    title: "Quick Lyrics",
                    sections: [{ label: "QUICK", lines }],
                    arrangement: ["QUICK"]
                  };
                  setSongs([...songs.filter(s => s.id !== "quick-lyrics"), quickSong as any]);
                }}
              />
            </div>
          )}

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
