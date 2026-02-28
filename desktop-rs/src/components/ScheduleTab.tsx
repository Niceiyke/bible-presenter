import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Edit2, Trash2, Repeat, Zap } from "lucide-react";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import type { DisplayItem, MediaItem, Schedule } from "../types";

interface ScheduleTabProps {
  onSendItem: (item: DisplayItem, idx: number) => void;
  onPersist: () => void;
}

export function ScheduleTab({ onSendItem, onPersist }: ScheduleTabProps) {
  const {
    scheduleEntries, setScheduleEntries,
    activeScheduleIdx, setActiveScheduleIdx,
    services, setServices,
    activeServiceId, setActiveServiceId,
    serviceManagerOpen, setServiceManagerOpen,
    newServiceName, setNewServiceName,
    isSchedulePersistent, setIsSchedulePersistent,
  } = useAppStore();

  const sendAndMaybeRemove = (item: DisplayItem, idx: number, entryId: string) => {
    onSendItem(item, idx);
    if (!isSchedulePersistent) {
      const next = scheduleEntries.filter((e) => e.id !== entryId);
      setScheduleEntries(next);
      setActiveScheduleIdx(null);
      onPersist();
    } else {
      setActiveScheduleIdx(idx);
    }
  };

  const handlePrevItem = async () => {
    if (activeScheduleIdx === null || activeScheduleIdx <= 0) return;
    const idx = activeScheduleIdx - 1;
    const entry = scheduleEntries[idx];
    sendAndMaybeRemove(entry.item, idx, entry.id);
  };

  const handleNextItem = async () => {
    const next = activeScheduleIdx === null ? 0 : activeScheduleIdx + 1;
    if (next >= scheduleEntries.length) return;
    const entry = scheduleEntries[next];
    sendAndMaybeRemove(entry.item, next, entry.id);
  };

  const removeFromSchedule = async (id: string) => {
    const next = scheduleEntries.filter((e) => e.id !== id);
    setScheduleEntries(next);
    onPersist();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select
          value={activeServiceId}
          onChange={async (e) => {
            const id = e.target.value;
            onPersist();
            const loaded: Schedule = await invoke("load_service", { id });
            setScheduleEntries(loaded.items ?? []);
            setActiveServiceId(id);
            localStorage.setItem("activeServiceId", id);
          }}
          className="flex-1 bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1.5 font-bold"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.item_count})</option>
          ))}
        </select>
        <button
          onClick={() => setServiceManagerOpen(!serviceManagerOpen)}
          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded border border-slate-700 transition-all"
        >
          <Settings size={12} />
        </button>
      </div>

      {serviceManagerOpen && (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 flex flex-col gap-2">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Manage Services</p>
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className={`flex-1 text-xs truncate ${s.id === activeServiceId ? "text-amber-400 font-bold" : "text-slate-300"}`}>{s.name}</span>
              <button
                onClick={async () => {
                  const newName = window.prompt("Rename service:", s.name);
                  if (!newName || newName === s.name) return;
                  const loaded: Schedule = await invoke<Schedule>("load_service", { id: s.id }).catch(() => ({ id: s.id, name: s.name, items: [] } as Schedule));
                  await invoke("save_service", { schedule: { ...loaded, name: newName } });
                  const list = await invoke("list_services");
                  setServices(list as any);
                }}
                className="text-slate-500 hover:text-slate-200 p-1 rounded"
              >
                <Edit2 size={10} />
              </button>
              <button
                disabled={s.id === activeServiceId || services.length <= 1}
                onClick={async () => {
                  if (!window.confirm(`Delete service "${s.name}"?`)) return;
                  await invoke("delete_service", { id: s.id });
                  const list = await invoke("list_services");
                  setServices(list as any);
                }}
                className="text-red-700 hover:text-red-400 p-1 rounded disabled:opacity-30"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
          <hr className="border-slate-700" />
          <div className="flex gap-2">
            <input
              value={newServiceName}
              onChange={(e) => setNewServiceName(e.target.value)}
              placeholder="New service name…"
              className="flex-1 bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1"
              onKeyDown={async (e) => {
                if (e.key !== "Enter" || !newServiceName.trim()) return;
                const id = stableId();
                const svc: Schedule = { id, name: newServiceName.trim(), items: [] };
                await invoke("save_service", { schedule: svc });
                const list = await invoke("list_services");
                setServices(list as any);
                setActiveServiceId(id);
                setScheduleEntries([]);
                localStorage.setItem("activeServiceId", id);
                setNewServiceName("");
              }}
            />
            <button
              onClick={async () => {
                if (!newServiceName.trim()) return;
                const id = stableId();
                const svc: Schedule = { id, name: newServiceName.trim(), items: [] };
                await invoke("save_service", { schedule: svc });
                const list = await invoke("list_services");
                setServices(list as any);
                setActiveServiceId(id);
                setScheduleEntries([]);
                localStorage.setItem("activeServiceId", id);
                setNewServiceName("");
              }}
              className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded"
            >
              + New
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Items</h2>
          <button
            onClick={() => setIsSchedulePersistent(!isSchedulePersistent)}
            title={isSchedulePersistent ? "Persistent: items stay after play" : "One-shot: items removed after play"}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border transition-all ${
              isSchedulePersistent
                ? "bg-emerald-900/40 border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/60"
                : "bg-amber-900/40 border-amber-700/50 text-amber-400 hover:bg-amber-900/60"
            }`}
          >
            {isSchedulePersistent ? <Repeat size={9} /> : <Zap size={9} />}
            {isSchedulePersistent ? "LOOP" : "ONCE"}
          </button>
        </div>
        {scheduleEntries.length > 0 && (
          <div className="flex gap-1">
            <button
              onClick={handlePrevItem}
              disabled={activeScheduleIdx === 0 || scheduleEntries.length === 0}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
            >
              ← Prev
            </button>
            <button
              onClick={handleNextItem}
              disabled={scheduleEntries.length === 0 || activeScheduleIdx === scheduleEntries.length - 1}
              className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded disabled:opacity-30 transition-all"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {scheduleEntries.length === 0 ? (
        <p className="text-slate-700 text-xs italic text-center pt-8">Schedule is empty. Add verses or media with + QUEUE.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {scheduleEntries.map((entry, idx) => {
            const isActive = activeScheduleIdx === idx;
            return (
              <div
                key={entry.id}
                className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all group ${
                  isActive
                    ? "bg-amber-500/10 border-amber-500/40"
                    : "bg-slate-800/40 border-slate-700/40 hover:bg-slate-800 hover:border-slate-700"
                }`}
              >
                <div className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-black shrink-0 ${isActive ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-400"}`}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  {entry.item.type === "Verse" ? (
                    <>
                      <p className="text-amber-500 text-[10px] font-bold uppercase truncate">{entry.item.data.book} {entry.item.data.chapter}:{entry.item.data.verse}</p>
                      <p className="text-slate-400 text-[10px] truncate">{entry.item.data.text}</p>
                    </>
                  ) : entry.item.type === "PresentationSlide" ? (
                    <p className="text-orange-400 text-[10px] font-bold uppercase truncate">
                      PPTX: {entry.item.data.presentation_name} — Slide {entry.item.data.slide_index + 1}
                    </p>
                  ) : entry.item.type === "CustomSlide" ? (
                    <p className="text-purple-400 text-[10px] font-bold uppercase truncate">
                      STUDIO: {entry.item.data.presentation_name} — Slide {entry.item.data.slide_index + 1}
                    </p>
                  ) : entry.item.type === "CameraFeed" ? (
                    <p className="text-teal-400 text-[10px] font-bold uppercase truncate">CAM: {entry.item.data.label || entry.item.data.device_id.slice(0, 12)}</p>
                  ) : entry.item.type === "Scene" ? (
                    <p className="text-blue-500 text-[10px] font-black uppercase truncate italic">SCENE: {entry.item.data.name}</p>
                  ) : entry.item.type === "Timer" ? (
                    <p className="text-cyan-400 text-[10px] font-bold uppercase truncate">TIMER: {entry.item.data.timer_type}{entry.item.data.label ? ` · ${entry.item.data.label}` : ""}</p>
                  ) : entry.item.type === "Song" ? (
                    <p className="text-pink-400 text-[10px] font-bold uppercase truncate">SONG: {entry.item.data.title} ({entry.item.data.section_label})</p>
                  ) : (
                    <p className="text-blue-400 text-[10px] font-bold uppercase truncate">{(entry.item.data as MediaItem).media_type}: {(entry.item.data as MediaItem).name}</p>
                  )}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                  <button onClick={() => sendAndMaybeRemove(entry.item, idx, entry.id)} className="p-1 bg-amber-500 hover:bg-amber-400 text-black rounded text-[10px] font-bold">▶</button>
                  <button onClick={() => removeFromSchedule(entry.id)} className="p-1 bg-red-900/50 text-red-400 rounded hover:bg-red-900 hover:text-white">✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
