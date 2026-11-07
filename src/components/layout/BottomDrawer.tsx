import React from "react";
import { Captions, Clock3, LayoutGrid, Shapes, Video, X } from "lucide-react";
import { useAppStore } from "../../store";
import { LowerThirdTab } from "../LowerThirdTab";
import { TimersTab } from "../TimersTab";
import { PropsTab } from "../PropsTab";
import { CameraTab } from "../CameraTab";
import { ScenesTab } from "../ScenesTab";
import { IconButton, StatusBadge, type StatusTone } from "../ui";
import { displayItemLabel } from "../../utils";
import type { DisplayItem, PresentationSettings, PropItem, Scene } from "../../types";

interface BottomDrawerProps {
  bottomDeckH: number;
  setBottomDeckH: (v: number) => void;
  stageItem: (item: DisplayItem) => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  handleFileUpload: () => Promise<void>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  updateProps: (items: PropItem[]) => Promise<void>;
  saveScene: (scene: Scene) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  applyScene: (id: string) => Promise<void>;
  captureScene: (name: string) => Promise<void>;
}

const TOOL_TABS = [
  { id: "live-lt", label: "Lower Third", icon: Captions },
  { id: "timer", label: "Timers", icon: Clock3 },
  { id: "props", label: "Props", icon: Shapes },
  { id: "camera", label: "Camera", icon: Video },
  { id: "scenes", label: "Scenes", icon: LayoutGrid },
] as const;

export function BottomDrawer({
  bottomDeckH,
  setBottomDeckH,
  stageItem,
  sendLive,
  handleFileUpload,
  updateSettings,
  updateProps,
  saveScene,
  deleteScene,
  applyScene,
  captureScene,
}: BottomDrawerProps) {
  const {
    bottomDeckOpen, setBottomDeckOpen,
    bottomDeckMode, setBottomDeckMode,
    ltVisible,
    liveItem,
    timerRunning,
    propItems,
    selectedCameraId,
    availableCameras,
    scenes,
  } = useAppStore();

  const liveTone: StatusTone = liveItem ? "live" : "neutral";
  const liveLabel = liveItem ? displayItemLabel(liveItem) : "Nothing live";
  const toolActive = (id: (typeof TOOL_TABS)[number]["id"]) => {
    if (id === "live-lt") return ltVisible;
    if (id === "timer") return timerRunning;
    if (id === "props") return propItems.length > 0;
    if (id === "camera") return liveItem?.type === "Camera";
    return false;
  };

  if (!bottomDeckOpen) {
    return (
      <section className="flex h-12 shrink-0 items-center gap-2 border-t border-console-border bg-console-surface px-3 shadow-[0_-10px_30px_rgba(0,0,0,.12)]" aria-label="Live tools dock">
        <span className="mr-1 hidden text-[8px] font-black uppercase tracking-[0.18em] text-console-text-subtle lg:block">Live Tools</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto custom-scrollbar">
          {TOOL_TABS.map(({ id, label, icon: Icon }) => {
            const active = toolActive(id);
            return (
              <button
                key={id}
                onClick={() => { setBottomDeckMode(id); setBottomDeckOpen(true); }}
                className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[9px] font-bold text-console-text-muted transition-all hover:border-console-border hover:bg-console-surface-strong hover:text-console-text"
              >
                <Icon size={13} /> {label}
                {active && <span className="h-1.5 w-1.5 rounded-full bg-state-live shadow-[0_0_7px_rgba(255,82,82,.65)]" aria-label="Active" />}
              </button>
            );
          })}
        </div>
        <StatusBadge tone={liveTone} label={liveItem ? `On air: ${liveLabel}` : "Program clear"} pulsing={!!liveItem} className="hidden max-w-[220px] md:inline-flex" />
      </section>
    );
  }

  return (
    <section className="relative z-40 flex shrink-0 flex-col border-t border-console-border bg-console-surface shadow-[0_-18px_50px_rgba(0,0,0,.25)]" style={{ height: bottomDeckH }}>
      <div className="absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize bg-console-border hover:bg-action-primary/60 transition-colors"
        onMouseDown={(e) => {
          const startY = e.clientY; const startH = bottomDeckH;
          const move = (em: MouseEvent) => {
            const next = Math.max(180, Math.min(window.innerHeight * 0.55, startH - (em.clientY - startY)));
            setBottomDeckH(next); localStorage.setItem("pref_bottomDeckH", String(Math.round(next)));
          };
          const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        }}
      />
      <div className="flex shrink-0 items-center justify-between border-b border-console-border bg-console-canvas/45 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden text-[9px] font-black uppercase tracking-[0.16em] text-console-text-muted sm:block">Live Tools</span>
          <div className="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-console-border bg-console-canvas/60 p-1 custom-scrollbar">
            {TOOL_TABS.map(({ id, label: lbl, icon: Icon }) => (
              <button key={id} onClick={() => setBottomDeckMode(id)}
                aria-pressed={bottomDeckMode === id}
                className={`relative flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[9px] font-black transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${bottomDeckMode === id ? "bg-action-primary text-black shadow" : "text-console-text-subtle hover:bg-console-surface-strong hover:text-console-text"}`}>
                <Icon size={12} /> {lbl}
                {toolActive(id) && <span className={`h-1.5 w-1.5 rounded-full ${bottomDeckMode === id ? "bg-black" : "bg-state-live"}`} />}
              </button>
            ))}
          </div>
        </div>
        <IconButton label="Close Live Tools" onClick={() => setBottomDeckOpen(false)}>
          <X size={16} />
        </IconButton>
      </div>

      {/* Current-state status bar */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-console-border bg-console-canvas/20 px-3 py-1.5 custom-scrollbar">
        <StatusBadge tone={liveTone} label={liveLabel} pulsing={!!liveItem} />
        <StatusBadge tone={ltVisible ? "live" : "neutral"} label={ltVisible ? "Lower Third on" : "Lower Third off"} pulsing={ltVisible} />
        <StatusBadge tone={timerRunning ? "live" : "neutral"} label={timerRunning ? "Timer running" : "Timer stopped"} pulsing={timerRunning} />
        <StatusBadge tone={propItems.length > 0 ? "stage" : "neutral"} label={`${propItems.length} prop${propItems.length === 1 ? "" : "s"}`} />
        <StatusBadge tone={selectedCameraId ? "stage" : "neutral"} label={selectedCameraId ? `Camera: ${availableCameras.find((c) => c.deviceId === selectedCameraId)?.label ?? "selected"}` : "No camera"} />
        <StatusBadge tone={scenes.length > 0 ? "success" : "neutral"} label={`${scenes.length} scene${scenes.length === 1 ? "" : "s"}`} />
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {bottomDeckMode === "live-lt" && <LowerThirdTab onSetToast={useAppStore.getState().setToast} onLoadMedia={handleFileUpload} />}
        {bottomDeckMode === "timer" && <TimersTab onStage={stageItem} onLive={sendLive} />}
        {bottomDeckMode === "props" && <PropsTab onUpdateProps={updateProps} />}
        {bottomDeckMode === "camera" && <CameraTab onStage={stageItem} onLive={sendLive} />}
        {bottomDeckMode === "scenes" && (
          <ScenesTab
            saveScene={saveScene}
            deleteScene={deleteScene}
            applyScene={applyScene}
            captureScene={captureScene}
          />
        )}
      </div>
    </section>
  );
}
