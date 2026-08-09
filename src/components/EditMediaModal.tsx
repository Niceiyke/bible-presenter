import React from "react";
import { MediaItem } from "../types";
import { useAppStore } from "../store";

interface EditMediaModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaItem: MediaItem | null;
}

export function EditMediaModal({ isOpen, onClose, mediaItem }: EditMediaModalProps) {
  const { updateMediaItemMetadata } = useAppStore();
  const [description, setDescription] = React.useState(mediaItem?.description || "");
  const [tags, setTags] = React.useState(mediaItem?.tags.join(", ") || "");
  const [category, setCategory] = React.useState(mediaItem?.category || "");

  React.useEffect(() => {
    setDescription(mediaItem?.description || "");
    setTags(mediaItem?.tags.join(", ") || "");
    setCategory(mediaItem?.category || "");
  }, [mediaItem]);

  const handleSave = async () => {
    if (mediaItem) {
      await updateMediaItemMetadata(
        mediaItem.id,
        description.trim() === "" ? undefined : description,
        tags.split(",").map((s) => s.trim()).filter(Boolean),
        category.trim() === "" ? undefined : category
      );
      onClose();
    }
  };

  if (!isOpen || !mediaItem) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-white/[0.05] rounded-lg p-6 w-96">
        <h3 className="text-lg font-bold mb-4 text-white">Edit Media: {mediaItem.name}</h3>
        <div className="mb-4">
          <label htmlFor="description" className="block text-sm font-medium text-slate-400">Description</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 block w-full rounded-md bg-white/[0.12] border-transparent text-white focus:border-indigo-400/70 focus:ring-indigo-400/70 text-sm"
            rows={3}
          ></textarea>
        </div>
        <div className="mb-4">
          <label htmlFor="tags" className="block text-sm font-medium text-slate-400">Tags (comma-separated)</label>
          <input
            type="text"
            id="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="mt-1 block w-full rounded-md bg-white/[0.12] border-transparent text-white focus:border-indigo-400/70 focus:ring-indigo-400/70 text-sm"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="category" className="block text-sm font-medium text-slate-400">Category</label>
          <input
            type="text"
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 block w-full rounded-md bg-white/[0.12] border-transparent text-white focus:border-indigo-400/70 focus:ring-indigo-400/70 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-300 rounded-md border border-white/[0.08] hover:bg-white/[0.1]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium text-black bg-amber-500 rounded-md hover:bg-amber-600"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}