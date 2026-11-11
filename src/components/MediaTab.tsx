import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Upload, Trash2, Tag, BookOpen, X, Camera, Search, RotateCcw, LibraryBig, ListPlus, Radio, Send } from "lucide-react";
import { useAppStore } from "../store";
import type { DisplayItem, MediaFitMode, MediaItem } from "../types";
import { EditMediaModal } from "./EditMediaModal";
import { CameraTab } from "./CameraTab";
import { MediaThumb, MediaTypeIcon } from "./MediaThumb";
import { DeleteMediaModal } from "./DeleteMediaModal";
import { ContentCard, Button, ConfirmModal } from "./ui";
import { MediaDetailPanel } from "./MediaDetailPanel";
import { setDisplayItemDragData } from "../utils/dragItem";

interface MediaTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  onLoadMedia: () => void;
  onDeleteMedia: (id: string, removeFile?: boolean) => void;
  onSetAsBackgroundLogo: (path: string) => void;
}

type MediaFilter = "all" | "image" | "video" | "audio" | "camera";
type SortKey = "name" | "newest" | "type" | "duration";

export function MediaTab({
  onStage,
  onLive,
  onAddToSchedule,
  onLoadMedia,
  onDeleteMedia,
  onSetAsBackgroundLogo,
}: MediaTabProps) {
  const [showEditModal, setShowEditModal] = React.useState(false);
  const [selectedMediaItem, setSelectedMediaItem] = React.useState<MediaItem | null>(null);
  const [inspectedMediaId, setInspectedMediaId] = React.useState<string | null>(null);
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
    if (f === "all") return true;
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
  const inspectedMedia = media.find((item) => item.id === inspectedMediaId) ?? null;

  const FILTER_TABS: { f: MediaFilter; label: string }[] = [
    { f: "all", label: `All (${media.length})` },
    { f: "image", label: `Images (${media.filter((m) => m.media_type === "Image").length})` },
    { f: "video", label: `Videos (${media.filter((m) => m.media_type === "Video").length})` },
    { f: "audio", label: `Audio (${media.filter((m) => m.media_type === "Audio").length})` },
    { f: "camera", label: "Camera" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto xl:overflow-hidden">
      <section className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-console-border bg-console-surface/80 px-3 py-2.5 shadow-lg shadow-black/10">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tool-design/12 text-tool-design"><LibraryBig size={15} /></span>
          <div className="min-w-0"><h1 className="truncate text-sm font-black text-console-text">Media library</h1><p className="text-[10px] font-medium text-console-text-subtle">{media.length} items · images, video, and audio</p></div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex gap-0.5 rounded-lg border border-console-border bg-console-canvas/70 p-0.5">
        {FILTER_TABS.map(({ f, label }) => (
          <button
            key={f}
            onClick={() => setMediaFilter(f)}
            className={`h-7 px-2 rounded text-[10px] font-bold uppercase tracking-wide transition-all flex items-center justify-center gap-1 ${
              mediaFilter === f
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {f === "camera" ? <><Camera size={10} /> Camera</> : label}
          </button>
        ))}
          </div>
          {mediaFilter !== "camera" && <Button size="sm" onClick={onLoadMedia}><Upload size={12} /> Upload</Button>}
        </div>
      </section>

      {/* Search + sort (image/video/audio views) */}
      {mediaFilter !== "camera" && (
        <div className="flex shrink-0 gap-2 items-center">
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
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          <CameraTab onStage={onStage} onLive={onLive} />
        </div>
      )}

      {/* Bulk action bar */}
      {selectedMediaItems.length > 0 && mediaFilter !== "camera" && (
        <details className="shrink-0 rounded-xl border border-console-border bg-console-surface/75">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] font-bold text-console-text-muted"><span className="flex h-5 min-w-5 items-center justify-center rounded bg-action-primary/15 px-1 text-[9px] font-black text-action-primary">{selectedMediaItems.length}</span><span className="flex-1">Selected media</span><span className="text-[8px] uppercase tracking-wide text-console-text-subtle">Manage</span></summary>
          <div className="flex flex-wrap items-center gap-2 border-t border-console-border p-2">
            <button onClick={handleDeleteSelected} className="flex h-7 items-center gap-1 rounded bg-state-live-soft px-2 text-[9px] font-bold text-state-live hover:bg-state-live hover:text-white"><Trash2 size={11} /> Delete</button>
            <button onClick={() => setSelectedMediaItems([])} className="flex h-7 items-center gap-1 rounded bg-console-surface-raised px-2 text-[9px] font-bold text-console-text-muted hover:text-console-text"><X size={11} /> Clear</button>
            <span className="hidden h-5 w-px bg-console-border sm:block" />
            <input type="text" placeholder="Tags, comma-separated" value={bulkTagInput} onChange={(e) => setBulkTagInput(e.target.value)} className="h-7 min-w-40 flex-1 rounded bg-console-canvas px-2 text-[9px] text-console-text outline-none placeholder:text-console-text-subtle" />
            <button onClick={handleAddBulkTags} className="flex h-7 items-center gap-1 rounded bg-tool-design/15 px-2 text-[9px] font-bold text-tool-design"><Tag size={11} /> Add tags</button>
            <button onClick={handleRemoveBulkTags} className="flex h-7 items-center gap-1 rounded bg-console-surface-raised px-2 text-[9px] font-bold text-console-text-muted"><X size={11} /> Remove</button>
            <input type="text" placeholder="Category" value={bulkCategoryInput} onChange={(e) => setBulkCategoryInput(e.target.value)} className="h-7 w-28 rounded bg-console-canvas px-2 text-[9px] text-console-text outline-none placeholder:text-console-text-subtle" />
            <button onClick={handleSetBulkCategory} className="flex h-7 items-center gap-1 rounded bg-tool-design/15 px-2 text-[9px] font-bold text-tool-design"><BookOpen size={11} /> Set</button>
            <button onClick={handleClearBulkCategory} className="flex h-7 items-center gap-1 rounded bg-console-surface-raised px-2 text-[9px] font-bold text-console-text-muted" title="Clear category"><X size={11} /></button>
          </div>
        </details>
      )}

      {/* Grid (image / video / audio views) */}
      {mediaFilter !== "camera" && (
        sorted.length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">
            {search ? "No media matches your search." : "No items here yet. Click + UPLOAD to add."}
          </p>
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface/55 p-3">
              <div className="mb-2 flex shrink-0 items-center justify-between gap-3 px-1"><div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-console-text-muted">{mediaFilter === "all" ? "All media" : `${mediaFilter}s`}</p><p className="mt-0.5 text-[11px] text-console-text-subtle">{sorted.length} {sorted.length === 1 ? "item" : "items"} · Select one to inspect</p></div></div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
                {sorted.map((item) => {
                  const missing = missingIds.has(item.id);
                  const display = { type: "Media" as const, data: item };
                  return <ContentCard key={item.id} selected={inspectedMediaId === item.id || selectedMediaItems.includes(item.id)} missing={missing} className="group overflow-hidden">
                    <input type="checkbox" className="absolute left-2 top-2 z-20 h-4 w-4 cursor-pointer rounded border-console-border bg-console-surface-raised text-action-primary focus:ring-2 focus:ring-action-primary" checked={selectedMediaItems.includes(item.id)} onChange={() => handleToggleSelect(item.id)} aria-label={`Select ${item.name}`} />
                    <div draggable title="Drag to Up Next" onDragStart={(event) => setDisplayItemDragData(event, display)}>
                      <button type="button" onClick={() => setInspectedMediaId(item.id)} className="relative block aspect-video w-full overflow-hidden bg-console-canvas text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-action-primary" aria-label={`Inspect ${item.name}`}><MediaThumb item={item} className="h-full w-full transition-transform duration-300 group-hover:scale-105" dimmed={missing} />{!missing && <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-console-text backdrop-blur-sm"><MediaTypeIcon item={item} />{item.media_type}</span>}{missing && <span className="absolute inset-0 flex items-center justify-center bg-state-live-soft/40 text-[10px] font-bold text-state-error">FILE MISSING</span>}</button>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1 p-2">
                      <button type="button" onClick={() => setInspectedMediaId(item.id)} className="min-w-0 truncate text-left text-[11px] font-bold text-console-text">{item.name}</button>
                      <p className="truncate text-[10px] text-console-text-subtle">{item.category || item.tags.slice(0, 2).join(" · ") || "No category or tags"}</p>
                      {missing ? <button type="button" onClick={() => handleRelink(item)} className="mt-0.5 flex h-6 items-center justify-center gap-1 rounded bg-state-live-soft text-[10px] font-bold text-state-live"><RotateCcw size={10} /> RELINK</button> : <div className="mt-0.5 flex h-7 items-center gap-1 border-t border-console-border pt-1"><button type="button" onClick={() => onStage(display)} className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-state-stage px-1 text-[10px] font-bold text-slate-950"><Send size={9} /> STAGE</button><button type="button" onClick={() => onLive(display)} className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-action-primary px-1 text-[10px] font-bold text-black"><Radio size={9} /> LIVE</button><button type="button" onClick={() => onAddToSchedule(display)} className="flex h-6 w-6 items-center justify-center rounded bg-console-surface-raised text-console-text-muted" title="Add to service plan" aria-label={`Add ${item.name} to service plan`}><ListPlus size={10} /></button></div>}
                    </div>
                  </ContentCard>;
                })}
              </div>
              </div>
            </section>
            <MediaDetailPanel
              item={inspectedMedia}
              missing={inspectedMedia ? missingIds.has(inspectedMedia.id) : false}
              onClose={() => setInspectedMediaId(null)}
              onStage={onStage}
              onLive={onLive}
              onAddToSchedule={onAddToSchedule}
              onEdit={() => { if (inspectedMedia) { setSelectedMediaItem(inspectedMedia); setShowEditModal(true); } }}
              onDelete={() => { if (inspectedMedia) handleDeleteOne(inspectedMedia); }}
              onRelink={() => { if (inspectedMedia) void handleRelink(inspectedMedia); }}
              onSetFit={(fitMode) => { if (inspectedMedia) void handleSetFit(inspectedMedia.id, fitMode); }}
              onSetPlayback={(loop, rate, volume) => { if (inspectedMedia) void setMediaPlayback(inspectedMedia.id, loop, rate, volume); }}
              onSetAsBackgroundLogo={() => { if (inspectedMedia) onSetAsBackgroundLogo(inspectedMedia.path); }}
            />
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
