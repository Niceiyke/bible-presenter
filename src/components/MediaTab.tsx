import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Upload, Trash2, Tag, BookOpen, X, Camera } from "lucide-react";
import { useAppStore } from "../store";
import type { DisplayItem, MediaFitMode, MediaItem } from "../types";
import { EditMediaModal } from "./EditMediaModal";
import { CameraTab } from "./CameraTab";

interface MediaTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  onLoadMedia: () => void;
  onDeleteMedia: (id: string) => void;
  onSetAsLogo: (path: string) => void;
  onSetAsBackgroundLogo: (path: string) => void;
}

const FIT_OPTIONS: { mode: MediaFitMode; label: string; title: string }[] = [
  { mode: "contain", label: "FIT",    title: "Fit — show entire image, letterbox if needed" },
  { mode: "cover",   label: "CROP",   title: "Crop — fill frame, clip edges to maintain ratio" },
  { mode: "fill",    label: "STRETCH",title: "Stretch — fill frame, ignore aspect ratio" },
];

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
  const [selectedMediaItems, setSelectedMediaItems] = React.useState<string[]>([]);
  const [bulkTagInput, setBulkTagInput] = React.useState("");
  const [bulkCategoryInput, setBulkCategoryInput] = React.useState("");
  const [missingIds, setMissingIds] = React.useState<Set<string>>(new Set());

  const {
    media, setMedia,
    bulkDeleteMedia, bulkUpdateMedia,
    settings,
    mediaFilter, setMediaFilter,
    liveItem,
  } = useAppStore();

  const scanMissing = React.useCallback(async () => {
    const missing = new Set<string>();
    for (const item of media) {
      const exists = await invoke<boolean>("check_media_existence", { path: item.path });
      if (!exists) missing.add(item.id);
    }
    setMissingIds(missing);
  }, [media]);

  React.useEffect(() => {
    scanMissing();
  }, [media.length]);

  const handleRelink = async (item: MediaItem) => {
    try {
      const selected = await invoke<string | null>("open_file_dialog", {
        multiple: false,
        filters: [{ name: item.media_type === "Image" ? "Images" : "Videos", extensions: item.media_type === "Image" ? ["jpg", "jpeg", "png", "gif", "webp", "bmp"] : ["mp4", "mkv", "avi", "mov"] }],
      });
      if (!selected) return;
      await invoke("update_media_metadata", { 
        id: item.id, 
        path: selected 
      });
      onLoadMedia();
    } catch (err) {
      console.error("Relink failed", err);
    }
  };

  async function handleSetFit(id: string, fitMode: MediaFitMode) {
    await invoke("set_media_fit", { id, fitMode });
    setMedia(media.map((m) => m.id === id ? { ...m, fit_mode: fitMode } : m));
  }

  function handleToggleSelect(id: string) {
    setSelectedMediaItems((prev) =>
      prev.includes(id) ? prev.filter((_id) => _id !== id) : [...prev, id]
    );
  }

  async function handleDeleteSelected() {
    if (window.confirm(`Are you sure you want to delete ${selectedMediaItems.length} selected media items?`)) {
      await bulkDeleteMedia(selectedMediaItems);
      setSelectedMediaItems([]);
    }
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
        {(["image", "video", "camera"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setMediaFilter(f)}
            className={`flex-1 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide transition-all flex items-center justify-center gap-1.5 ${
              mediaFilter === f
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {f === "image" && `Images (${media.filter((m) => m.media_type === "Image").length})`}
            {f === "video" && `Videos (${media.filter((m) => m.media_type === "Video").length})`}
            {f === "camera" && <><Camera size={10} /> Camera</>}
          </button>
        ))}
      </div>

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

      {/* Images grid */}
      {mediaFilter === "image" && (
        media.filter((m) => m.media_type === "Image").length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">No images. Click + UPLOAD to add.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {media.filter((m) => m.media_type === "Image").map((item) => (
              <div key={item.id} className="relative flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                {/* Checkbox overlay */}
                <input
                  type="checkbox"
                  className="absolute top-2 left-2 z-10 w-4 h-4 text-amber-500 bg-slate-700 border-slate-600 rounded focus:ring-amber-500 focus:ring-2"
                  checked={selectedMediaItems.includes(item.id)}
                  onChange={() => handleToggleSelect(item.id)}
                />
                <div className="aspect-video overflow-hidden bg-slate-900 shrink-0 relative">
                  <img src={convertFileSrc(item.thumbnail_path || item.path)} className={`w-full h-full object-cover ${missingIds.has(item.id) ? "opacity-20 grayscale" : ""}`} alt={item.name} />
                  {missingIds.has(item.id) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/20">
                      <X className="text-red-500" size={24} />
                      <span className="text-[8px] font-black text-red-500 uppercase tracking-tighter bg-black/60 px-1 rounded">FILE MISSING</span>
                    </div>
                  )}
                </div>
                <div className="px-1.5 py-1.5">
                  <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                  {/* Display metadata */}
                  {item.description && <p className="text-[7px] text-slate-500 mb-0.5 italic truncate">{item.description}</p>}
                  {item.category && <p className="text-[7px] text-slate-500 mb-0.5">Category: <span className="font-bold">{item.category}</span></p>}
                  {item.tags && item.tags.length > 0 && <p className="text-[7px] text-slate-500 mb-0.5">Tags: {item.tags.join(', ')}</p>}

                  {/* Fit mode selector */}
                  <div className="flex gap-0.5 mb-1.5">
                    {FIT_OPTIONS.map(({ mode, label, title }) => (
                      <button
                        key={mode}
                        onClick={() => handleSetFit(item.id, mode)}
                        title={title}
                        className={`flex-1 text-[7px] font-bold py-0.5 rounded transition-all ${
                          (item.fit_mode ?? "contain") === mode
                            ? "bg-blue-600 text-white"
                            : "bg-slate-700 text-slate-400 hover:text-slate-200"
                        }`}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {missingIds.has(item.id) ? (
                      <button onClick={() => handleRelink(item)} className="col-span-3 bg-red-600 hover:bg-red-500 text-white text-[7px] font-black py-1.5 rounded transition-all flex items-center justify-center gap-1">
                        <Upload size={10} /> RELINK MISSING FILE
                      </button>
                    ) : (
                      <>
                        <button onClick={() => onStage({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[7px] font-bold py-1.5 rounded transition-all" title="Stage">STG</button>
                        <button onClick={() => onLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[7px] font-bold py-1.5 rounded transition-all" title="Display Live">LIVE</button>
                        <button onClick={() => onAddToSchedule({ type: "Media", data: item })} className="bg-purple-600/40 hover:bg-purple-600 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Add to Service">+SVC</button>
                        <button onClick={() => onSetAsBackgroundLogo(item.path)} className="bg-purple-900/50 hover:bg-purple-700 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Background Logo">BG LOGO</button>
                        <button onClick={() => onSetAsLogo(item.path)} className="bg-teal-900/50 hover:bg-teal-700 text-teal-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Corner Logo">CORNER</button>
                        <button onClick={() => { setSelectedMediaItem(item); setShowEditModal(true); }} className="bg-blue-900/50 hover:bg-blue-700 text-blue-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Edit Metadata">EDIT</button>
                      </>
                    )}
                    <button onClick={() => onDeleteMedia(item.id)} className={`bg-red-900/50 hover:bg-red-800 text-red-400 text-[7px] font-bold py-1.5 rounded transition-all ${missingIds.has(item.id) ? "col-span-3 mt-1" : ""}`} title="Delete">DEL</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Videos grid */}
      {mediaFilter === "video" && (
        media.filter((m) => m.media_type === "Video").length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">No videos. Click + UPLOAD to add.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {media.filter((m) => m.media_type === "Video").map((item) => (
              <div key={item.id} className="relative flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                {/* Checkbox overlay */}
                <input
                  type="checkbox"
                  className="absolute top-2 left-2 z-10 w-4 h-4 text-amber-500 bg-slate-700 border-slate-600 rounded focus:ring-amber-500 focus:ring-2"
                  checked={selectedMediaItems.includes(item.id)}
                  onChange={() => handleToggleSelect(item.id)}
                />
                <div className="aspect-video overflow-hidden bg-slate-900 relative shrink-0">
                  <video src={convertFileSrc(item.path)} className={`w-full h-full object-cover ${missingIds.has(item.id) ? "opacity-20 grayscale" : ""}`} muted preload="metadata" />
                  {missingIds.has(item.id) ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/20">
                      <X className="text-red-500" size={24} />
                      <span className="text-[8px] font-black text-red-500 uppercase tracking-tighter bg-black/60 px-1 rounded">FILE MISSING</span>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-white/50 text-xl">▶</span>
                    </div>
                  )}
                </div>
                <div className="px-1.5 py-1.5">
                  <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                  {/* Display metadata */}
                  {item.description && <p className="text-[7px] text-slate-500 mb-0.5 italic truncate">{item.description}</p>}
                  {item.category && <p className="text-[7px] text-slate-500 mb-0.5">Category: <span className="font-bold">{item.category}</span></p>}
                  {item.tags && item.tags.length > 0 && <p className="text-[7px] text-slate-500 mb-0.5">Tags: {item.tags.join(', ')}</p>}
                  {/* Fit mode selector */}
                  <div className="flex gap-0.5 mb-1.5">
                    {FIT_OPTIONS.map(({ mode, label, title }) => (
                      <button
                        key={mode}
                        onClick={() => handleSetFit(item.id, mode)}
                        title={title}
                        className={`flex-1 text-[7px] font-bold py-0.5 rounded transition-all ${
                          (item.fit_mode ?? "contain") === mode
                            ? "bg-blue-600 text-white"
                            : "bg-slate-700 text-slate-400 hover:text-slate-200"
                        }`}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {missingIds.has(item.id) ? (
                      <button onClick={() => handleRelink(item)} className="col-span-3 bg-red-600 hover:bg-red-500 text-white text-[7px] font-black py-1.5 rounded transition-all flex items-center justify-center gap-1">
                        <Upload size={10} /> RELINK MISSING FILE
                      </button>
                    ) : (
                      <>
                        <button onClick={() => onStage({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[7px] font-bold py-1.5 rounded transition-all" title="Stage">STG</button>
                        <button onClick={() => onLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[7px] font-bold py-1.5 rounded transition-all" title="Display Live">LIVE</button>
                        <button onClick={() => onAddToSchedule({ type: "Media", data: item })} className="bg-purple-600/40 hover:bg-purple-600 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Add to Service">+SVC</button>
                        <button onClick={() => onSetAsBackgroundLogo(item.path)} className="bg-purple-900/50 hover:bg-purple-700 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Background Logo">BG LOGO</button>
                        <button onClick={() => onSetAsLogo(item.path)} className="bg-teal-900/50 hover:bg-teal-700 text-teal-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Corner Logo">CORNER</button>
                        <button onClick={() => { setSelectedMediaItem(item); setShowEditModal(true); }} className="bg-blue-900/50 hover:bg-blue-700 text-blue-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Edit Metadata">EDIT</button>
                      </>
                    )}
                    <button onClick={() => onDeleteMedia(item.id)} className={`bg-red-900/50 hover:bg-red-800 text-red-400 text-[7px] font-bold py-1.5 rounded transition-all ${missingIds.has(item.id) ? "col-span-3 mt-1" : ""}`} title="Delete">DEL</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Edit Media Modal */}
      <EditMediaModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        mediaItem={selectedMediaItem}
      />
    </div>
  );
}
