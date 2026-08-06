import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DisplayItem, PresentationSettings, TimerData } from "../types";
import { THEMES } from "../types";
import { displayItemLabel } from "../utils";
import { stageDetail as stageDetailFor } from "../items/registry";
import { CustomSlideRenderer } from "../components/shared/Renderers";
import { useAppStore } from "../store";
import { useT } from "../i18n";
import { signalOperatorWarning } from "../hooks/useAppInitialization";

function formatClock(d: Date) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function computeTimerDisplay(data: TimerData, now: number): string {
  if (data.timer_type === "clock") return formatClock(new Date(now));
  const started = data.started_at ?? 0;
  if (!started) {
    const total = data.duration_secs ?? 0;
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${mm}:${ss.toString().padStart(2, "0")}`;
  }
  const elapsed = Math.floor((now - started) / 1000);
  if (data.timer_type === "countup") {
    const mm = Math.floor(elapsed / 60);
    const ss = elapsed % 60;
    return `${mm}:${ss.toString().padStart(2, "0")}`;
  }
  // countdown
  const remaining = Math.max(0, (data.duration_secs ?? 0) - elapsed);
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function StageWindow() {
  const { appDataDir, setAppDataDir } = useAppStore();
  const t = useT();
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [settings, setSettings] = useState<PresentationSettings | null>(null);
  const [ltOnAir, setLtOnAir] = useState(false);
  const [clock, setClock] = useState(formatClock(new Date()));
  const [, forceTick] = useState(0);

  useEffect(() => {
    invoke<DisplayItem>("get_current_item").then(setLiveItem).catch((e: any) => signalOperatorWarning(`Stage hydrate (live): ${e?.message ?? e}`));
    invoke<DisplayItem>("get_staged_item").then(setStagedItem).catch(() => {});
    invoke<string>("get_app_data_dir").then(setAppDataDir).catch(() => {});
    invoke<PresentationSettings>("get_settings").then((s) => { if (s) setSettings(s); }).catch(() => {});
    invoke<any>("get_current_lower_third").then((lt) => setLtOnAir(!!lt)).catch(() => {});

    const tick = () => {
      setClock(formatClock(new Date()));
      forceTick((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [setAppDataDir]);

  useEffect(() => {
    const unlisten1 = listen<{ detected_item: DisplayItem | null }>(
      "live-item-update",
      (ev) => setLiveItem(ev.payload.detected_item ?? null)
    );
    const unlisten2 = listen<DisplayItem | null>("item-staged", (ev) => {
      setStagedItem(ev.payload ?? null);
    });
    const unlisten3 = listen<PresentationSettings>("settings-changed", (ev) => {
      setSettings(ev.payload);
    });
    const unlisten4 = listen<any>("lower-third-update", (ev) => {
      setLtOnAir(!!ev.payload);
    });
    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
      unlisten4.then((f) => f());
    };
  }, []);

  const useTheme = settings?.stage_uses_theme ?? false;
  const theme = settings ? (THEMES[settings.theme] ?? THEMES.dark) : THEMES.dark;
  const colors = theme.colors;
  const bg = useTheme ? colors.background : "#020617";
  const textCol = useTheme ? colors.verseText : "#ffffff";
  const accent = useTheme ? colors.referenceText : "#f59e0b";

  function itemSummary(item: DisplayItem | null): string {
    if (!item) return "—";
    return displayItemLabel(item);
  }

  function itemDetail(item: DisplayItem | null): string {
    if (!item) return "";
    if (item.type === "Timer") return computeTimerDisplay(item.data, Date.now());
    if (item.type === "Camera") return t("stage.cameraFeed");
    return stageDetailFor(item);
  }

  const liveTimerDisplay = useMemo(() => {
    if (liveItem?.type === "Timer") return computeTimerDisplay(liveItem.data, Date.now());
    return null;
  }, [liveItem, clock]);

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden select-none font-sans"
      style={{ backgroundColor: bg, color: textCol }}
    >
      <div
        className="flex items-center justify-between px-8 py-3 shrink-0 border-b"
        style={{ backgroundColor: useTheme ? "rgba(0,0,0,0.25)" : "#0f172a", borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: useTheme ? "rgba(255,255,255,0.5)" : "#64748b" }}>{t("stage.label")}</span>
          {ltOnAir && (
            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest" style={{ backgroundColor: accent + "33", color: accent }}>
              {t("stage.ltOnAir")}
            </span>
          )}
        </div>
        {liveTimerDisplay ? (
          <span className="font-mono text-5xl font-black tracking-widest tabular-nums" style={{ color: textCol }}>{liveTimerDisplay}</span>
        ) : (
          <span className="font-mono text-4xl font-black tracking-widest tabular-nums" style={{ color: textCol }}>{clock}</span>
        )}
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: useTheme ? "rgba(255,255,255,0.5)" : "#64748b" }}>{t("app.name")}</span>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
        <div className="flex flex-col p-8 border-r overflow-hidden" style={{ borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}>
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: "#ef4444" }} />
            <span className="text-xs font-black uppercase tracking-widest" style={{ color: "#ef4444" }}>{t("stage.nowLive")}</span>
          </div>
          <p className="text-xl font-bold mb-3 shrink-0 truncate" style={{ color: useTheme ? "rgba(255,255,255,0.8)" : "#cbd5e1" }}>{itemSummary(liveItem)}</p>
          <div className="text-4xl font-serif leading-snug flex-1 overflow-hidden" style={{ color: textCol }}>
            {liveItem?.type === "CustomSlide" ? (
              <div className="w-full h-full relative border rounded-lg overflow-hidden" style={{ borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}>
                <CustomSlideRenderer slide={liveItem.data} scale={0.2} appDataDir={appDataDir} />
              </div>
            ) : liveItem?.type === "Timer" ? (
              <div className="flex items-center justify-center h-full">
                <span className="font-mono text-8xl font-black tabular-nums" style={{ color: textCol }}>{liveTimerDisplay}</span>
              </div>
            ) : (
              <p className="line-clamp-[8] whitespace-pre-wrap">{itemDetail(liveItem)}</p>
            )}
          </div>
        </div>

        <div className="flex flex-col p-8 border-2 overflow-hidden" style={{ borderColor: accent + "66", backgroundColor: useTheme ? accent + "0d" : "rgba(120,53,15,0.1)" }}>
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <span className="text-xs font-black uppercase tracking-widest" style={{ color: accent }}>{t("stage.upNext")}</span>
          </div>
          <p className="text-xl font-bold mb-3 shrink-0 truncate" style={{ color: accent }}>{itemSummary(stagedItem)}</p>
          <div className="text-4xl font-serif leading-snug flex-1 overflow-hidden" style={{ color: useTheme ? "rgba(255,255,255,0.9)" : "#fef3c7" }}>
            {stagedItem?.type === "CustomSlide" ? (
              <div className="w-full h-full relative border rounded-lg overflow-hidden" style={{ borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}>
                <CustomSlideRenderer slide={stagedItem.data} scale={0.2} appDataDir={appDataDir} />
              </div>
            ) : stagedItem?.type === "Timer" ? (
              <div className="flex items-center justify-center h-full">
                <span className="font-mono text-7xl font-black tabular-nums" style={{ color: accent }}>{computeTimerDisplay(stagedItem.data, Date.now())}</span>
              </div>
            ) : (
              <p className="line-clamp-[8] whitespace-pre-wrap">{itemDetail(stagedItem)}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
