import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Image, Clock, Eye, EyeOff, X } from "lucide-react";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import type { PropItem } from "../types";

interface PropsTabProps {
  onUpdateProps: (items: PropItem[]) => void;
}

export function PropsTab({ onUpdateProps }: PropsTabProps) {
  const { propItems, setPropItems } = useAppStore();

  const updateAndSave = async (next: PropItem[]) => {
    setPropItems(next);
    onUpdateProps(next);
    await invoke("set_props", { props: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Persistent Props</h2>
        <div className="flex gap-1">
          <button
            onClick={async () => {
              const selected = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
              if (typeof selected !== "string") return;
              const newProp: PropItem = { id: stableId(), kind: "image", path: selected, x: 2, y: 2, w: 20, h: 15, opacity: 1, visible: true };
              await updateAndSave([...propItems, newProp]);
            }}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-all flex items-center gap-1"
          >
            <Image size={10} /> Image
          </button>
          <button
            onClick={async () => {
              const newProp: PropItem = { id: stableId(), kind: "clock", text: "HH:mm:ss", color: "#ffffff", x: 35, y: 2, w: 30, h: 10, opacity: 1, visible: true };
              await updateAndSave([...propItems, newProp]);
            }}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-all flex items-center gap-1"
          >
            <Clock size={10} /> Clock
          </button>
          {propItems.length > 0 && (
            <button
              onClick={async () => {
                if (!window.confirm("Remove all props?")) return;
                await updateAndSave([]);
              }}
              className="px-2 py-1 bg-red-900/50 hover:bg-red-800 text-red-400 text-xs rounded border border-red-900 transition-all"
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {propItems.length === 0 ? (
        <p className="text-slate-700 text-xs italic text-center pt-8">No props. Add an image logo or clock overlay above.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {propItems.map((prop) => (
            <div key={prop.id} className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shrink-0">
                  {prop.kind === "image" ? <Image size={14} className="text-slate-500" /> : <Clock size={14} className="text-slate-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-300 truncate">
                    {prop.kind === "clock" ? (prop.text ?? "HH:mm:ss") : (prop.path?.split("/").pop() ?? prop.path?.split("\\").pop() ?? "Image")}
                  </p>
                  <p className="text-[10px] text-slate-600 uppercase">{prop.kind}</p>
                </div>
                <button
                  onClick={async () => {
                    await updateAndSave(propItems.map((p) => p.id === prop.id ? { ...p, visible: !p.visible } : p));
                  }}
                  className={`p-1.5 rounded transition-all ${prop.visible ? "text-amber-500 bg-amber-500/10" : "text-slate-600 bg-slate-800"}`}
                >
                  {prop.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  onClick={async () => {
                    await updateAndSave(propItems.filter((p) => p.id !== prop.id));
                  }}
                  className="p-1.5 text-red-700 hover:text-red-400 bg-slate-800 rounded transition-all"
                >
                  <X size={12} />
                </button>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-600 uppercase font-bold w-12">Position</span>
                {[
                  { label: "TL", x: 1, y: 1 },
                  { label: "TR", x: 79, y: 1 },
                  { label: "BL", x: 1, y: 83 },
                  { label: "BR", x: 79, y: 83 },
                  { label: "TC", x: 35, y: 1 },
                ].map(({ label, x, y }) => (
                  <button
                    key={label}
                    onClick={async () => {
                      await updateAndSave(propItems.map((p) => p.id === prop.id ? { ...p, x, y } : p));
                    }}
                    className="px-1.5 py-0.5 text-[9px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-400 rounded border border-slate-700"
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 uppercase font-bold w-12">Opacity</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={prop.opacity}
                  onChange={async (e) => {
                    await updateAndSave(propItems.map((p) => p.id === prop.id ? { ...p, opacity: parseFloat(e.target.value) } : p));
                  }}
                  className="flex-1 accent-amber-500"
                />
                <span className="text-[10px] text-slate-500 w-8 text-right">{Math.round(prop.opacity * 100)}%</span>
              </div>

              {prop.kind === "clock" && (
                <div className="flex gap-2">
                  <input
                    value={prop.text ?? "HH:mm:ss"}
                    onChange={async (e) => {
                      await updateAndSave(propItems.map((p) => p.id === prop.id ? { ...p, text: e.target.value } : p));
                    }}
                    className="flex-1 bg-slate-900 text-slate-300 text-xs rounded border border-slate-700 px-2 py-1"
                    placeholder="HH:mm:ss"
                  />
                  <input
                    type="color"
                    value={prop.color ?? "#ffffff"}
                    onChange={async (e) => {
                      await updateAndSave(propItems.map((p) => p.id === prop.id ? { ...p, color: e.target.value } : p));
                    }}
                    className="w-8 h-8 rounded border border-slate-700 bg-transparent cursor-pointer"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
