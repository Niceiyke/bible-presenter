import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Upload, Trash2, Tag, BookOpen, X, Camera, Search, RotateCcw, Repeat, Volume2, Eye } from "lucide-react";
import { useAppStore } from "../store";
import type { DisplayItem, MediaFitMode, MediaItem } from "../types";
import { EditMediaModal } from "./EditMediaModal";
import { CameraTab } from "./CameraTab";
import { MediaThumb, MediaTypeIcon, formatDuration } from "./MediaThumb";
import { DeleteMediaModal } from "./DeleteMediaModal";
import { ContentCard, Button, ConfirmModal } from "./ui";

interface MediaTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  onLoadMedia: () => void;
  onDeleteMedia: (id: string, removeFile?: boolean) => void;
  onSetAsLogo: (path: string) => void;
  onSetAsBackgroundLogo: (path: string) => void;
}

const FIT_OPTIONS: { mode: MediaFitMode; label: string; title: string }[] = [
  { mode: "contain", label: "FIT",    title: "Fit — show entire image, letterbox if needed" },
  { mode: "cover",   label: "CROP",   title: "Crop — fill frame, clip edges to maintain ratio" },
  { mode: "fill",    label: "STRETCH",title: "Stretch — fill frame, ignore aspect ratio" },
];

type MediaFilter = "image" | "video" | "audio" | "camera";
type SortKey = "name" | "newest" | "type" | "duration";

export function MediaTab({
  onStage,
  onLive,
  onAddToSchedule,
  onLoadMedia,
  onDeleteMedia,
  onSetAsLogo,
  onSetAsBackgroundLogo,
}: MediaTabProps) {
  const [showEditModal, setShowEditModal] = React.useState(false);
  const [selectedMediaItem, setSelectedMediaItem] = React.useState<MediaItem | null>(null);
  const [deleteItem, setDeleteItem] = React.useState<MediaItem | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [bulkRefsUsed, setBulkRefsUsed] = React.useState(false);
  const [selectedMediaItems, setSelectedMediaItems] = React.useState<string[]>([]);
  const [bulkTagInput, setBulkTagInput] = React.useState("");
  const [bulkCategoryInput, setBulkCategoryInput] = React.useState("");
  const [missingIds, setMissingIds] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState("");
  const [sortKey, setSortKey] = React.useState<SortKey>("name");

  const {
    media, setMedia,
    bulkDeleteMedia, bulkUpdateMedia, setMediaPlayback,
    mediaFilter, setMediaFilter,
  } = useAppStore();

  // Bulk existence check — one round-trip for the whole library instead of an
  // invoke per item (the old flow did N serial `check_media_existence` calls).
  const scanMissing = React.useCallback(async () => {
    const items = useAppStore.getState().media;
    if (items.length === 0) { setMissingIds(new Set()); return; }
    try {
      const results = await invoke<boolean[]>("check_media_existence_bulk", {
        paths: items.map((m) => m.path),
      });
      const missing = new Set<string>();
      items.forEach((m, i) => { if (results[i] === false) missing.add(m.id); });
      setMissingIds(missing);
    } catch (err) {
      console.error("Bulk existence check failed", err);
    }
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => scanMissing(), 300);
    return () => clearTimeout(t);
  }, [media.length, scanMissing]);

  const handleRelink = async (item: MediaItem) => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: item.media_type === "Image" ? "Images" : item.media_type === "Audio" ? "Audio" : "Videos", extensions: item.media_type === "Image" ? ["jpg", "jpeg", "png", "gif", "webp", "bmp"] : item.media_type === "Audio" ? ["mp3", "wav", "ogg", "m4a", "aac", "flac"] : ["mp4", "mkv", "avi", "mov"] }],
      });
      if (!selected) return;
      await useAppStore.getState().relinkMedia(item.id, selected);
    } catch (err) {
      console.error("Relink failed", err);
    }
  };

  async function handleSetFit(id: string, fitMode: MediaFitMode) {
    await invoke("set_media_fit", { id, fitMode });
    setMedia(media.map((m) => m.id === id ? { ...m, fit_mode: fitMode } : m));
  }

  async function handleDeleteOne(item: MediaItem) {
    // Delete-safety: the modal shows references and lets the operator decide
    // between removing from the library only or deleting the file, too.
    setDeleteItem(item);
  }

  function handleToggleSelect(id: string) {
    setSelectedMediaItems((prev) =>
      prev.includes(id) ? prev.filter((_id) => _id !== id) : [...prev, id]
    );
  }

  async function handleDeleteSelected() {
    const items = media.filter((m) => selectedMediaItems.includes(m.id));
    const refs = await Promise.all(
      items.map((it) => invoke<string[]>("get_media_references", { id: it.id }).catch(() => [] as string[]))
    );
    setBulkRefsUsed(refs.some((r) => r.length > 0));
    setBulkDeleteOpen(true);
  }

  async function handleAddBulkTags() {
    const tagsToAdd = bulkTagInput.split(',').map(s => s.trim()).filter(Boolean);
    if (tagsToAdd.length > 0) {
      await bulkUpdateMedia(selectedMediaItems, tagsToAdd, [], undefined);
      setSelectedMediaItems([]);
      setBulkTagInput("");
    }
  }

  async function handleRemoveBulkTags() {
    const tagsToRemove = bulkTagInput.split(',').map(s => s.trim()).filter(Boolean);
    if (tagsToRemove.length > 0) {
      await bulkUpdateMedia(selectedMediaItems, [], tagsToRemove, undefined);
      setSelectedMediaItems([]);
      setBulkTagInput("");
    }
  }

  async function handleSetBulkCategory() {
    const categoryToSet = bulkCategoryInput.trim();
    if (categoryToSet !== "") {
      await bulkUpdateMedia(selectedMediaItems, [], [], categoryToSet);
      setSelectedMediaItems([]);
      setBulkCategoryInput("");
    }
  }

  async function handleClearBulkCategory() {
    await bulkUpdateMedia(selectedMediaItems, [], [], ""); // Pass empty string to clear
    setSelectedMediaItems([]);
    setBulkCategoryInput("");
  }

  const applyFilter = (f: MediaFilter) => (m: MediaItem) => {
    if (f === "image") return m.media_type === "Image";
    if (f === "video") return m.media_type === "Video";
    if (f === "audio") return m.media_type === "Audio";
    return true;
  };

  const applySearch = (m: MediaItem) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      (m.description ?? "").toLowerCase().includes(q) ||
      (m.category ?? "").toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  };

  const sorted = React.useMemo(() => {
    const list = media.filter(applyFilter(mediaFilter as MediaFilter)).filter(applySearch);
    const copy = [...list];
    switch (sortKey) {
      case "newest": return copy.reverse(); // insertion order ~ creation order
      case "type": return copy.sort((a, b) => a.media_type.localeCompare(b.media_type) || a.name.localeCompare(b.name));
      case "duration": return copy.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      default: return copy.sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [media, mediaFilter, search, sortKey]);

  const FILTER_TABS: { f: MediaFilter; label: string }[] = [
    { f: "image", label: `Images (${media.filter((m) => m.media_type === "Image").length})` },
    { f: "video", label: `Videos (${media.filter((m) => m.media_type === "Video").length})` },
    { f: "audio", label: `Audio (${media.filter((m) => m.media_type === "Audio").length})` },
    { f: "camera", label: "Camera" },
  ];

  const isAudio = mediaFilter === "audio";

  return (
    <div className="flex flex-col gap-3">
      {/* Header + upload */}
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Media Library</h2>
        {mediaFilter !== "camera" && (
          <button onClick={onLoadMedia} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1.5">
            <Upload size={11} /> UPLOAD
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-0.5 bg-slate-900/60 rounded-lg p-0.5 border border-slate-800">
        {FILTER_TABS.map(({ f, label }) => (
          <button
            key={f}
            onClick={() => setMediaFilter(f)}
            className={`flex-1 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide transition-all flex items-center justify-center gap-1.5 ${
              mediaFilter === f
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {f === "camera" ? <><Camera size={10} /> Camera</> : label}
          </button>
        ))}
      </div>

      {/* Search + sort (image/video/audio views) */}
      {mediaFilter !== "camera" && (
        <div className="flex gap-2 items-center">
          <div className="flex-1 flex items-center gap-1.5 bg-slate-900/60 border border-slate-800 rounded-lg px-2 py-1.5">
            <Search size={11} className="text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, tags, category…"
              className="flex-1 bg-transparent text-white text-[10px] outline-none placeholder:text-slate-600"
            />
            {search && <button onClick={() => setSearch("")} className="text-slate-500 hover:text-slate-300"><X size={11} /></button>}
          </div>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-slate-900 border border-slate-800 rounded-lg text-[10px] text-slate-300 px-2 py-1.5 outline-none"
          >
            <option value="name">Name A–Z</option>
            <option value="newest">Newest first</option>
            <option value="type">Type</option>
            <option value="duration">Longest first</option>
          </select>
        </div>
      )}

      {/* Camera View */}
      {mediaFilter === "camera" && (
        <CameraTab onStage={onStage} onLive={onLive} />
      )}

      {/* Bulk action bar */}
      {selectedMediaItems.length > 0 && mediaFilter !== "camera" && (
        <div className="flex flex-col gap-2 p-2 bg-slate-800/50 border border-slate-700 rounded-lg">
          <p className="text-xs text-slate-400 font-bold">Selected: {selectedMediaItems.length} items</p>
          <div className="flex gap-2">
            <button
              onClick={handleDeleteSelected}
              className="flex-1 bg-red-900/50 hover:bg-red-800 text-red-300 text-[9px] font-bold py-2 rounded transition-all flex items-center justify-center gap-1"
            >
              <Trash2 size={11} /> DELETE SELECTED
            </button>
            <button
              onClick={() => setSelectedMediaItems([])}
              className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[9px] font-bold py-2 rounded transition-all flex items-center justify-center gap-1"
            >
              <X size={11} /> CLEAR SELECTION
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Tags (comma-separated)"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              className="flex-1 rounded-md bg-slate-700 border-transparent text-white focus:border-amber-500 focus:ring-amber-500 text-sm h-8"
            />
            <button
              onClick={handleAddBulkTags}
              className="bg-blue-900/50 hover:bg-blue-700 text-blue-300 text-[9px] font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1"
              title="Add tags to selected"
            >
              <Tag size={11} /> ADD
            </button>
            <button
              onClick={handleRemoveBulkTags}
              className="bg-purple-900/50 hover:bg-purple-700 text-purple-300 text-[9px] font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1"
              title="Remove tags from selected"
            >
              <X size={11} /> REMOVE
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Set category"
              value={bulkCategoryInput}
              onChange={(e) => setBulkCategoryInput(e.target.value)}
              className="flex-1 rounded-md bg-slate-700 border-transparent text-white focus:border-amber-500 focus:ring-amber-500 text-sm h-8"
            />
            <button
              onClick={handleSetBulkCategory}
              className="bg-green-900/50 hover:bg-green-700 text-green-300 text-[9px] font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1"
              title="Set category for selected"
            >
              <BookOpen size={11} /> SET
            </button>
            <button
              onClick={handleClearBulkCategory}
              className="bg-orange-900/50 hover:bg-orange-700 text-orange-300 text-[9px] font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1"
              title="Clear category for selected"
            >
              <X size={11} /> CLEAR
            </button>
          </div>
        </div>
      )}

      {/* Grid (image / video / audio views) */}
      {mediaFilter !== "camera" && (
        sorted.length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">
            {search ? "No media matches your search." : "No items here yet. Click + UPLOAD to add."}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {sorted.map((item) => {
              const missing = missingIds.has(item.id);
              return (
                <ContentCard
                  key={item.id}
                  selected={selectedMediaItems.includes(item.id)}
                  missing={missing}
                >
                  {/* Checkbox overlay */}
                  <input
                    type="checkbox"
                    className="absolute top-2 left-2 z-20 w-4 h-4 text-action-primary bg-console-surface-raised border-console-border rounded focus:ring-action-primary focus:ring-2 cursor-pointer"
                    checked={selectedMediaItems.includes(item.id)}
                    onChange={() => handleToggleSelect(item.id)}
                  />
                  {/* Type badge */}
                  {!missing && (
                    <span className="absolute top-2 right-2 z-20 px-1.5 py-0.5 rounded-md bg-black/50 backdrop-blur-sm text-console-text text-[8px] font-black uppercase tracking-wide flex items-center gap-1">
                      <MediaTypeIcon item={item} />
                      {item.media_type}
                    </span>
                  )}
                  <div className="aspect-video overflow-hidden bg-console-canvas shrink-0 relative">
                    <MediaThumb item={item} className="w-full h-full transition-transform duration-300 group-hover:scale-105" dimmed={missing} />
                    {/* Permanent quick actions */}
                    {!missing && (
                      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-1.5 p-2 bg-gradient-to-t from-black/70 to-transparent">
                        <Button variant="ghost" size="sm" onClick={() => onStage({ type: "Media", data: item })}>Stage</Button>
                        <Button variant="primary" size="sm" icon={<Eye size={11} />} onClick={() => onLive({ type: "Media", data: item })}>Live</Button>
                        <Button variant="bare" size="sm" onClick={() => onAddToSchedule({ type: "Media", data: item })}>Service</Button>
                      </div>
                    )}
                    {missing && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-state-live-soft/30">
                        <X className="text-state-error" size={24} />
                        <span className="text-[8px] font-black text-state-error uppercase tracking-tighter bg-black/60 px-1 rounded">FILE MISSING</span>
                      </div>
                    )}
                  </div>
                  <div className="px-2.5 py-2 flex flex-col gap-1.5 flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[10px] font-bold text-console-text truncate flex-1" title={item.name}>
                        {item.name}
                      </p>
                      {item.duration != null && !missing && (
                        <span className="text-[8px] text-console-text-subtle font-mono shrink-0">{formatDuration(item.duration)}</span>
                      )}
                    </div>
                    {/* Metadata chips */}
                    <div className="flex flex-wrap gap-1 min-h-0">
                      {item.category && (
                        <span className="px-1.5 py-0.5 rounded bg-tool-design/10 text-tool-design text-[7px] font-bold truncate max-w-full">{item.category}</span>
                      )}
                      {item.tags && item.tags.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-tool-audio/10 text-tool-audio text-[7px] font-bold truncate max-w-full">{item.tags.slice(0, 2).join(', ')}{item.tags.length > 2 ? "+" : ""}</span>
                      )}
                    </div>

                    {/* Fit mode selector (image/video) */}
                    {!isAudio && (
                      <div className="flex gap-0.5">
                        {FIT_OPTIONS.map(({ mode, label, title }) => (
                          <button
                            key={mode}
                            onClick={() => handleSetFit(item.id, mode)}
                            title={title}
                            className={`flex-1 text-[7px] font-bold py-1 rounded transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                              (item.fit_mode ?? "contain") === mode
                                ? "bg-tool-design text-white"
                                : "bg-console-surface-strong text-console-text-muted hover:text-console-text"
                            }`}
                          >{label}</button>
                        ))}
                      </div>
                    )}

                    {/* Playback config (video/audio): loop + rate + volume */}
                    {!missing && (item.media_type === "Video" || item.media_type === "Audio") && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setMediaPlayback(item.id, !(item.loop_playback ?? true), item.playback_rate ?? 1, item.volume ?? 1)}
                          title={item.loop_playback ?? true ? "Loop enabled — click to play once" : "Play once — click to loop"}
                          className={`flex items-center gap-0.5 text-[7px] font-bold px-1.5 py-0.5 rounded transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${item.loop_playback ?? true ? "bg-action-primary/20 text-action-primary" : "bg-console-surface-strong text-console-text-muted"}`}
                        >
                          <Repeat size={8} /> {item.loop_playback ?? true ? "LOOP" : "ONCE"}
                        </button>
                        <select
                          value={item.playback_rate ?? 1}
                          onChange={(e) => setMediaPlayback(item.id, item.loop_playback ?? true, parseFloat(e.target.value), item.volume ?? 1)}
                          className="bg-console-surface-strong text-[8px] text-console-text-muted rounded px-1 py-0.5 outline-none"
                          title="Playback speed"
                        >
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
                        </select>
                        <button
                          onClick={() => setMediaPlayback(item.id, item.loop_playback ?? true, item.playback_rate ?? 1, (item.volume ?? 1) > 0 ? 0 : 1)}
                          title={item.volume ?? 1 > 0 ? "Mute (persisted)" : "Unmute"}
                          className="flex items-center gap-0.5 text-[7px] font-bold px-1.5 py-0.5 rounded transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] bg-console-surface-strong text-console-text-muted"
                        >
                          <Volume2 size={8} /> {(item.volume ?? 1) > 0 ? "MUTE" : "UNMUTE"}
                        </button>
                      </div>
                    )}

                    {/* Bottom action row */}
                    {missing ? (
                      <button onClick={() => handleRelink(item)} className="w-full bg-state-live hover:bg-state-live/90 text-white text-[7px] font-black py-1.5 rounded-lg transition-all flex items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">
                        <RotateCcw size={10} /> RELINK MISSING FILE
                      </button>
                    ) : (
                      <div className="grid grid-cols-4 gap-1 border-t border-console-border pt-1.5 mt-auto">
                        <button onClick={() => { setSelectedMediaItem(item); setShowEditModal(true); }} className="bg-tool-design/25 hover:bg-tool-design text-tool-design text-[7px] font-bold py-1.5 rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title="Edit Metadata">EDIT</button>
                        <button onClick={() => onSetAsBackgroundLogo(item.path)} className="bg-tool-design/25 hover:bg-tool-design text-tool-design text-[7px] font-bold py-1.5 rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title="Set as Background Logo">BG LOGO</button>
                        <button onClick={() => onSetAsLogo(item.path)} className="bg-tool-audio/25 hover:bg-tool-audio text-tool-audio text-[7px] font-bold py-1.5 rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title="Set as Corner Logo">CORNER</button>
                        <button onClick={() => handleDeleteOne(item)} className="bg-state-live/25 hover:bg-state-live text-state-live text-[7px] font-bold py-1.5 rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title="Delete">DEL</button>
                      </div>
                    )}
                  </div>
                </ContentCard>
              );
            })}
          </div>
        )
      )}

      {/* Edit Media Modal */}
      <EditMediaModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        mediaItem={selectedMediaItem}
      />

      {/* Delete safety modal */}
      <DeleteMediaModal
        item={deleteItem}
        onDelete={async (id, removeFile) => { await onDeleteMedia(id, removeFile); }}
        onClose={() => setDeleteItem(null)}
      />

      {/* Bulk delete confirmation */}
      <ConfirmModal
        open={bulkDeleteOpen}
        title={`Delete ${selectedMediaItems.length} items?`}
        description={bulkRefsUsed
          ? "Some selected items are still used in services, presentations, or scenes. Deleting them will orphan those references."
          : "Remove the selected items from the library. The files on disk will also be deleted."}
        confirmLabel="Delete Items"
        confirmVariant="live"
        onConfirm={async () => {
          await bulkDeleteMedia(selectedMediaItems);
          setSelectedMediaItems([]);
        }}
        onClose={() => setBulkDeleteOpen(false)}
      />
    </div>
  );
}
