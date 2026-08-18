import React, { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { AlertTriangle, CalendarDays, ChevronRight, Clock, EyeOff, Layers, Undo2, X, Zap, Loader2 } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid, resolvePath } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import { LowerThirdPreview } from "../LowerThirdPreview";
import { PropsRenderer } from "../shared/Renderers";
import { ProgramFeedPreview } from "../outputs/ProgramFeedPreview";
import { ClearAllModal } from "./ClearAllModal";
import { Button, ProgressBar } from "../ui";
import { itemMetaAt } from "../../items/registry";
import type { DisplayItem, PresentationSettings } from "../../types";
import type { ClearSnapshot } from "../../hooks/useItemActions";

interface CockpitProps {
  nextLiveItem: DisplayItem | null;
  stageItem: (item: DisplayItem) => Promise<boolean>;
  goLive: () => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  clearStaged: () => Promise<boolean>;
  clearAll: () => Promise<ClearSnapshot | null>;
  undoClearAll: (snapshot: ClearSnapshot) => Promise<boolean>;
  persistSchedule: () => Promise<void>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  cockpitWidth: number;
  setCockpitWidth: (v: number) => void;
}

export function Cockpit({
  nextLiveItem,
  stageItem,
  goLive,
  sendLive,
  clearStaged,
  clearAll,
  undoClearAll,
  persistSchedule,
  updateSettings,
  cockpitWidth,
  setCockpitWidth,
}: CockpitProps) {
  const {
    stagedItem,
    liveItem, setLiveItem,
    previousItem,
    scheduleEntries, pushScheduleState,
    settings, setSettings, setIsBlackout,
    busyActions,
    setBackendError,
    setBusyAction,
    currentLowerThird,
    propItems, appDataDir,
    outputs, outputStates,
  } = useAppStore();

  // Authoritative output-window visibility (Phase 8 readiness indicator).
  const outputOn =
    outputStates["output"]?.visible ??
    outputs.find((o) => o.window_label === "output")?.visible ??
    false;

  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearSnapshot, setClearSnapshot] = useState<ClearSnapshot | null>(null);
  const [, setNowTick] = useState(0);
  const [pgmCanvasView, setPgmCanvasView] = useState(false);

  // Re-render every second while a live timer is showing so countdown
  // progress/remaining time stays accurate in the cockpit metadata row.
  useEffect(() => {
    if (liveItem?.type !== "Timer" || !liveItem.data.started_at) return;
    const t = window.setInterval(() => setNowTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [liveItem]);

  const goLiveBusy = busyActions.includes("goLive");
  const clearBusy = busyActions.includes("clearLive");
  const clearAllBusy = busyActions.includes("clear");
  const saveBusy = busyActions.includes("save");

  const clearLive = async () => {
    setBusyAction("clearLive", true);
    try {
      await invoke("clear_live");
      setLiveItem(null);
    } catch (e: any) {
      setBackendError(`Clear failed: ${e?.message ?? e}`);
    } finally {
      setBusyAction("clearLive", false);
    }
  };

  const handleClearAll = async () => {
    const snapshot = await clearAll();
    if (snapshot) setClearSnapshot(snapshot);
  };

  const handleUndoClear = async () => {
    if (!clearSnapshot) return;
    await undoClearAll(clearSnapshot);
    setClearSnapshot(null);
  };

  const meta = (item: DisplayItem | null) => (item ? itemMetaAt(item, Date.now()) : null);

  const metaRow = (item: DisplayItem | null, tone: "stage" | "live") => {
    const m = meta(item);
    if (!m) return null;
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[8px] font-black uppercase tracking-widest text-console-text-subtle shrink-0">{m.kindLabel}</span>
        <span className="text-[9px] font-bold text-console-text truncate flex-1" title={m.title}>{m.title}</span>
        {m.detail && <span className="text-[8px] font-bold text-console-text-subtle shrink-0">{m.detail}</span>}
        {m.durationLabel && <span className="text-[8px] font-mono text-console-text-subtle shrink-0">⏱ {m.durationLabel}</span>}
      </div>
    );
  };

  const progress = (item: DisplayItem | null, tone: "stage" | "live") => {
    const m = meta(item);
    if (!m || m.progress === null) return null;
    return <ProgressBar value={m.progress} tone={tone} label={m.progressLabel ?? undefined} className="mt-1.5" />;
  };

  return (
    <>
      {/* Drag handle */}
      <div
        className="w-1 bg-console-border hover:bg-action-primary/40 cursor-col-resize transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)]"
        role="slider"
        tabIndex={0}
        aria-label="Cockpit width"
        aria-valuemin={280}
        aria-valuemax={480}
        aria-valuenow={cockpitWidth}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); const n = Math.min(480, cockpitWidth + 16); setCockpitWidth(n); localStorage.setItem("pref_cockpitWidth", String(Math.round(n))); }
          else if (e.key === "ArrowRight") { e.preventDefault(); const n = Math.max(280, cockpitWidth - 16); setCockpitWidth(n); localStorage.setItem("pref_cockpitWidth", String(Math.round(n))); }
        }}
        onMouseDown={(e) => {
          const startX = e.clientX; const startW = cockpitWidth;
          const move = (em: MouseEvent) => {
            const next = Math.max(280, Math.min(480, startW - (em.clientX - startX)));
            setCockpitWidth(next); localStorage.setItem("pref_cockpitWidth", String(Math.round(next)));
          };
          const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        }}
      />
      <aside className="bg-console-surface border-l border-console-border flex flex-col shrink-0 overflow-hidden" style={{ width: cockpitWidth }}>

        {/* STAGED preview */}
        <div className="p-3 border-b border-console-border flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-state-stage shrink-0" />
              <span className="text-[10px] font-black uppercase tracking-widest text-state-stage">Staged · Preview</span>
              {stagedItem && (
                <span className="text-[8px] font-bold text-console-text-subtle truncate hidden 2xl:inline">{displayItemLabel(stagedItem)}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button variant="bare" size="sm" onClick={() => clearStaged()}
                disabled={!stagedItem}
                className="text-console-text-subtle hover:text-state-live hover:bg-state-live-soft">
                <X size={11} /> Clear
              </Button>
              <Button variant="primary" size="md" onClick={goLive} disabled={!stagedItem || goLiveBusy} loading={goLiveBusy}
                className="px-3.5 text-[11px]">
                <Zap size={12} fill="currentColor" /> Go Live
              </Button>
            </div>
          </div>
          <div className="w-full rounded-lg overflow-hidden ring-1 ring-state-stage/30 bg-black" style={{ aspectRatio: "16/9" }}>
            <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Stage is empty" isLocalPreview={true} hideHeader />
          </div>
          {metaRow(stagedItem, "stage")}
          {progress(stagedItem, "stage")}

          {/* Up Next strip */}
          {nextLiveItem && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-console-canvas/60 rounded-md border border-state-stage/25">
              <span className="text-[8px] text-state-stage uppercase font-black shrink-0 tracking-widest">Up Next</span>
              <span className="text-[9px] text-console-text-muted truncate flex-1">{displayItemLabel(nextLiveItem)}</span>
              <button onClick={() => sendLive(nextLiveItem)}
                className="text-[8px] font-black bg-console-surface-strong hover:bg-action-primary hover:text-black text-console-text-muted px-2 py-1 rounded transition-all flex items-center gap-0.5 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">
                SEND <ChevronRight size={9} />
              </button>
            </div>
          )}
        </div>

        {/* ON AIR preview */}
        <div className="p-3 border-b border-console-border flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-state-live animate-pulse shrink-0" />
              <span className="text-[10px] font-black uppercase tracking-widest text-state-live">On Air · Program → Output</span>
              {liveItem && (
                <span className="text-[8px] font-bold text-console-text-subtle truncate hidden 2xl:inline">{displayItemLabel(liveItem)}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {previousItem && (
                <button onClick={() => sendLive(previousItem)}
                  className="px-2 py-1 text-[8px] font-black uppercase rounded bg-console-surface-strong hover:bg-console-surface-raised text-console-text-muted flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
                  title={`Return to: ${displayItemLabel(previousItem)}`}>
                  <Clock size={9} /> Previous
                </button>
              )}
              <button onClick={() => setPgmCanvasView((v) => !v)}
                aria-pressed={pgmCanvasView}
                className={`px-2 py-1 text-[8px] font-black uppercase rounded flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${pgmCanvasView ? "bg-tool-design text-white" : "bg-console-surface-strong text-console-text-muted hover:text-console-text"}`}
                title="Toggle the Phase 2 canvas compositor preview (what recording/streaming will capture)">
                <Layers size={9} /> PGM
              </button>
              <Button variant="live" size="md" onClick={clearLive} disabled={clearBusy} loading={clearBusy}
                className="px-3" aria-label="Clear live output only">
                <X size={12} /> Clear Live
              </Button>
            </div>
          </div>
          {/* Output readiness indicator (Phase 8) */}
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${outputOn ? "bg-state-success" : "bg-state-warning"}`} />
            <span className={`text-[8px] font-black uppercase tracking-widest ${outputOn ? "text-state-success" : "text-state-warning"}`}>
              Output {outputOn ? "On" : "Off"}
            </span>
            {!outputOn && (
              <span className="text-[8px] text-console-text-subtle">— press Ctrl+O to show the audience output</span>
            )}
          </div>
          <div className="w-full rounded-lg overflow-hidden ring-2 ring-state-live/30 bg-black relative" style={{ aspectRatio: "16/9" }}>
            {pgmCanvasView ? (
              /* Phase 2 canvas compositor — the single render path that
                  recorder/streamer surfaces will capture. Its rasterization
                  includes background, content, logo, props, lower third, and
                  blanking, so the DOM overlays below are skipped in this mode. */
              <ProgramFeedPreview className="absolute inset-0 w-full h-full" />
            ) : (
              <PreviewCard item={liveItem} label="" accent="" badge={null} empty="Output is empty" hideHeader />
            )}

            {/* Background logo — full-screen black backdrop, mirroring the
                output window's z-50 layer exactly. */}
            {!pgmCanvasView && !settings.is_blanked && settings.show_background_logo && (settings.background_logo_path || settings.background_logo_text) && (
              <div className="absolute inset-0 z-50 bg-black">
                {settings.background_logo_text ? (
                  <div className="w-full h-full flex items-center justify-center px-4 text-center">
                    <p
                      className="font-black leading-tight drop-shadow-lg"
                      style={{ color: settings.background_logo_text_color ?? "#ffffff", fontSize: "2.25rem" }}
                    >
                      {settings.background_logo_text}
                    </p>
                  </div>
                ) : settings.background_logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
                  <video
                    src={convertFileSrc(resolvePath(settings.background_logo_path, appDataDir))}
                    className="w-full h-full"
                    style={{ objectFit: settings.background_logo_fit ?? "cover" }}
                    autoPlay
                    loop
                    muted
                  />
                ) : settings.background_logo_path ? (
                  <img
                    src={convertFileSrc(resolvePath(settings.background_logo_path, appDataDir))}
                    className="w-full h-full"
                    style={{ objectFit: settings.background_logo_fit ?? "cover" }}
                    alt="Background Logo"
                  />
                ) : null}
              </div>
            )}

            {/* Corner logo (bottom-right), mirroring the output's z-60 layer. */}
            {!pgmCanvasView && !settings.is_blanked && (settings.logo_text || settings.logo_path) && (
              <div className="absolute bottom-2 right-2 z-60">
                {settings.logo_text ? (
                  <p
                    className="font-black leading-tight opacity-60 text-right"
                    style={{ color: settings.logo_text_color ?? "#ffffff", fontSize: "0.9rem" }}
                  >
                    {settings.logo_text}
                  </p>
                ) : settings.logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
                  <video
                    src={convertFileSrc(resolvePath(settings.logo_path, appDataDir))}
                    className="w-10 h-10 object-contain opacity-50"
                    autoPlay
                    loop
                    muted
                  />
                ) : settings.logo_path ? (
                  <img
                    src={convertFileSrc(resolvePath(settings.logo_path, appDataDir))}
                    className="w-10 h-10 object-contain opacity-50"
                    alt="Logo"
                  />
                ) : null}
              </div>
            )}

            {/* Persistent props overlays — same layer as the output window. */}
            {!pgmCanvasView && !settings.is_blanked && propItems.length > 0 && (
              <PropsRenderer items={propItems} appDataDir={appDataDir} />
            )}

            {/* Lower third — authoritative backend state, shown whenever it is
                on air regardless of the local ltVisible flag. */}
            {!pgmCanvasView && !settings.is_blanked && currentLowerThird && (
              <LowerThirdPreview
                data={currentLowerThird.data}
                template={currentLowerThird.template}
                refHeight={settings.reference_output_height ?? 1080}
                background="transparent"
                className="absolute inset-0 z-40 pointer-events-none"
              />
            )}

            {/* Blackout — mirrors the output window's full-black early return. */}
            {settings.is_blanked && (
              <div className="absolute inset-0 z-[70] bg-black" />
            )}
          </div>
          {metaRow(liveItem, "live")}
          {progress(liveItem, "live")}
        </div>

        {/* Emergency controls — clearly labeled cluster. Blackout, clear live,
            and clear all are visually distinct (text + icon + tone). */}
        <div className="px-3 py-2 border-b border-console-border shrink-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-state-live/80 flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={10} /> Emergency Controls
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <button onClick={() => { const nb = !settings.is_blanked; updateSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); }}
              aria-pressed={settings.is_blanked}
              className={`py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${settings.is_blanked ? "bg-state-warning text-black" : "bg-console-surface-raised text-console-text-muted hover:text-state-warning"}`}>
              <EyeOff size={11} />{settings.is_blanked ? "UNBLK" : "BLKOUT"}
            </button>
            <button onClick={clearLive} disabled={clearBusy} aria-label="Clear live output only"
              className="py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] bg-console-surface-raised text-console-text-muted hover:text-state-live hover:bg-state-live-soft disabled:opacity-50">
              {clearBusy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />} CLEAR LIVE
            </button>
            <button onClick={() => setClearModalOpen(true)} disabled={clearAllBusy}
              className="py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] bg-console-surface-raised text-console-text-muted hover:text-state-live hover:bg-state-live-soft disabled:opacity-50">
              {clearAllBusy ? <Loader2 size={11} className="animate-spin" /> : <Layers size={11} />}CLEAR ALL
            </button>
          </div>
          {clearSnapshot && (
            <button onClick={handleUndoClear} disabled={clearAllBusy}
              className="mt-1.5 w-full py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] bg-state-live/20 hover:bg-state-live text-state-live hover:text-console-text disabled:opacity-50">
              {clearAllBusy ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} RESTORE
            </button>
          )}
          <button onClick={() => { const nl = !settings.show_background_logo; updateSettings({ ...settings, show_background_logo: nl }); }}
            aria-pressed={settings.show_background_logo}
            className={`mt-1.5 w-full py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${settings.show_background_logo ? "bg-tool-design text-white" : "bg-console-surface-raised text-console-text-subtle hover:text-console-text-muted"}`}>
            <Layers size={11} />BG LOGO
          </button>
        </div>

        {/* Clear All undo affordance */}
        {clearSnapshot && (
          <div className="px-3 py-2 border-b border-console-border flex items-center gap-2 bg-state-live-soft">
            <span className="text-[9px] text-state-live font-bold flex-1">Output cleared</span>
            <button onClick={handleUndoClear} disabled={clearAllBusy}
              className="text-[8px] font-black bg-state-live/20 hover:bg-state-live text-console-text px-2 py-1 rounded transition-all flex items-center gap-1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">
              {clearAllBusy ? <Loader2 size={9} className="animate-spin" /> : <Undo2 size={9} />} UNDO
            </button>
          </div>
        )}

        {/* Service Setlist */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-console-border flex items-center justify-between shrink-0">
            <h2 className="text-[9px] font-black uppercase tracking-widest text-console-text-subtle flex items-center gap-1.5">
              <CalendarDays size={12} className="text-action-primary" /> Service Plan
            </h2>
            <button onClick={persistSchedule} disabled={saveBusy} className="text-[8px] font-black bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted px-2 py-1 rounded transition-colors flex items-center gap-1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]">{saveBusy && <Loader2 size={9} className="animate-spin" />}SAVE</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 px-2 space-y-0.5 custom-scrollbar">
            {scheduleEntries.map((e, i) => (
              <div key={e.id} onClick={() => stageItem(e.item)}
                className={`group px-2 py-2 rounded-lg border cursor-pointer transition-all focus-within:border-action-primary/50 ${
                  stagedItem && getItemUid(stagedItem) === getItemUid(e.item) ? "bg-state-stage-soft border-state-stage/30"
                  : liveItem && getItemUid(liveItem) === getItemUid(e.item) ? "bg-state-live-soft border-state-live/30"
                  : "bg-console-canvas/60 border-console-border/60 hover:border-console-border-strong"
                }`}>
                <div className="flex items-center gap-2">
                  <span className="text-[8px] font-black text-console-text-subtle w-3.5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-console-text truncate">{displayItemLabel(e.item)}</p>
                    <p className="text-[7px] text-console-text-subtle uppercase font-black">{e.item.type}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={(em) => { em.stopPropagation(); sendLive(e.item); }} aria-label="Go live with this item"
                      className="p-1.5 rounded bg-console-surface-strong hover:bg-action-primary hover:text-black text-console-text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"><Zap size={9} fill="currentColor" /></button>
                    <button onClick={(em) => { em.stopPropagation(); const next = scheduleEntries.filter(se => se.id !== e.id); pushScheduleState(next); persistSchedule(); }} aria-label="Remove from service plan"
                      className="p-1.5 rounded bg-console-surface-strong hover:bg-state-live text-console-text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"><X size={9} /></button>
                  </div>
                </div>
              </div>
            ))}
            {scheduleEntries.length === 0 && (
              <p className="text-center text-console-text-subtle text-[10px] italic py-6">No items in service plan</p>
            )}
          </div>
        </div>
      </aside>

      <ClearAllModal
        open={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        onConfirm={handleClearAll}
      />
    </>
  );
}
