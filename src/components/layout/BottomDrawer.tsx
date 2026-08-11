import React from "react";
import { X } from "lucide-react";
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
  { id: "live-lt", label: "Lower Third" },
  { id: "timer", label: "Timers" },
  { id: "props", label: "Props" },
  { id: "camera", label: "Camera" },
  { id: "scenes", label: "Scenes" },
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

  if (!bottomDeckOpen) return null;

  const liveTone: StatusTone = liveItem ? "live" : "neutral";
  const liveLabel = liveItem ? displayItemLabel(liveItem) : "Nothing live";

  return (
    <section className="bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-40 relative" style={{ height: bottomDeckH }}>
      <div className="h-1 bg-slate-800 hover:bg-amber-500/40 cursor-row-resize transition-colors absolute top-0 left-0 right-0 z-10"
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
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-console-border bg-console-canvas/40 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-console-text-muted hidden sm:block">Live Tools</span>
          <div className="flex gap-0.5 rounded-md overflow-hidden border border-console-border bg-console-canvas/60 p-0.5">
            {TOOL_TABS.map(({ id, label: lbl }) => (
              <button key={id} onClick={() => setBottomDeckMode(id)}
                aria-pressed={bottomDeckMode === id}
                className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${bottomDeckMode === id ? "bg-action-primary text-black shadow" : "text-console-text-subtle hover:text-console-text-muted"}`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <IconButton label="Close Live Tools" onClick={() => setBottomDeckOpen(false)}>
          <X size={16} />
        </IconButton>
      </div>

      {/* Current-state status bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-console-border bg-console-canvas/20 overflow-x-auto custom-scrollbar shrink-0 flex-wrap">
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
