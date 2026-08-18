import { useEffect, useState, useMemo } from "react";
import { useSlideFit } from "../hooks/useSlideFit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DisplayItem, PresentationSettings, TimerData, LowerThirdData, LowerThirdTemplate, LowerThirdPayload, OutputConfig, PresentationSnapshot } from "../types";
import { OUTPUT_SCHEMA_VERSION, DEFAULT_SETTINGS } from "../types";
import { displayItemLabel } from "../utils";
import { stageDetail as stageDetailFor } from "../items/registry";
import { CustomSlideRenderer, LowerThirdOverlay } from "../components/shared/Renderers";
import { useAppStore } from "../store";
import { useT } from "../i18n";
import { signalOperatorWarning } from "../hooks/useAppInitialization";
import { useFonts } from "../hooks/useFonts";
import { PresentationSync } from "../system/presentationSync";
import { resolveProgramFrame } from "../compositor/ProgramFrameResolver";

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
  useFonts(); // P2.5: inject @font-face for user-installed fonts.
  const { appDataDir, setAppDataDir } = useAppStore();
  const t = useT();
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [settings, setSettings] = useState<PresentationSettings | null>(null);
  const [outputConfig, setOutputConfig] = useState<OutputConfig | null>(null);
  const [ltPayload, setLtPayload] = useState<{ data: LowerThirdData; template: LowerThirdTemplate } | null>(null);
  const [clock, setClock] = useState(formatClock(new Date()));
  const [, forceTick] = useState(0);

  // The custom-slide confidence previews below are rendered by
  // `CustomSlideRenderer`, whose authored pt sizes assume a 1080p reference.
  // Letterbox each box's 16:9 design inside its (non-16:9) half-column via
  // `useSlideFit` — the largest 16:9 sub-rectangle that fits in the measured
  // height drives the scale, so the stage preview matches the on-air
  // proportions without overflowing the narrower confidence panels.
  const [liveSlideBoxRef, liveSlideFit] = useSlideFit();
  const [stagedSlideBoxRef, stagedSlideFit] = useSlideFit();
  const [ltHostRef, ltFit] = useSlideFit();

  useEffect(() => {
    // Hydration gate (audit #7): presentation events arriving while this
    // window boots are buffered and replayed after `presentation_snapshot`,
    // so a racing backend change is never lost or overwritten by stale data.
    // Events are revision-tagged (Phase 2) so a stale broadcast is dropped
    // instead of overwriting newer state.
    const presentationSync = new PresentationSync();

    const unlisten1 = listen<{ detected_item: DisplayItem | null; revision: number }>(
      "live-item-update",
      (ev) => presentationSync.apply(ev.payload.revision, () => setLiveItem(ev.payload.detected_item ?? null))
    );
    const unlisten2 = listen<{ item: DisplayItem | null; revision: number }>("item-staged", (ev) => {
      presentationSync.apply(ev.payload.revision, () => setStagedItem(ev.payload.item ?? null));
    });
    const unlisten3 = listen<{ settings: PresentationSettings; revision: number }>("settings-changed", (ev) => {
      presentationSync.apply(ev.payload.revision, () => setSettings(ev.payload.settings));
    });
    const unlisten4 = listen<{ lower_third: LowerThirdPayload | null; revision: number }>("lower-third-update", (ev) => {
      presentationSync.apply(ev.payload.revision, () => setLtPayload(ev.payload.lower_third ?? null));
    });
    const unlisten5 = listen<OutputConfig[]>("output-config-changed", (ev) => {
      setOutputConfig(ev.payload.find((c) => c.window_label === "stage") ?? null);
    });

    // Hydrate from the authoritative snapshot (single consistent read) instead
    // of racing per-field invokes against the event stream. All listeners are
    // awaited BEFORE the snapshot so a late-registered listener can never drop
    // an event that fires between snapshot application and registration
    // (audit #2: hydration listener-registration race).
    (async () => {
      await Promise.all([unlisten1, unlisten2, unlisten3, unlisten4, unlisten5]).catch(() => {});
      invoke<PresentationSnapshot | null>("presentation_snapshot")
        .then((snap) => {
          if (snap) {
            presentationSync.applySnapshot(snap.revision, () => {
              setLiveItem(snap.live ?? null);
              setStagedItem(snap.staged ?? null);
              setSettings(snap.settings);
              setLtPayload((snap.lower_third as LowerThirdPayload | null) ?? null);
            });
          }
          presentationSync.open();
        })
        .catch((e: any) => {
          signalOperatorWarning(`Stage hydrate (snapshot): ${e?.message ?? e}`);
          presentationSync.open();
        });

      invoke<string>("get_app_data_dir").then(setAppDataDir).catch(() => {});
      invoke<OutputConfig[]>("outputs_list").then((configs) => {
        setOutputConfig(configs.find((c) => c.window_label === "stage") ?? null);
      }).catch(() => {});
    })();

    const tick = () => {
      setClock(formatClock(new Date()));
      forceTick((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, 250);

    return () => {
      clearInterval(id);
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      unlisten3.then((f) => f());
      unlisten4.then((f) => f());
      unlisten5.then((f) => f());
    };
  }, [setAppDataDir]);

  // Resolve the stage output's program frame through the SAME pure resolver the
  // projection window, canvas compositor, recorder, and streamer use. `colors`
  // come from the frame (theme resolved with the stage config's presentation
  // override) and the "Now Live" panel below shows the frame's resolved live
  // source — so the confidence monitor can never disagree with the program.
  const frame = useMemo(() => {
    const config: OutputConfig = outputConfig ?? {
      schema_version: OUTPUT_SCHEMA_VERSION,
      id: "stage",
      kind: "window",
      label: "Stage",
      enabled: true,
      visible: true,
      source: { type: "live" },
      geometry: { width: window.innerWidth, height: window.innerHeight },
      overlays: { props: true, lower_third: true, logo: true },
    };
    return resolveProgramFrame({
      config,
      snapshot: {
        live: liveItem,
        staged: stagedItem,
        settings: settings ?? DEFAULT_SETTINGS,
        props: [],
        lower_third: ltPayload,
        revision: 0,
      },
    });
  }, [outputConfig, liveItem, stagedItem, settings, ltPayload]);

  const effSettings = frame.settings;
  const liveSource = frame.source.kind === "blank" ? null : frame.source.item;

  const useTheme = effSettings?.stage_uses_theme ?? false;
  const colors = frame.colors;
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
    if (liveSource?.type === "Timer") return computeTimerDisplay(liveSource.data, Date.now());
    return null;
  }, [liveSource, clock]);

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
          {ltPayload && (
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
          <p className="text-xl font-bold mb-3 shrink-0 truncate" style={{ color: useTheme ? "rgba(255,255,255,0.8)" : "#cbd5e1" }}>{itemSummary(liveSource)}</p>
          <div ref={ltHostRef} className="text-4xl font-serif leading-snug flex-1 overflow-hidden relative">
            {liveSource?.type === "CustomSlide" ? (
              <div ref={liveSlideBoxRef} className="w-full h-full relative border rounded-lg overflow-hidden flex items-center justify-center" style={{ borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}>
                {liveSlideFit.width > 0 && liveSlideFit.height > 0 && (
                  <div style={{ width: liveSlideFit.width, height: liveSlideFit.height }}>
                    <CustomSlideRenderer slide={liveSource.data} scale={liveSlideFit.scale} appDataDir={appDataDir} theme={liveSource.data.theme} />
                  </div>
                )}
              </div>
            ) : liveSource?.type === "Timer" ? (
              <div className="flex items-center justify-center h-full">
                <span className="font-mono text-8xl font-black tabular-nums" style={{ color: textCol }}>{liveTimerDisplay}</span>
              </div>
            ) : (
              <p className="line-clamp-[8] whitespace-pre-wrap">{itemDetail(liveSource)}</p>
            )}
            {ltPayload && ltFit.width > 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative" style={{ width: ltFit.width, height: ltFit.height }}>
                  <LowerThirdOverlay data={ltPayload.data} template={ltPayload.template} scale={ltFit.scale} />
                </div>
              </div>
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
              <div ref={stagedSlideBoxRef} className="w-full h-full relative border rounded-lg overflow-hidden flex items-center justify-center" style={{ borderColor: useTheme ? "rgba(255,255,255,0.08)" : "#1e293b" }}>
                {stagedSlideFit.width > 0 && stagedSlideFit.height > 0 && (
                  <div style={{ width: stagedSlideFit.width, height: stagedSlideFit.height }}>
                    <CustomSlideRenderer slide={stagedItem.data} scale={stagedSlideFit.scale} appDataDir={appDataDir} theme={stagedItem.data.theme} />
                  </div>
                )}
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
