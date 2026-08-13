import React, { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { ltBuildLyricsPayload } from "../utils";
import { useKeyboardBinding } from "../hooks/keyboardRegistry";
import { useLtFlatLines } from "../hooks/useLtFlatLines";
import { LowerThirdPreview } from "./LowerThirdPreview";
import type { LowerThirdData, LtPreset, LowerThirdTemplate, Song } from "../types";

interface LowerThirdTabProps {
  onLoadMedia: () => Promise<void>;
  onSetToast: (msg: string) => void;
}

// ── Preset panel ──────────────────────────────────────────────────────────────
function PresetsPanel({ ltTemplate, ltSavedTemplates, setLtTemplate, onSetToast }: { 
  ltTemplate: LowerThirdTemplate; 
  ltSavedTemplates: LowerThirdTemplate[];
  setLtTemplate: (t: LowerThirdTemplate) => void;
  onSetToast: (msg: string) => void;
}) {
  const { currentLowerThird, ltVisible, setLtVisible, setBackendError } = useAppStore();
  const [presets, setPresets] = useState<LtPreset[]>([]);
  const [saveLabel, setSaveLabel] = useState("");
  const [saveMode, setSaveMode] = useState<"nameplate" | "lyrics" | "freetext">("nameplate");
  const [saveNpName, setSaveNpName] = useState("");
  const [saveNpTitle, setSaveNpTitle] = useState("");
  const [saveLyLine1, setSaveLyLine1] = useState("");
  const [saveLyLine2, setSaveLyLine2] = useState("");
  const [saveLyLabel, setSaveLyLabel] = useState("");
  const [saveFtText, setSaveFtText] = useState("");
  const [saveTemplateId, setSaveTemplateId] = useState(ltTemplate.id);
  const [addOpen, setAddOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setSaveTemplateId(ltTemplate.id);
  }, [addOpen, ltTemplate.id]);

  useEffect(() => {
    invoke<LtPreset[]>("list_lt_presets")
      .then(setPresets)
      .catch(() => {});
  }, []);

  async function activatePreset(preset: LtPreset) {
    try {
      // If the preset has a specific template, let's load it first if it's not the active one
      let targetTemplate = ltTemplate;
      if (preset.template_id && preset.template_id !== ltTemplate.id) {
        const found = ltSavedTemplates.find(t => t.id === preset.template_id);
        if (found) {
          targetTemplate = found;
          setLtTemplate(found);
          localStorage.setItem("activeLtTemplateId", found.id);
        }
      }
      
      await invoke("show_lt_preset", { id: preset.id, template: targetTemplate });
      onSetToast(`Showing: ${preset.label}`);
    } catch (err: any) {
      setBackendError(`Preset failed: ${err?.message ?? err}`);
    }
  }

  async function hidePreset() {
    try {
      await invoke("hide_lower_third");
      setLtVisible(false);
    } catch (err: any) {
      setBackendError(`Hide overlay failed: ${err?.message ?? err}`);
    }
  }

  async function deletePreset(id: string) {
    try {
      const updated = await invoke<LtPreset[]>("delete_lt_preset", { id });
      setPresets(updated);
      onSetToast("Preset deleted");
    } catch (err: any) {
      setBackendError(`Delete preset failed: ${err?.message ?? err}`);
    }
  }

  async function savePreset() {
    if (!saveLabel.trim()) return;
    let data: LtPreset["data"] | null = null;
    if (saveMode === "nameplate") {
      if (!saveNpName.trim()) return;
      data = { kind: "Nameplate", data: { name: saveNpName.trim(), title: saveNpTitle.trim() || undefined } };
    } else if (saveMode === "lyrics") {
      if (!saveLyLine1.trim()) return;
      data = {
        kind: "Lyrics",
        data: {
          line1: saveLyLine1.trim(),
          ...(saveLyLine2.trim() ? { line2: saveLyLine2.trim() } : {}),
          ...(saveLyLabel.trim() ? { section_label: saveLyLabel.trim() } : {}),
        },
      };
    } else {
      if (!saveFtText.trim()) return;
      data = { kind: "FreeText", data: { text: saveFtText.trim() } };
    }
    const preset: LtPreset = { 
      id: `preset-${Date.now()}`, 
      label: saveLabel.trim(), 
      template_id: saveTemplateId,
      data 
    };
    try {
      const updated = await invoke<LtPreset[]>("save_lt_preset", { preset });
      setPresets(updated);
      setSaveLabel(""); setSaveNpName(""); setSaveNpTitle("");
      setSaveLyLine1(""); setSaveLyLine2(""); setSaveLyLabel("");
      setSaveFtText("");
      setAddOpen(false);
      onSetToast("Preset saved");
    } catch (err: any) {
      setBackendError(`Save preset failed: ${err?.message ?? err}`);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border border-slate-700/60 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        className="flex items-center justify-between px-3 py-2 bg-slate-800/60 text-left"
        onClick={() => setCollapsed(p => !p)}
      >
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
          Saved Presets {presets.length > 0 ? `(${presets.length})` : ""}
        </span>
        <span className="text-slate-600 text-xs">{collapsed ? "▼" : "▲"}</span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {presets.length === 0 && (
            <p className="text-[10px] text-slate-600 italic py-1 px-1">No presets yet — add one below</p>
          )}

          {presets.map(p => {
            const isNp = p.data.kind === "Nameplate";
            const kindMeta = (() => {
              if (p.data.kind === "Nameplate") {
                return {
                  badge: "NP", cls: "bg-blue-900/40 text-blue-400",
                  summary: (p.data as { kind: "Nameplate"; data: { name: string; title?: string } }).data.name,
                };
              }
              if (p.data.kind === "Lyrics") {
                const d = (p.data as { kind: "Lyrics"; data: { line1: string; line2?: string; section_label?: string } }).data;
                return {
                  badge: "LY", cls: "bg-teal-900/40 text-teal-400",
                  summary: d.section_label ? `${d.section_label}: ${d.line1}` : d.line1,
                };
              }
              return {
                badge: "FT", cls: "bg-purple-900/40 text-purple-400",
                summary: (p.data as { kind: "FreeText"; data: { text: string } }).data.text,
              };
            })();
            
            // Check if this preset is currently active/live
            const isActive = ltVisible && currentLowerThird && 
              JSON.stringify(currentLowerThird.data) === JSON.stringify(p.data);

            return (
              <div
                key={p.id}
                className={`flex items-center gap-2 bg-slate-900 border rounded-lg px-2 py-1.5 transition-colors ${isActive ? "border-amber-500/50 bg-amber-500/5" : "border-slate-800"}`}
              >
                <span className={`shrink-0 text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${kindMeta.cls}`}>
                  {kindMeta.badge}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-slate-200 truncate">{p.label}</p>
                  <p className="text-[9px] text-slate-500 truncate">{kindMeta.summary.length > 35 ? kindMeta.summary.slice(0, 35) + "…" : kindMeta.summary}</p>
                </div>
                <button
                  onClick={() => isActive ? hidePreset() : activatePreset(p)}
                  className={`shrink-0 px-2 py-1 text-[9px] font-black rounded transition-all ${
                    isActive 
                      ? "bg-red-700 hover:bg-red-600 text-white" 
                      : "bg-amber-600 hover:bg-amber-500 text-black"
                  }`}
                >
                  {isActive ? "HIDE" : "SHOW"}
                </button>
                <button
                  onClick={() => deletePreset(p.id)}
                  className="shrink-0 text-[10px] text-slate-600 hover:text-red-500 px-1 transition-colors"
                  title="Delete preset"
                >
                  ✕
                </button>
              </div>
            );
          })}

          {/* Add new */}
          {!addOpen ? (
            <button
              onClick={() => setAddOpen(true)}
              className="w-full text-[10px] font-bold text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-lg py-1.5 transition-all"
            >
              + New Preset
            </button>
          ) : (
            <div className="flex flex-col gap-1.5 bg-slate-900 border border-slate-700 rounded-xl p-2.5">
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">New Preset</p>

              <div className="flex gap-1">
                {(["nameplate", "lyrics", "freetext"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setSaveMode(m)}
                    className={`flex-1 text-[9px] font-black py-1.5 rounded-md transition-all ${saveMode === m ? "bg-amber-600 text-black" : "bg-slate-800 text-slate-400"}`}
                  >
                    {m === "nameplate" ? "Nameplate" : m === "lyrics" ? "Lyrics" : "Free Text"}
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                <p className="text-[8px] font-bold text-slate-600 uppercase">Preset Label</p>
                <input
                  className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                  placeholder="Preset name (e.g. Host Nameplate)…"
                  value={saveLabel}
                  onChange={e => setSaveLabel(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-[8px] font-bold text-slate-600 uppercase">Style Template</p>
                <select
                  className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 focus:outline-none focus:border-amber-500/50"
                  value={saveTemplateId}
                  onChange={e => setSaveTemplateId(e.target.value)}
                >
                  {ltSavedTemplates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 pt-1">
                <p className="text-[8px] font-bold text-slate-600 uppercase">Content</p>
                {saveMode === "nameplate" ? (
                  <div className="flex flex-col gap-1.5">
                    <input
                      className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                      placeholder="Name (required)"
                      value={saveNpName}
                      onChange={e => setSaveNpName(e.target.value)}
                    />
                    <input
                      className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                      placeholder="Title / Role (optional)"
                      value={saveNpTitle}
                      onChange={e => setSaveNpTitle(e.target.value)}
                    />
                  </div>
                ) : saveMode === "lyrics" ? (
                  <div className="flex flex-col gap-1.5">
                    <input
                      className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                      placeholder="Lyric line 1 (required)"
                      value={saveLyLine1}
                      onChange={e => setSaveLyLine1(e.target.value)}
                    />
                    <input
                      className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                      placeholder="Lyric line 2 (optional)"
                      value={saveLyLine2}
                      onChange={e => setSaveLyLine2(e.target.value)}
                    />
                    <input
                      className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 focus:outline-none focus:border-amber-500/50"
                      placeholder="Section label e.g. Chorus (optional)"
                      value={saveLyLabel}
                      onChange={e => setSaveLyLabel(e.target.value)}
                    />
                  </div>
                ) : (
                  <textarea
                    className="w-full bg-slate-800 text-slate-200 text-xs rounded-md px-2 py-1.5 border border-slate-700 placeholder-slate-600 resize-none h-16 focus:outline-none focus:border-amber-500/50"
                    placeholder="Text to display…"
                    value={saveFtText}
                    onChange={e => setSaveFtText(e.target.value)}
                  />
                )}
              </div>

              <div className="flex gap-1.5">
                <button
                  onClick={savePreset}
                  disabled={!saveLabel.trim() || (saveMode === "nameplate" ? !saveNpName.trim() : saveMode === "lyrics" ? !saveLyLine1.trim() : !saveFtText.trim())}
                  className="flex-1 py-1.5 text-[10px] font-black bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-black rounded-md transition-all"
                >
                  Save
                </button>
                <button
                  onClick={() => { setAddOpen(false); setSaveLabel(""); setSaveNpName(""); setSaveNpTitle(""); setSaveLyLine1(""); setSaveLyLine2(""); setSaveLyLabel(""); setSaveFtText(""); }}
                  className="px-3 text-[10px] font-bold bg-slate-800 text-slate-400 rounded-md"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function LowerThirdTab({ onSetToast }: LowerThirdTabProps) {
  const {
    activeTab,
    setActiveTab,
    songs, setSongs,
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
    quickLyricsText, setQuickLyricsText,
    settings,
    setBackendError, setToast,
  } = useAppStore();

  const ltAutoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ltFlatLines = useLtFlatLines();

  // Draft nameplate / free text, used for the styled preview and for
  // live-updating the overlay while it is on air.
  const ltDraftPayload = useMemo((): LowerThirdData | null => {
    if (ltMode === "nameplate") {
      return ltName.trim() ? { kind: "Nameplate", data: { name: ltName, title: ltTitle.trim() || undefined } } : null;
    }
    if (ltMode === "freetext") {
      return ltFreeText.trim() ? { kind: "FreeText", data: { text: ltFreeText } } : null;
    }
    return null;
  }, [ltMode, ltName, ltTitle, ltFreeText]);

  // Live-update nameplate/free text on air without requiring hide → show.
  useEffect(() => {
    if (!ltVisible || ltMode === "lyrics" || !ltDraftPayload) return;
    const timer = setTimeout(() => {
      invoke("show_lower_third", { data: ltDraftPayload, template: ltTemplate })
        .catch((err: any) => setBackendError(`Overlay update failed: ${err?.message ?? err}`));
    }, 350);
    return () => clearTimeout(timer);
  }, [ltDraftPayload, ltVisible, ltMode, ltTemplate, setBackendError]);

  // Phase 7: if the selected song is deleted from the library, reset the
  // selection so the panel never renders against a missing song. A live
  // overlay that was already sent is not force-hidden — the operator can
  // still hide it manually; only the *selection* is cleared.
  useEffect(() => {
    if (!ltSongId || ltSongId === "quick-lyrics") return;
    if (ltSongId && !songs.some((s) => s.id === ltSongId)) {
      setLtSongId(null);
      setLtLineIndex(0);
      setLtAtEnd(false);
    }
  }, [songs, ltSongId, setLtSongId, setLtLineIndex, setLtAtEnd]);

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

  // ── Lyrics-mode keyboard shortcuts (priority 10 — overrides operator defaults) ──
  useKeyboardBinding("lt-lyrics", 10, () => {
    if (activeTab !== "lower-third" || ltMode !== "lyrics") return false;
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    return true;
  }, (e) => {
    if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); ltAdvance(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); ltAdvance(-1); }
    else if (e.key === "h" || e.key === "H") {
      if (ltVisible) {
        invoke("hide_lower_third")
          .then(() => setLtVisible(false))
          .catch((err: any) => setBackendError(`Hide overlay failed: ${err?.message ?? err}`));
      } else {
        if (!ltSongId || ltFlatLines.length === 0) return;
        const payload = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
        if (!payload) return;
        invoke("show_lower_third", { data: payload, template: ltTemplate })
          .then(() => setLtVisible(true))
          .catch((err: any) => setBackendError(`Show overlay failed: ${err?.message ?? err}`));
      }
    }
  });

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
          Promise.resolve().then(() => ltSendCurrent(next)).catch((err: any) => setBackendError(`Overlay update failed: ${err?.message ?? err}`));
          if (next >= maxIdx) setLtAtEnd(true);
          return next;
        });
      }, ltAutoSeconds * 1000);
    }
    return () => { if (ltAutoRef.current) clearInterval(ltAutoRef.current); };
  }, [ltAutoAdvance, ltVisible, ltMode, ltAutoSeconds, ltLinesPerDisplay, ltFlatLines, ltSendCurrent]);

  const canShow = ltMode === "nameplate"
    ? ltName.trim().length > 0
    : ltMode === "freetext"
    ? ltFreeText.trim().length > 0
    : Boolean(ltSongId && ltFlatLines.length > 0);

  return (
    <div className="flex flex-col gap-3">

      <div className="flex items-center justify-between gap-3 rounded-xl border border-console-border bg-console-surface-raised/70 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-console-text-muted">Live Lower Third</p>
          <p className="mt-0.5 text-xs text-console-text-subtle">Prepare a name, lyric, or message for output.</p>
        </div>
        <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${ltVisible ? "border-state-live/50 bg-state-live-soft text-state-live" : "border-console-border bg-console-surface text-console-text-subtle"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${ltVisible ? "bg-state-live" : "bg-console-text-subtle"}`} />
          {ltVisible ? "On air" : "Hidden"}
        </span>
      </div>

      {/* ── Saved presets (at top for quick access) ── */}
      <PresetsPanel 
        ltTemplate={ltTemplate} 
        ltSavedTemplates={ltSavedTemplates}
        setLtTemplate={setLtTemplate}
        onSetToast={onSetToast} 
      />

      {/* ── Template selector ── */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-console-border bg-console-surface/70 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-console-text-muted uppercase font-bold tracking-widest">Style template</span>
          <button
            type="button"
            onClick={() => setActiveTab("lt-designer")}
            className="text-[10px] font-bold text-tool-design hover:text-purple-300 transition-colors"
          >
            Open designer
          </button>
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

      {/* ── Mode tabs ── */}
      <div className="flex rounded-lg overflow-hidden border border-slate-700 shrink-0">
        {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
          <button key={m} onClick={() => setLtMode(m)} aria-pressed={ltMode === m}
            className={`min-h-10 flex-1 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${ltMode === m ? "bg-console-surface-strong text-action-primary" : "text-console-text-subtle hover:text-console-text"}`}>
            {m === "freetext" ? "Free Text" : m === "nameplate" ? "Nameplate" : "Lyrics"}
          </button>
        ))}
      </div>

      {/* ── Nameplate ── */}
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
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-slate-400 uppercase font-bold">Auto-hide after:</span>
            <input
              type="number" min={0} max={60}
              className="w-12 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700 text-center focus:outline-none focus:border-amber-500"
              value={ltTemplate.autoHideSeconds || 0}
              onChange={(e) => setLtTemplate(p => ({ ...p, autoHideSeconds: parseInt(e.target.value) || 0 }))}
            />
            <span className="text-[10px] text-slate-500">sec</span>
            <span className="text-[9px] text-slate-600 italic ml-1">(0 = manual)</span>
          </div>
        </div>
      )}

      {/* ── Free text ── */}
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
          {ltTemplate.scrollEnabled && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-slate-400 uppercase font-bold">Repeats:</span>
              <input
                type="number" min={0} max={50}
                className="w-12 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700 text-center focus:outline-none focus:border-amber-500"
                value={ltTemplate.scrollCount || 0}
                onChange={(e) => setLtTemplate(p => ({ ...p, scrollCount: parseInt(e.target.value) || 0 }))}
              />
              <span className="text-[9px] text-slate-600 italic">(0 = infinite)</span>
            </div>
          )}
        </div>
      )}

      {/* ── Lyrics ── */}
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
                value={quickLyricsText}
                onChange={(e) => { setQuickLyricsText(e.target.value); setLtLineIndex(0); }}
              />
              <button
                onClick={async () => {
                  const lines = quickLyricsText.split("\n").filter(l => l.trim());
                  if (lines.length === 0) return;
                  const song: Song = {
                    id: "",
                    title: "Quick Lyrics " + new Date().toLocaleDateString(),
                    sections: [{ label: "QUICK", lines }],
                    arrangement: ["QUICK"],
                    style: "LowerThird",
                  };
                  try {
                    const saved = await invoke<Song>("save_song", { song });
                    const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
                    setSongs(next);
                    emit("songs-sync", next);
                    setLtSongId(saved.id);
                    setQuickLyricsText("");
                    setToast("Saved as song");
                  } catch (err: any) {
                    setBackendError(`Save failed: ${err?.message ?? err}`);
                  }
                }}
                className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded transition-all"
              >
                Save as Song
              </button>
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
              <span className="text-[10px] text-slate-400 uppercase font-bold ml-1">Auto-hide:</span>
              <input
                type="number" min={0} max={60}
                className="w-10 bg-slate-800 text-slate-200 text-xs rounded px-1 py-1 border border-slate-700 text-center focus:outline-none focus:border-amber-500"
                value={ltTemplate.autoHideSeconds || 0}
                onChange={(e) => setLtTemplate(p => ({ ...p, autoHideSeconds: parseInt(e.target.value) || 0 }))}
              />
              <span className="text-[9px] text-slate-500">sec</span>
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

      {/* ── Live lower-third preview (nameplate / free text) ── */}
      {ltMode !== "lyrics" && (
        <div className="flex flex-col gap-1.5 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-slate-600 uppercase font-bold tracking-widest">Live Preview</p>
            <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${ltVisible ? "bg-green-900/40 text-green-400" : "bg-slate-800 text-slate-500"}`}>
              {ltVisible ? "ON AIR" : "HIDDEN"}
            </span>
          </div>
          <LowerThirdPreview
            data={ltDraftPayload ?? (ltMode === "nameplate"
              ? { kind: "Nameplate", data: { name: ltName || "Name", title: ltTitle || undefined } }
              : { kind: "FreeText", data: { text: ltFreeText || "Your message appears here" } })}
            template={ltTemplate}
            refHeight={settings.reference_output_height ?? 1080}
            background="dark"
            className="w-full h-44"
          />
          {!ltVisible && ltDraftPayload && (
            <div className="px-1 py-0.5">
              <p className="text-[9px] text-slate-600 uppercase font-bold tracking-widest mb-0.5">Ready to show</p>
              <p className="text-xs text-slate-500 italic truncate">
                {ltMode === "nameplate" ? `${ltName}${ltTitle.trim() ? ` — ${ltTitle}` : ""}` : ltFreeText}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex flex-col gap-2 pt-1">
        {ltMode === "lyrics" && (
          <div className="flex gap-2">
            <button onClick={() => ltAdvance(-1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-all">
              ◀ PREV
            </button>
            <button onClick={() => ltAdvance(1)}
              className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-all">
              NEXT ▶
            </button>
          </div>
        )}
        <button
          disabled={!ltVisible && !canShow}
          onClick={async () => {
            if (ltVisible) {
              try { await invoke("hide_lower_third"); setLtVisible(false); }
              catch (err: any) { setBackendError(`Hide overlay failed: ${err?.message ?? err}`); }
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
              catch (err: any) { setBackendError(`Show overlay failed: ${err?.message ?? err}`); }
            }
          }}
          className={`w-full min-h-12 text-sm font-black uppercase rounded-xl transition-all ${
            ltVisible
              ? "bg-console-surface-strong hover:bg-state-live-soft text-state-live border border-state-live/60"
              : "bg-state-live hover:bg-red-400 text-white shadow-[0_0_16px_rgba(240,68,85,0.24)] disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          {ltVisible ? "Hide lower third" : "Show lower third"}
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
