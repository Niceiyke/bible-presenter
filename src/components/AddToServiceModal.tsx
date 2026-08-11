import React from "react";
import { X, CalendarPlus } from "lucide-react";
import type { ServiceMeta } from "../types";

export function AddToServiceModal({
  open,
  services,
  activeServiceId,
  onSelect,
  onClose,
}: {
  open: boolean;
  services: ServiceMeta[];
  activeServiceId: string;
  onSelect: (serviceId: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        <header className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <CalendarPlus className="text-amber-500" size={18} />
            <h2 className="text-sm font-black uppercase tracking-widest text-white">Add to Service</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-all">
            <X size={20} />
          </button>
        </header>
        <p className="px-4 pt-3 pb-1 text-[10px] text-slate-500">
          Choose the service to add this item to.
        </p>
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar flex flex-col gap-1.5">
          {services.length === 0 && (
            <p className="text-slate-600 text-xs italic text-center py-8">No services yet. Create one in the Schedule tab.</p>
          )}
          {services.map((s) => {
            const isActive = s.id === activeServiceId;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`flex items-center gap-2 p-3 rounded-lg border text-left transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                  isActive
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-slate-800 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800"
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className={`block text-xs font-bold truncate ${isActive ? "text-amber-400" : "text-slate-200"}`}>{s.name}</span>
                  <span className="block text-[10px] text-slate-500 mt-0.5">
                    {s.item_count} item{s.item_count === 1 ? "" : "s"}{isActive ? " · currently active" : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
