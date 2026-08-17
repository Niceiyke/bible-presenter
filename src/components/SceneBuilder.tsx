import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  Columns2, LayoutGrid, Maximize2, PictureInPicture2, Plus, Trash2, X,
  Video, Image as ImageIcon, BookOpen, Presentation, Music2, Clock,
  Camera as CameraIcon, ChevronUp, ChevronDown, ArrowUp, ArrowDown,
  Radio, Link2, Move, SlidersHorizontal, Layers, Save, Monitor, Check,
  ChevronRight, Type as TypeIcon,
} from "lucide-react";
import { useAppStore } from "../store";
import {
  Scene, SceneLayout, SceneZone, SceneZoneSource, DisplayItem,
  MediaItem, CameraBackground, THEMES,
} from "../types";
import { stableId, resolvePath, buildCustomSlideItem, FONTS } from "../utils";
import { buildSongDisplayItem } from "../utils/song";
import { ZoneContent } from "./shared/CompositionRenderer";

export interface SceneBuilderProps {
  scene: Scene;
  onSceneChange: (scene: Scene) => void;
  onSave: (scene: Scene) => Promise<void>;
  onApply?: (id: string) => Promise<void>;
  onClose: () => void;
}

// ─── Layout presets ─────────────────────────────────────────────────────────

export type LayoutPreset =
  | { id: "full"; name: "Full"; zones: (idx: number) => SceneZone[] }
  | { id: "split-50"; name: "50/50"; zones: (idx: number) => SceneZone[] }
  | { id: "split-23"; name: "⅔ + ⅓"; zones: (idx: number) => SceneZone[] }
  | { id: "pip"; name: "PiP"; zones: (idx: number) => SceneZone[] }
  | { id: "quad"; name: "Quad"; zones: (idx: number) => SceneZone[] };

const EMPTY_ITEM: DisplayItem = {
  type: "Camera",
  data: { deviceId: "", opacity: 1, objectFit: "cover", mirrored: false },
};

function blankZone(idx: number, x: number, y: number, w: number, h: number): SceneZone {
  return { id: `zone-${idx}`, item: { ...EMPTY_ITEM }, x, y, w, h, fit: "cover", opacity: 1, z: idx + 1 };
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "full", name: "Full", zones: () => [blankZone(0, 0, 0, 1, 1)] },
  {
    id: "split-50",
    name: "50/50",
    zones: () => [blankZone(0, 0, 0, 0.5, 1), blankZone(1, 0.5, 0, 0.5, 1)],
  },
  {
    id: "split-23",
    name: "⅔ + ⅓",
    zones: () => [blankZone(0, 0, 0, 2 / 3, 1), blankZone(1, 2 / 3, 0, 1 / 3, 1)],
  },
  {
    id: "pip",
    name: "PiP",
    zones: () => [blankZone(0, 0, 0, 1, 1), blankZone(1, 0.68, 0.62, 0.3, 0.32)],
  },
  {
    id: "quad",
    name: "Quad",
    zones: () => [
      blankZone(0, 0, 0, 0.5, 0.5),
      blankZone(1, 0.5, 0, 0.5, 0.5),
      blankZone(2, 0, 0.5, 0.5, 0.5),
      blankZone(3, 0.5, 0.5, 0.5, 0.5),
    ],
  },
];

const PRESET_ICONS: Record<string, React.ReactNode> = {
  full: <Maximize2 size={11} />,
  "split-50": <Columns2 size={11} />,
  "split-23": <LayoutGrid size={11} />,
  pip: <PictureInPicture2 size={11} />,
  quad: <LayoutGrid size={11} />,
};

// ─── Content source pickers ─────────────────────────────────────────────────

function MediaSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const media = useAppStore((s) => s.media);
  const appDataDir = useAppStore((s) => s.appDataDir);
  return (
    <div className="grid grid-cols-3 gap-1.5 max-h-64 overflow-y-auto">
      {media.length === 0 && <p className="col-span-3 text-xs text-console-text-subtle">No media in the library yet.</p>}
      {media.map((m) => (
        <button
          key={m.id}
          onClick={() => onPick({ type: "Media", data: m })}
          className="group relative aspect-video rounded-md overflow-hidden border border-console-border hover:border-action-primary transition-all"
          title={m.name}
        >
          {m.media_type === "Image" ? (
            <img
              src={convertFileSrc(resolvePath(m.path, appDataDir))}
              className="w-full h-full object-cover"
              alt={m.name}
            />
          ) : m.media_type === "Video" ? (
            <div className="w-full h-full flex items-center justify-center bg-slate-900">
              <Video size={18} className="text-slate-400" />
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-slate-900">
              <Music2 size={18} className="text-slate-400" />
            </div>
          )}
          <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-black/70 text-[8px] text-white truncate opacity-0 group-hover:opacity-100">
            {m.name}
          </span>
        </button>
      ))}
    </div>
  );
}

function CameraSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const availableCameras = useAppStore((s) => s.availableCameras);
  const phoneCameras = useAppStore((s) => s.phoneCameras);
  const pick = (deviceId: string) => {
    const cam: CameraBackground = {
      deviceId,
      opacity: 1,
      objectFit: "cover",
      mirrored: false,
    };
    onPick({ type: "Camera", data: cam });
  };
  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
      <p className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Phone cameras</p>
      {phoneCameras.length === 0 && (
        <p className="text-xs text-console-text-subtle">No connected phones streaming a camera.</p>
      )}
      {phoneCameras.map((c) => (
        <button
          key={c.deviceId}
          onClick={() => pick(c.deviceId)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-console-surface-raised border border-console-border hover:border-action-primary text-left transition-all"
        >
          <CameraIcon size={13} className="text-red-400" />
          <span className="text-xs text-console-text truncate">{c.label || "Phone Camera"}</span>
        </button>
      ))}
      <p className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle mt-2">Local cameras</p>
      {availableCameras.length === 0 && (
        <p className="text-xs text-console-text-subtle">No local cameras detected.</p>
      )}
      {availableCameras.map((c) => (
        <button
          key={c.deviceId}
          onClick={() => pick(c.deviceId)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-console-surface-raised border border-console-border hover:border-action-primary text-left transition-all"
        >
          <CameraIcon size={13} className="text-slate-400" />
          <span className="text-xs text-console-text truncate">{c.label || "Local Camera"}</span>
        </button>
      ))}
    </div>
  );
}

function VerseSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const books = useAppStore((s) => s.books);
  const bibleVersion = useAppStore((s) => s.bibleVersion);
  const [ref, setRef] = useState("John 3 16");
  const [busy, setBusy] = useState(false);
  const fetchVerse = async () => {
    setBusy(true);
    try {
      const m = ref.trim().match(/^([A-Za-z0-9 ]+?)\s+(\d+)\s+(\d+)$/);
      if (!m) return;
      const v: any = await invoke("get_verse", { book: m[1], chapter: parseInt(m[2]), verse: parseInt(m[3]), version: bibleVersion });
      if (v) onPick({ type: "Verse", data: v });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchVerse()}
          placeholder="Book Chapter Verse — e.g. John 3 16"
          className="flex-1 bg-console-surface-raised border border-console-border rounded-md px-2 py-1.5 text-xs text-console-text focus:outline-none focus:border-action-primary"
        />
        <button
          onClick={fetchVerse}
          disabled={busy}
          className="px-2.5 py-1.5 rounded-md bg-action-primary hover:bg-action-primary/90 text-black text-xs font-bold"
        >
          {busy ? "…" : "Fetch"}
        </button>
      </div>
      {books.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {books.slice(0, 8).map((b) => (
            <button
              key={b}
              onClick={() => setRef(`${b} 1 1`)}
              className="px-1.5 py-0.5 rounded bg-console-surface-raised border border-console-border text-[9px] text-console-text-muted hover:text-console-text"
            >
              {b}
            </button>
          ))}
        </div>
      )}
      <p className="text-[9px] text-console-text-subtle">Format: <span className="font-mono">Book Chapter Verse</span> using the current version ({bibleVersion}).</p>
    </div>
  );
}

function SlideSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const studioList = useAppStore((s) => s.studioList);
  const studioSlides = useAppStore((s) => s.studioSlides);
  const [openPres, setOpenPres] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
      {studioList.length === 0 && <p className="text-xs text-console-text-subtle">No custom presentations yet.</p>}
      {studioList.map((p) => {
        const slides = studioSlides[p.id] ?? [];
        return (
          <div key={p.id} className="rounded-md border border-console-border overflow-hidden">
            <button
              onClick={() => setOpenPres(openPres === p.id ? null : p.id)}
              className="w-full flex items-center justify-between px-2 py-1.5 bg-console-surface-raised hover:bg-console-surface-strong text-left"
            >
              <span className="text-xs text-console-text truncate">{p.name}</span>
              <span className="text-[9px] text-console-text-subtle">{slides.length} slides</span>
            </button>
            {openPres === p.id && (
              <div className="grid grid-cols-4 gap-1 p-1.5 bg-console-surface">
                {slides.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => onPick(buildCustomSlideItem(p, slides, i))}
                    className="aspect-video rounded border border-console-border hover:border-action-primary bg-slate-900 overflow-hidden"
                    title={`Slide ${i + 1}`}
                  >
                    <div className="w-full h-full p-1 text-[7px] leading-tight text-slate-300 break-words overflow-hidden">
                      {(s.elements ?? []).filter((e) => e.kind === "text").map((e) => (e as any).content).filter((c) => typeof c === "string").slice(0, 3).join(" · ") || `S${i + 1}`}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SongSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const songs = useAppStore((s) => s.songs);
  const hymns = useAppStore((s) => s.hymnLibrary);
  const list = [...songs, ...hymns];
  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
      {list.length === 0 && <p className="text-xs text-console-text-subtle">No songs or hymns yet.</p>}
      {list.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(buildSongDisplayItem(s, 0))}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-console-surface-raised border border-console-border hover:border-action-primary text-left transition-all"
        >
          <Music2 size={13} className="text-pink-400" />
          <span className="text-xs text-console-text truncate">{s.title}</span>
          <span className="text-[9px] text-console-text-subtle ml-auto">{s.style === "LowerThird" ? "OVR" : "Full"}</span>
        </button>
      ))}
    </div>
  );
}

function TimerSource({ onPick }: { onPick: (item: DisplayItem) => void }) {
  const pickTimer = (timer_type: "countdown" | "countup" | "clock") =>
    onPick({ type: "Timer", data: { timer_type } });
  return (
    <div className="flex flex-col gap-1">
      {([
        { t: "clock", label: "Clock", icon: <Clock size={13} /> },
        { t: "countup", label: "Count up", icon: <Clock size={13} /> },
        { t: "countdown", label: "Countdown", icon: <Clock size={13} /> },
      ] as const).map(({ t, label }) => (
        <button
          key={t}
          onClick={() => pickTimer(t)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-console-surface-raised border border-console-border hover:border-action-primary text-left transition-all"
        >
          <Clock size={13} className="text-cyan-400" />
          <span className="text-xs text-console-text">{label}</span>
        </button>
      ))}
    </div>
  );
}

type SourceTab = "camera" | "media" | "verse" | "slide" | "song" | "timer";

const SOURCE_TABS: { id: SourceTab; label: string; icon: React.ReactNode }[] = [
  { id: "camera", label: "Camera", icon: <CameraIcon size={11} /> },
  { id: "media", label: "Media", icon: <ImageIcon size={11} /> },
  { id: "verse", label: "Bible", icon: <BookOpen size={11} /> },
  { id: "slide", label: "Slides", icon: <Presentation size={11} /> },
  { id: "song", label: "Songs", icon: <Music2 size={11} /> },
  { id: "timer", label: "Timer", icon: <Clock size={11} /> },
];

// ─── Live bus source (Phase 5) ────────────────────────────────────────────────

const LIVE_SOURCE_OPTIONS: { type: SceneZoneSource["type"]; label: string; icon: React.ReactNode; hint: string }[] = [
  { type: "item", label: "Static", icon: <Link2 size={11} />, hint: "Frozen snapshot picked below" },
  { type: "verse", label: "Verse", icon: <BookOpen size={11} />, hint: "Follows the on-air verse" },
  { type: "camera", label: "Camera", icon: <CameraIcon size={11} />, hint: "Follows the on-air camera" },
  { type: "timer", label: "Timer", icon: <Clock size={11} />, hint: "Follows the live timer" },
  { type: "song", label: "Song", icon: <Music2 size={11} />, hint: "Follows the on-air song" },
  { type: "media", label: "Media", icon: <ImageIcon size={11} />, hint: "Follows the on-air media" },
  { type: "slide", label: "Slide", icon: <Presentation size={11} />, hint: "Follows the on-air slide" },
];

function liveSourceLabel(source: SceneZoneSource | undefined): string | null {
  if (!source || source.type === "item") return null;
  return LIVE_SOURCE_OPTIONS.find((o) => o.type === source.type)?.label ?? null;
}

function ContentPicker({
  onPick,
  onClose,
}: {
  onPick: (item: DisplayItem) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SourceTab>("camera");
  const pick = (item: DisplayItem) => { onPick(item); onClose(); };
  return (
    <div className="absolute right-0 top-0 bottom-0 w-72 bg-console-surface border-l border-console-border flex flex-col z-30">
      <div className="flex items-center justify-between px-3 py-2 border-b border-console-border">
        <span className="text-xs font-bold text-console-text uppercase tracking-widest">Zone content</span>
        <button onClick={onClose} className="text-console-text-muted hover:text-console-text text-sm leading-none">×</button>
      </div>
      <div className="flex gap-1 px-2 py-2 border-b border-console-border overflow-x-auto">
        {SOURCE_TABS.map((s) => (
          <button
            key={s.id}
            onClick={() => setTab(s.id)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap transition-all ${
              tab === s.id ? "bg-action-primary text-black" : "text-console-text-muted hover:text-console-text"
            }`}
          >
            {s.icon}{s.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden p-2">
        {tab === "camera" && <CameraSource onPick={pick} />}
        {tab === "media" && <MediaSource onPick={pick} />}
        {tab === "verse" && <VerseSource onPick={pick} />}
        {tab === "slide" && <SlideSource onPick={pick} />}
        {tab === "song" && <SongSource onPick={pick} />}
        {tab === "timer" && <TimerSource onPick={pick} />}
      </div>
    </div>
  );
}

// ─── Inspector helpers ────────────────────────────────────────────────────────

function Section({
  title, icon: Icon, defaultOpen = true, right, children,
}: {
  title: string; icon: React.ElementType; defaultOpen?: boolean;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-console-border last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full min-h-10 flex items-center justify-between px-3 py-2 hover:bg-console-surface-raised/50 transition-colors group"
      >
        <div className="flex items-center gap-2">
          <Icon size={12} className="text-console-text-subtle group-hover:text-console-text transition-colors" />
          <span className="text-[10px] font-black uppercase tracking-widest text-console-text-muted group-hover:text-console-text transition-colors">{title}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {right}
          {open
            ? <ChevronDown size={11} className="text-console-text-subtle" />
            : <ChevronRight size={11} className="text-console-text-subtle" />}
        </div>
      </button>
      {open && <div className="px-3 pb-3 space-y-2.5">{children}</div>}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">{label}</span>
      <input
        type="number" step={0.01} min={0} max={1} value={Number(value.toFixed(2))}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-console-surface-raised border border-console-border rounded-md px-2 py-1 text-xs text-console-text focus:outline-none focus:border-action-primary"
      />
    </label>
  );
}

// ─── Main builder ───────────────────────────────────────────────────────────

type DragMode = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: { mode: DragMode; pos: React.CSSProperties; cursor: string }[] = [
  { mode: "nw", pos: { top: -6, left: -6 }, cursor: "cursor-nwse-resize" },
  { mode: "n", pos: { top: -6, left: "50%", transform: "translateX(-50%)" }, cursor: "cursor-ns-resize" },
  { mode: "ne", pos: { top: -6, right: -6 }, cursor: "cursor-nesw-resize" },
  { mode: "e", pos: { top: "50%", right: -6, transform: "translateY(-50%)" }, cursor: "cursor-ew-resize" },
  { mode: "se", pos: { bottom: -6, right: -6 }, cursor: "cursor-nwse-resize" },
  { mode: "s", pos: { bottom: -6, left: "50%", transform: "translateX(-50%)" }, cursor: "cursor-ns-resize" },
  { mode: "sw", pos: { bottom: -6, left: -6 }, cursor: "cursor-nesw-resize" },
  { mode: "w", pos: { top: "50%", left: -6, transform: "translateY(-50%)" }, cursor: "cursor-ew-resize" },
];

export function SceneBuilder({ scene, onSceneChange, onSave, onApply, onClose }: SceneBuilderProps) {
  const settings = useAppStore((s) => s.settings);
  const appDataDir = useAppStore((s) => s.appDataDir);
  const phoneCameras = useAppStore((s) => s.phoneCameras);
  const [selectedId, setSelectedId] = useState<string | null>(scene.layout?.zones[0]?.id ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fit, setFit] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ zoneId: string; mode: DragMode; startX: number; startY: number; orig: SceneZone } | null>(null);

  const zones = scene.layout?.zones ?? [];
  const refHeight = settings.reference_output_height ?? 1080;
  const windowScale = fit.h > 0 ? fit.h / refHeight : 0.25;

  const handleSceneChange = (next: Scene) => {
    setDirty(true);
    onSceneChange(next);
  };

  const updateZone = (zoneId: string, patch: Partial<SceneZone>) => {
    const next = (scene.layout?.zones ?? []).map((z) => (z.id === zoneId ? { ...z, ...patch } : z));
    handleSceneChange({ ...scene, layout: { zones: next } });
  };

  const addZone = () => {
    const idx = zones.length;
    const z = blankZone(idx, 0.05, 0.05, 0.4, 0.4);
    handleSceneChange({ ...scene, layout: { zones: [...zones, z] } });
    setSelectedId(z.id);
  };

  const removeZone = (zoneId: string) => {
    const next = zones.filter((z) => z.id !== zoneId).map((z, i) => ({ ...z, z: i + 1 }));
    handleSceneChange({ ...scene, layout: { zones: next } });
    if (selectedId === zoneId) setSelectedId(next[0]?.id ?? null);
  };

  const applyPreset = (preset: LayoutPreset) => {
    const next = preset.zones(0);
    handleSceneChange({ ...scene, layout: { zones: next } });
    setSelectedId(next[0]?.id ?? null);
  };

  const reorderZone = (zoneId: string, dir: -1 | 1) => {
    const sorted = [...zones].sort((a, b) => a.z - b.z);
    const idx = sorted.findIndex((z) => z.id === zoneId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= sorted.length) return;
    [sorted[idx], sorted[j]] = [sorted[j], sorted[idx]];
    const next = sorted.map((z, i) => ({ ...z, z: i + 1 }));
    handleSceneChange({ ...scene, layout: { zones: next } });
  };

  const clamp = (v: number) => Math.max(0.01, Math.min(1, v));

  // Fit a 16:9 canvas into the available area (letterboxed) and derive the
  // preview scale from its actual pixel height so zone content matches output.
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const compute = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      const availW = r.width - 48;
      const availH = r.height - 48;
      let w = availW;
      let h = w / (16 / 9);
      if (h > availH) {
        h = availH;
        w = h * (16 / 9);
      }
      setFit({ w: Math.max(160, Math.floor(w)), h: Math.max(90, Math.floor(h)) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startDrag = (e: React.PointerEvent, zoneId: string, mode: DragMode) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { zoneId, mode, startX: e.clientX, startY: e.clientY, orig: { ...zone } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (e.clientX - d.startX) / rect.width;
    const dy = (e.clientY - d.startY) / rect.height;
    const o = d.orig;
    const mode = d.mode;
    if (mode === "move") {
      updateZone(d.zoneId, { x: clamp(o.x + dx), y: clamp(o.y + dy) });
    } else if (mode === "nw") {
      const nx = clamp(o.x + dx); const ny = clamp(o.y + dy);
      updateZone(d.zoneId, { x: nx, y: ny, w: clamp(o.w + o.x - nx), h: clamp(o.h + o.y - ny) });
    } else if (mode === "n") {
      const ny = clamp(o.y + dy);
      updateZone(d.zoneId, { y: ny, h: clamp(o.h + o.y - ny) });
    } else if (mode === "ne") {
      const ny = clamp(o.y + dy);
      updateZone(d.zoneId, { y: ny, w: clamp(o.w + dx), h: clamp(o.h + o.y - ny) });
    } else if (mode === "e") {
      updateZone(d.zoneId, { w: clamp(o.w + dx) });
    } else if (mode === "se") {
      updateZone(d.zoneId, { w: clamp(o.w + dx), h: clamp(o.h + dy) });
    } else if (mode === "s") {
      updateZone(d.zoneId, { h: clamp(o.h + dy) });
    } else if (mode === "sw") {
      const nx = clamp(o.x + dx);
      updateZone(d.zoneId, { x: nx, w: clamp(o.w + o.x - nx), h: clamp(o.h + dy) });
    } else if (mode === "w") {
      const nx = clamp(o.x + dx);
      updateZone(d.zoneId, { x: nx, w: clamp(o.w + o.x - nx) });
    }
  };

  const endDrag = () => { dragRef.current = null; };

  const selected = zones.find((z) => z.id === selectedId) ?? null;
  const themeColors = (THEMES[settings.theme] ?? THEMES.dark).colors;

  const sourceLabel = (item: DisplayItem): string => {
    switch (item.type) {
      case "Camera": return item.data.deviceId ? (item.data.deviceId.startsWith("phone-camera-") ? "Phone Camera" : "Camera") : "Empty";
      case "Media": return item.data.name;
      case "Verse": return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
      case "CustomSlide": return `${item.data.presentation_name} · S${item.data.slide_index + 1}`;
      case "Timer": return `Timer: ${item.data.timer_type}`;
      case "Song": return item.data.title;
      default: return "Content";
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(scene);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  // Phone camera streams (already-prefixed device ids) from the shared store,
  // kept fresh as peers connect/disconnect.
  const phoneStreams = useMemo(() => {
    const map: Record<string, MediaStream> = {};
    phoneCameras.forEach((c) => {
      if (c.stream) map[c.deviceId] = c.stream;
    });
    return map;
  }, [phoneCameras]);

  const liveHint = selected?.source
    ? `When you send ${liveSourceLabel(selected.source)?.toLowerCase()} live, this zone updates in place on the output.`
    : "Static zone — content stays as picked below until you edit it.";

  return (
    <div className="h-full min-h-0 flex flex-col bg-console-canvas">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="min-h-14 shrink-0 border-b border-console-border bg-console-surface/80 px-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <input
            value={scene.name}
            onChange={(e) => handleSceneChange({ ...scene, name: e.target.value })}
            placeholder="Scene name"
            className="w-56 bg-console-surface-raised border border-console-border rounded-lg px-3 py-1.5 text-sm text-console-text focus:outline-none focus:border-action-primary"
          />
          {dirty && (
            <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/40">
              Unsaved
            </span>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1 bg-console-surface rounded-lg border border-console-border p-1">
          <span className="text-[9px] font-black uppercase tracking-widest text-console-text-subtle px-1">Layout</span>
          {LAYOUT_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p)}
              title={p.name}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-bold text-console-text-muted hover:text-console-text hover:bg-console-surface-strong transition-all"
            >
              {PRESET_ICONS[p.id]}{p.name}
            </button>
          ))}
          <div className="w-px h-5 bg-console-border mx-1" />
          <button
            onClick={addZone}
            title="Add a new zone"
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[10px] font-bold text-console-text-muted hover:text-console-text hover:bg-console-surface-strong transition-all"
          >
            <Plus size={11} /> Add zone
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-state-success hover:bg-state-success/85 disabled:opacity-60 text-black text-xs font-black uppercase transition-all"
          >
            <Save size={12} /> {saving ? "…" : "Save"}
          </button>
          {onApply && scene.id && (
            <button
              onClick={() => onApply(scene.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-action-primary hover:bg-action-primary-hover text-black text-xs font-black uppercase transition-all"
            >
              <Check size={12} /> Apply
            </button>
          )}
          <button
            onClick={onClose}
            title="Close builder"
            className="p-2 rounded-lg text-console-text-muted hover:text-console-text hover:bg-console-surface-raised transition-all"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* Inspector */}
        <div className="w-72 shrink-0 border-r border-console-border bg-console-surface flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-console-border flex items-center justify-between shrink-0 bg-console-surface-raised/40">
            <span className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Zone Inspector</span>
            {selected && <span className="text-[9px] font-mono text-console-text-subtle">z{selected.z}</span>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {selected ? (
              <>
                <Section title="Content" icon={Layers}>
                  <button
                    onClick={() => setPickerOpen(true)}
                    className="w-full px-2.5 py-2 rounded-lg bg-console-surface-raised border border-console-border hover:border-action-primary/60 text-left flex items-center justify-between gap-2 transition-all"
                  >
                    <span className="text-[11px] text-console-text truncate">{sourceLabel(selected.item)}</span>
                    <ChevronRight size={12} className="text-console-text-subtle shrink-0" />
                  </button>
                  <div className="pt-1">
                    <p className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle flex items-center gap-1 mb-1.5">
                      <Radio size={9} /> Follows live content
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {LIVE_SOURCE_OPTIONS.map((o) => (
                        <button
                          key={o.type}
                          title={o.hint}
                          onClick={() => updateZone(selected.id, { source: o.type === "item" ? undefined : { type: o.type } })}
                          className={`flex items-center gap-1 px-1.5 py-1 rounded text-[9px] font-bold uppercase transition-all ${
                            (selected.source?.type ?? "item") === o.type
                              ? "bg-state-live text-white"
                              : "bg-console-surface-raised text-console-text-muted hover:text-console-text"
                          }`}
                        >
                          {o.icon}{o.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[9px] text-console-text-subtle mt-1.5">{liveHint}</p>
                  </div>
                </Section>

                <Section title="Position & Size" icon={Move}>
                  <div className="grid grid-cols-2 gap-2">
                    <NumField label="X" value={selected.x} onChange={(v) => updateZone(selected.id, { x: clamp(v) })} />
                    <NumField label="Y" value={selected.y} onChange={(v) => updateZone(selected.id, { y: clamp(v) })} />
                    <NumField label="W" value={selected.w} onChange={(v) => updateZone(selected.id, { w: clamp(v || 0.1) })} />
                    <NumField label="H" value={selected.h} onChange={(v) => updateZone(selected.id, { h: clamp(v || 0.1) })} />
                  </div>
                  <p className="text-[9px] text-console-text-subtle">
                    Or drag the zone and its edge handles on the canvas — content scales to fit as you resize.
                  </p>
                </Section>

                <Section title="Appearance" icon={SlidersHorizontal}>
                  <div className="space-y-2">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Opacity</span>
                        <span className="text-[10px] font-mono text-action-primary tabular-nums">{Math.round(selected.opacity * 100)}%</span>
                      </div>
                      <input
                        type="range" min={0} max={100} value={Math.round(selected.opacity * 100)}
                        onChange={(e) => updateZone(selected.id, { opacity: (parseInt(e.target.value) || 0) / 100 })}
                        className="w-full h-1.5 accent-amber-500 cursor-pointer"
                      />
                    </div>
                    <div>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle block mb-1">Fit</span>
                      <div className="flex gap-1">
                        {(["cover", "contain", "fill"] as const).map((f) => (
                          <button
                            key={f}
                            onClick={() => updateZone(selected.id, { fit: f })}
                            className={`flex-1 px-2 py-1 rounded text-[10px] font-bold uppercase transition-all ${
                              selected.fit === f ? "bg-action-primary text-black" : "bg-console-surface-raised text-console-text-muted hover:text-console-text"
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Label</span>
                      <input
                        value={selected.label ?? ""}
                        onChange={(e) => updateZone(selected.id, { label: e.target.value || undefined })}
                        placeholder="Zone label"
                        className="bg-console-surface-raised border border-console-border rounded-md px-2 py-1 text-xs text-console-text focus:outline-none focus:border-action-primary"
                      />
                    </label>
                    {(selected.item.type === "Media" || selected.item.type === "Camera") && (
                      <label className="flex items-center gap-2 text-xs text-console-text cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!selected.muted}
                          onChange={(e) => updateZone(selected.id, { muted: e.target.checked || undefined })}
                          className="accent-amber-500"
                        />
                        Mute zone audio
                      </label>
                    )}
                  </div>
                </Section>

                {(selected.item.type === "Verse" || (selected.item.type === "Song" && selected.item.data.style !== "LowerThird")) && (
                  <Section title="Typography" icon={TypeIcon}>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Font family</span>
                      <select
                        value={selected.font_family ?? ""}
                        onChange={(e) => updateZone(selected.id, { font_family: e.target.value || undefined })}
                        className="w-full bg-console-surface-raised border border-console-border rounded-md px-2 py-1 text-xs text-console-text focus:outline-none focus:border-action-primary"
                      >
                        <option value="">Inherit</option>
                        {FONTS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-console-text-subtle">Font size (pt)</span>
                      <input
                        type="number"
                        step={1}
                        min={8}
                        max={400}
                        value={selected.font_size ?? ""}
                        placeholder="Inherit"
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          updateZone(selected.id, { font_size: Number.isFinite(v) && v > 0 ? v : undefined });
                        }}
                        className="w-full bg-console-surface-raised border border-console-border rounded-md px-2 py-1 text-xs text-console-text focus:outline-none focus:border-action-primary"
                      />
                    </label>
                    <p className="text-[9px] text-console-text-subtle">
                      Leave blank to inherit the output font settings. Applies to verse and song text inside this zone.
                    </p>
                  </Section>
                )}
              </>
            ) : (
              <p className="p-3 text-[11px] text-console-text-subtle leading-relaxed">
                Select a zone on the canvas to edit its content, position and appearance.
              </p>
            )}

            <Section
              title={`Zones (${zones.length})`}
              icon={Layers}
              defaultOpen={zones.length > 1}
              right={
                <button
                  onClick={addZone}
                  title="Add zone"
                  className="p-1 rounded text-console-text-muted hover:text-console-text hover:bg-console-surface-strong transition-colors"
                >
                  <Plus size={11} />
                </button>
              }
            >
              {zones.length === 0 ? (
                <p className="text-[11px] text-console-text-subtle">Pick a layout preset above or add a zone to begin.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {[...zones].sort((a, b) => a.z - b.z).map((z) => (
                    <div
                      key={z.id}
                      onClick={() => setSelectedId(z.id)}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-[10px] cursor-pointer transition-all group ${
                        z.id === selectedId
                          ? "bg-action-primary/15 ring-1 ring-action-primary/50 text-action-primary"
                          : "text-console-text-muted hover:bg-console-surface-raised hover:text-console-text"
                      }`}
                    >
                      <span className="w-4 text-center font-mono text-console-text-subtle">{z.z}</span>
                      <span className="truncate flex-1">{z.label || sourceLabel(z.item)}</span>
                      {liveSourceLabel(z.source) && (
                        <span className="flex items-center gap-0.5 text-state-live" title={`Follows live ${liveSourceLabel(z.source)?.toLowerCase()}`}>
                          <Radio size={9} />
                        </span>
                      )}
                      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); reorderZone(z.id, -1); }}
                          title="Send backward"
                          className="p-0.5 rounded hover:bg-console-surface-strong text-console-text-subtle hover:text-console-text"
                        >
                          <ArrowDown size={10} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); reorderZone(z.id, 1); }}
                          title="Bring forward"
                          className="p-0.5 rounded hover:bg-console-surface-strong text-console-text-subtle hover:text-console-text"
                        >
                          <ArrowUp size={10} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeZone(z.id); }}
                          title="Remove zone"
                          className="p-0.5 rounded hover:bg-state-live/20 text-console-text-subtle hover:text-state-live"
                        >
                          <Trash2 size={10} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>

        {/* Canvas */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="min-h-11 shrink-0 border-b border-console-border bg-console-surface/70 px-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Monitor size={13} className="text-console-text-subtle" />
              <span className="text-[10px] font-black uppercase tracking-widest text-console-text">Composition Preview</span>
              <span className="text-[10px] text-console-text-subtle">
                16:9 · {zones.length} zone{zones.length !== 1 ? "s" : ""}
              </span>
            </div>
            <span className="text-[10px] text-console-text-subtle">
              {Math.round(refHeight * 16 / 9)} × {refHeight} reference
            </span>
          </div>

          <div ref={fitRef} className="relative flex-1 min-h-0 overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center p-6">
              {fit.w > 0 && (
                <div
                  ref={canvasRef}
                  className="relative bg-black rounded-xl overflow-visible border border-console-border shadow-[0_8px_60px_rgba(0,0,0,0.6)] select-none"
                  style={{ width: fit.w, height: fit.h }}
                  onPointerDown={() => setSelectedId(null)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerLeave={endDrag}
                  onPointerCancel={endDrag}
                >
                  {/* Content layer — the zones themselves (clipped to canvas) */}
                  <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none">
                    {zones.map((z) => (
                      <ZoneContent
                        key={z.id}
                        zone={z}
                        settings={settings}
                        colors={themeColors}
                        windowScale={windowScale}
                        appDataDir={appDataDir}
                        phoneStreams={phoneStreams}
                      />
                    ))}
                  </div>

                  {/* Interaction layer — transparent drag/resize boxes on top */}
                  {zones.map((z) => {
                    const isSel = z.id === selectedId;
                    return (
                      <div
                        key={`i-${z.id}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedId(z.id);
                          if (e.button === 0) startDrag(e, z.id, "move");
                        }}
                        className={`absolute cursor-move transition-shadow ${isSel ? "ring-2 ring-action-primary shadow-[inset_0_0_0_1px_rgba(244,183,64,0.35)]" : "hover:ring-1 hover:ring-white/30"}`}
                        style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%`, zIndex: z.z + 100 }}
                      >
                        {isSel && (
                          <>
                            <span className="absolute -top-7 left-0 z-50 bg-action-primary text-black text-[8px] font-black uppercase px-1.5 py-0.5 rounded whitespace-nowrap shadow">
                              {sourceLabel(z.item)}
                            </span>
                            {liveSourceLabel(z.source) && (
                              <span className="absolute -top-7 left-1/2 z-50 -translate-x-1/2 bg-state-live text-white text-[8px] font-black uppercase px-1.5 py-0.5 rounded whitespace-nowrap shadow flex items-center gap-1">
                                <Radio size={8} /> {liveSourceLabel(z.source)}
                              </span>
                            )}
                            {HANDLES.map((h) => (
                              <span
                                key={h.mode}
                                onPointerDown={(e) => { e.stopPropagation(); setSelectedId(z.id); startDrag(e, z.id, h.mode); }}
                                className={`absolute w-3 h-3 bg-action-primary border border-black/60 rounded-[3px] shadow ${h.cursor} hover:scale-110 transition-transform`}
                                style={h.pos}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })}

                  {zones.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p className="text-xs text-console-text-subtle">Pick a layout preset or add a zone to begin.</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Content picker overlay */}
            {pickerOpen && selected && (
              <div className="absolute inset-0 z-40 flex">
                <div className="flex-1 bg-black/50 backdrop-blur-[1px]" onClick={() => setPickerOpen(false)} />
                <ContentPicker
                  onPick={(item) => updateZone(selected.id, { item })}
                  onClose={() => setPickerOpen(false)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}