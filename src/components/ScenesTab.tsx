import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Layout, Play, Zap, Plus, Trash2, Edit2 } from "lucide-react";
import { useAppStore } from "../store";
import type { SceneData, DisplayItem } from "../types";

interface ScenesTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
  onAddToSchedule?: (item: DisplayItem) => void;
  onEditScene?: (scene: SceneData) => void;
}

export function ScenesTab({ onStage, onLive, onAddToSchedule, onEditScene }: ScenesTabProps) {
  const {
    savedScenes, setSavedScenes,
    workingScene, setWorkingScene,
    setActiveTab
  } = useAppStore();

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this scene?")) return;
    try {
      await invoke("delete_scene", { id });
      const next = savedScenes.filter((s) => s.id !== id);
      setSavedScenes(next);
      emit("scenes-sync", next);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Saved Scenes</h2>
        <button
          onClick={() => {
            // Switch to Scene Builder and reset working scene
            setWorkingScene({ id: crypto.randomUUID(), name: "New Scene", layers: [] });
            setActiveTab("scene-builder");
          }}
          className="text-[10px] bg-blue-600 hover:bg-blue-500 text-white font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1.5"
        >
          <Plus size={11} /> CREATE
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {savedScenes.map((scene) => (
          <div key={scene.id} className="flex flex-col bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden group">
            <div className="flex items-center gap-2 p-3">
              <div className="w-8 h-8 bg-blue-900/30 rounded flex items-center justify-center text-blue-400 font-bold text-xs shrink-0">
                SC
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-200 truncate">{scene.name}</p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{scene.layers.length} layers</p>
              </div>
              <div className="flex gap-1">
                {onStage && (
                  <button
                    onClick={() => onStage({ type: "Scene", data: scene })}
                    className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded transition-all"
                    title="Stage Scene"
                  >
                    <Play size={14} fill="currentColor" />
                  </button>
                )}
                {onLive && (
                  <button
                    onClick={() => onLive({ type: "Scene", data: scene })}
                    className="p-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded transition-all"
                    title="Go Live Now"
                  >
                    <Zap size={14} fill="currentColor" />
                  </button>
                )}
                {onAddToSchedule && (
                  <button
                    onClick={() => onAddToSchedule({ type: "Scene", data: scene })}
                    className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-500 rounded transition-all"
                    title="Add to Schedule"
                  >
                    <Plus size={14} />
                  </button>
                )}
                <button
                  onClick={() => {
                    setWorkingScene(scene);
                    setActiveTab("scene-builder");
                  }}
                  className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-blue-400 rounded transition-all"
                  title="Edit Scene"
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => handleDelete(scene.id)}
                  className="p-1.5 bg-slate-800 hover:bg-red-900 text-slate-400 hover:text-red-400 rounded transition-all"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}

        {savedScenes.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-slate-700">
            <Layout size={32} className="mb-2 opacity-20" />
            <p className="text-xs italic text-center">
              No saved scenes yet. Go to Scene Builder to create one.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
