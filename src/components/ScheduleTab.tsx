import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Edit2, Trash2, Repeat, Zap, GripVertical, Undo2, Redo2, ListPlus, Play, X } from "lucide-react";
import { Reorder } from "framer-motion";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import { ScheduleTile } from "../items/registry";
import { Button, IconButton, ConfirmModal, SaveStatus, type SaveStatusState } from "./ui";
import type { DisplayItem, Schedule, ScheduleEntry, ServiceMeta } from "../types";

interface ScheduleTabProps {
  onSendItem: (item: DisplayItem, idx: number) => void;
  onPersist: () => void;
  stageItem: (item: DisplayItem) => void;
}

export function ScheduleTab({ onSendItem, onPersist, stageItem }: ScheduleTabProps) {
  const {
    scheduleEntries, setScheduleEntries,
    pushScheduleState, undoSchedule, redoSchedule,
    pastScheduleStates, futureScheduleStates,
    activeScheduleIdx, setActiveScheduleIdx,
    services, setServices,
    activeServiceId, setActiveServiceId,
    serviceManagerOpen, setServiceManagerOpen,
    newServiceName, setNewServiceName,
    isSchedulePersistent, setIsSchedulePersistent,
    saveState, setSaveState,
    setToast,
  } = useAppStore();

  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const saveTimerRef = useRef<number | null>(null);

  // Derive a readable save state for the SaveStatus pill.
  const derivedSave: SaveStatusState = (() => {
    switch (saveState) {
      case "dirty": return "unsaved";
      case "saving": return "saving";
      case "failed": return "failed";
      case "saved": return "saved";
      default: return "idle";
    }
  })();

  // Debounced persist so reorder/remove bursts only produce one backend save.
  const debouncedPersist = useCallback(() => {
    setSaveState("dirty");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        setSaveState("saving");
        await onPersist();
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1500);
      } catch {
        setSaveState("failed");
      }
    }, 400);
  }, [onPersist, setSaveState]);

  useEffect(() => () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); }, []);

  const sendAndMaybeRemove = (item: DisplayItem, idx: number, entryId: string) => {
    onSendItem(item, idx);
    if (!isSchedulePersistent) {
      const next = scheduleEntries.filter((e) => e.id !== entryId);
      pushScheduleState(next);
      setActiveScheduleIdx(null);
      debouncedPersist();
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
    pushScheduleState(next);
    if (activeScheduleIdx !== null && next.length <= activeScheduleIdx) setActiveScheduleIdx(null);
    debouncedPersist();
  };

  const handleReorder = (next: typeof scheduleEntries) => {
    setScheduleEntries(next);
  };

  const handleReorderEnd = () => {
    pushScheduleState(scheduleEntries);
    debouncedPersist();
  };

  const selectService = async (id: string) => {
    if (saveState === "dirty" || saveState === "saving") await onPersist();
    const loaded: Schedule = await invoke("load_service", { id });
    setScheduleEntries(loaded.items ?? []);
    setActiveServiceId(id);
    setActiveScheduleIdx(null);
    localStorage.setItem("activeServiceId", id);
  };

  const createService = async (name: string) => {
    if (!name.trim()) return;
    const id = stableId();
    const svc: Schedule = { id, name: name.trim(), items: [] };
    await invoke("save_service", { schedule: svc });
    const list = (await invoke("list_services")) as ServiceMeta[];
    setServices(list);
    setActiveServiceId(id);
    setScheduleEntries([]);
    setActiveScheduleIdx(null);
    localStorage.setItem("activeServiceId", id);
    setCreateValue("");
    setToast("Service created");
  };

  const renameService = async (id: string, name: string) => {
    if (!name.trim()) return;
    const loaded: Schedule = await invoke<Schedule>("load_service", { id: id }).catch(() => ({ id, name, items: [] } as Schedule));
    await invoke("save_service", { schedule: { ...loaded, name: name.trim() } });
    const list = (await invoke("list_services")) as ServiceMeta[];
    setServices(list);
    setToast("Service renamed");
  };

  const deleteService = async (id: string) => {
    await invoke("delete_service", { id });
    const list = (await invoke("list_services")) as ServiceMeta[];
    setServices(list);
    if (activeServiceId === id && list.length > 0) {
      setActiveServiceId(list[0].id);
      const loaded: Schedule = await invoke("load_service", { id: list[0].id });
      setScheduleEntries(loaded.items ?? []);
    }
    setToast("Service deleted");
  };

  const activeServiceName = services.find((s) => s.id === activeServiceId)?.name ?? "Service";

  return (
    <div className="flex flex-col gap-3">
      {/* Service selector + manager */}
      <div className="flex items-center gap-2">
        <select
          value={activeServiceId}
          onChange={(e) => selectService(e.target.value)}
          className="flex-1 bg-console-surface-raised text-console-text text-xs rounded border border-console-border px-2 py-2 font-bold focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.item_count})</option>
          ))}
        </select>
        <IconButton label="Manage services" onClick={() => setServiceManagerOpen(!serviceManagerOpen)}>
          <Settings size={13} />
        </IconButton>
      </div>

      {serviceManagerOpen && (
        <div className="bg-console-surface border border-console-border rounded-lg p-3 flex flex-col gap-2">
          <p className="text-[10px] font-black text-console-text-muted uppercase tracking-widest">Manage Services</p>
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className={`flex-1 text-xs truncate ${s.id === activeServiceId ? "text-action-primary font-bold" : "text-console-text"}`}>{s.name}</span>
              <IconButton
                label={`Rename ${s.name}`}
                size={11}
                className="h-7 w-7"
                onClick={() => { setRenameTarget({ id: s.id, name: s.name }); setRenameValue(s.name); }}
              >
                <Edit2 size={11} />
              </IconButton>
              <IconButton
                label={`Delete ${s.name}`}
                size={11}
                className="h-7 w-7"
                tone="live"
                disabled={s.id === activeServiceId || services.length <= 1}
                onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
              >
                <Trash2 size={11} />
              </IconButton>
            </div>
          ))}
          <hr className="border-console-border" />
          <div className="flex gap-2">
            <input
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              placeholder="New service name…"
              className="flex-1 bg-console-surface-raised text-console-text text-xs rounded border border-console-border px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              onKeyDown={(e) => { if (e.key === "Enter") createService(createValue); }}
            />
            <Button variant="primary" size="sm" icon={<ListPlus size={12} />} onClick={() => createService(createValue)}>New</Button>
          </div>
        </div>
      )}

      {/* Header: service status + save state + behavior */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-xs font-bold text-console-text-muted uppercase tracking-widest truncate" title={activeServiceName}>
            {activeServiceName}
          </h2>
          <span className="text-[9px] text-console-text-subtle font-mono">
            {scheduleEntries.length} item{scheduleEntries.length === 1 ? "" : "s"}
          </span>
          <SaveStatus state={derivedSave} />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsSchedulePersistent(!isSchedulePersistent)}
            title={isSchedulePersistent ? "Items stay after playing — keep for repeat services" : "Items are removed after playing"}
            className={`flex items-center gap-1 px-1.5 py-1 rounded text-[9px] font-bold border transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
              isSchedulePersistent
                ? "bg-state-stage-soft border-state-stage/50 text-state-stage hover:bg-state-stage/20"
                : "bg-action-primary/15 border-action-primary/40 text-action-primary hover:bg-action-primary/25"
            }`}
          >
            {isSchedulePersistent ? <Repeat size={9} /> : <Zap size={9} />}
            {isSchedulePersistent ? "Keep after playing" : "Remove after playing"}
          </button>

          <div className="h-3 w-px bg-console-border mx-1" />

          <IconButton label="Undo" size={11} className="h-7 w-7" disabled={pastScheduleStates.length === 0} onClick={undoSchedule}>
            <Undo2 size={12} />
          </IconButton>
          <IconButton label="Redo" size={11} className="h-7 w-7" disabled={futureScheduleStates.length === 0} onClick={redoSchedule}>
            <Redo2 size={12} />
          </IconButton>
        </div>
      </div>

      {/* Play next controls */}
      {scheduleEntries.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={activeScheduleIdx === 0 || scheduleEntries.length === 0}
            onClick={handlePrevItem}
          >
            ← Prev
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Play size={11} />}
            disabled={scheduleEntries.length === 0 || activeScheduleIdx === scheduleEntries.length - 1}
            onClick={handleNextItem}
          >
            Next
          </Button>
          {activeScheduleIdx !== null && (
            <span className="text-[9px] font-mono text-console-text-subtle ml-1">
              Playing: {activeScheduleIdx + 1} of {scheduleEntries.length}
            </span>
          )}
        </div>
      )}

      {scheduleEntries.length === 0 ? (
        <p className="text-console-text-subtle text-xs italic text-center pt-8">Schedule is empty. Add verses or media with + QUEUE.</p>
      ) : (
        <Reorder.Group axis="y" values={scheduleEntries} onReorder={handleReorder} className="flex flex-col gap-1.5">
          {scheduleEntries.map((entry, idx) => {
            const isActive = activeScheduleIdx === idx;
            return (
              <Reorder.Item
                key={entry.id}
                value={entry}
                onDragEnd={handleReorderEnd}
                className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all group cursor-default select-none focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                  isActive
                    ? "bg-state-stage-soft border-state-stage/50"
                    : "bg-console-surface-raised/40 border-console-border hover:bg-console-surface-raised hover:border-console-border-strong"
                }`}
              >
                <div className="cursor-grab active:cursor-grabbing p-1 -ml-1 text-console-text-subtle hover:text-console-text-muted transition-colors" aria-label="Reorder (drag)">
                  <GripVertical size={14} />
                </div>
                <div className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-black shrink-0 ${isActive ? "bg-state-stage text-slate-950" : "bg-console-surface-strong text-console-text-muted"}`}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => stageItem(entry.item)}>
                  <ScheduleTile item={entry.item} />
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Play size={10} />}
                    onClick={() => sendAndMaybeRemove(entry.item, idx, entry.id)}
                  >
                    Play Next
                  </Button>
                  <IconButton
                    label="Remove from schedule"
                    tone="live"
                    size={11}
                    className="h-8 w-8"
                    onClick={() => removeFromSchedule(entry.id)}
                  >
                    <X size={11} />
                  </IconButton>
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      )}

      {/* Rename service modal */}
      <ConfirmModal
        open={!!renameTarget}
        title="Rename service"
        confirmLabel="Rename"
        confirmVariant="primary"
        onConfirm={async () => {
          if (renameTarget) await renameService(renameTarget.id, renameValue);
        }}
        onClose={() => setRenameTarget(null)}
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { renameTarget && renameService(renameTarget.id, renameValue); setRenameTarget(null); } }}
          placeholder="Service name…"
          className="w-full bg-console-surface-raised text-console-text text-xs rounded border border-console-border px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        />
      </ConfirmModal>

      {/* Delete service modal */}
      <ConfirmModal
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description="The service and its saved items will be removed. This cannot be undone."
        confirmLabel="Delete Service"
        confirmVariant="live"
        onConfirm={async () => {
          if (deleteTarget) await deleteService(deleteTarget.id);
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}