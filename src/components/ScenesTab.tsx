import React, { useState } from "react";
import { Camera, Check, Plus, Trash2, Zap } from "lucide-react";
import { useAppStore } from "../store";
import { useT } from "../i18n";
import type { Scene } from "../types";

interface ScenesTabProps {
  saveScene: (scene: Scene) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  applyScene: (id: string) => Promise<void>;
  captureScene: (name: string) => Promise<void>;
}

export function ScenesTab({ saveScene, deleteScene, applyScene, captureScene }: ScenesTabProps) {
  const { scenes, settings } = useAppStore();
  const t = useT();
  const [newName, setNewName] = useState("");

  const handleCapture = async () => {
    const name = newName.trim() || `Scene ${scenes.length + 1}`;
    await captureScene(name);
    setNewName("");
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-1">{t("scenes.title")}</h2>
        <p className="text-xs text-slate-500 mb-4">
          {t("scenes.subtitle")}
        </p>

        <div className="flex items-center gap-2 mb-4">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCapture(); }}
            placeholder={t("scenes.namePlaceholder")}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
          />
          <button
            onClick={handleCapture}
            className="px-3 py-2 rounded-md bg-amber-500 hover:bg-amber-400 text-black text-xs font-black uppercase flex items-center gap-1.5 transition-all"
          >
            <Camera size={13} /> {t("scenes.captureCurrent")}
          </button>
        </div>

        {scenes.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-slate-800 rounded-lg">
            <Zap size={24} className="text-slate-700 mx-auto mb-2" />
            <p className="text-slate-600 text-sm">{t("scenes.empty")}</p>
            <p className="text-slate-700 text-xs mt-1">{t("scenes.emptyHint")}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {scenes.map((s) => (
              <div key={s.id} className="group flex items-center gap-3 px-3 py-2.5 rounded-lg bg-slate-950/60 border border-slate-800/60 hover:border-slate-700 transition-all">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-200 truncate">{s.name}</p>
                  <p className="text-[10px] text-slate-600 uppercase font-black">
                    {s.props.length} prop{s.props.length !== 1 ? "s" : ""}
                    {s.lower_third_data ? " · LT" : ""}
                    {" · theme: "}{settings.theme === s.settings.theme ? "same" : s.settings.theme}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => applyScene(s.id)}
                    className="px-2.5 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase flex items-center gap-1 transition-all"
                    title={t("scenes.apply")}
                  >
                    <Check size={12} /> {t("scenes.apply")}
                  </button>
                  <button
                    onClick={() => deleteScene(s.id)}
                    className="p-1.5 rounded-md bg-slate-800 hover:bg-red-900/40 text-slate-500 hover:text-red-300 transition-all"
                    title={t("scenes.delete")}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
