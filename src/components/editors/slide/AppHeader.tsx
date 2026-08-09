/**
 * AppHeader — the top status/command bar of the slide editor (P1.4).
 */

import React from "react";
import { Save, X, Undo2, Redo2, Upload, Download } from "lucide-react";

export interface AppHeaderProps {
  name: string;
  onNameChange: (value: string) => void;
  isDirty: boolean;
  slideIndex: number;
  slideCount: number;
  onClose: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onImport: () => void;
  onExport: () => void;
  onSaveAndClose: () => void;
}

export function AppHeader({
  name,
  onNameChange,
  isDirty,
  slideIndex,
  slideCount,
  onClose,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onImport,
  onExport,
  onSaveAndClose,
}: AppHeaderProps) {
  return (
    <header className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] bg-slate-900/70 backdrop-blur-xl shrink-0">
      <button onClick={onClose} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Close editor">
        <X size={18} />
      </button>
      <div className="h-5 w-px bg-white/10" />
      {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" title="Unsaved changes" />}
      <input
        value={name}
        onChange={e => onNameChange(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        className="bg-transparent text-sm font-semibold text-white focus:outline-none min-w-0 flex-1"
        placeholder="Untitled Presentation"
      />
      <span className="text-[10px] font-bold text-slate-500 tabular-nums whitespace-nowrap bg-white/6 px-2 py-1 rounded">
        {slideIndex + 1} / {slideCount}
      </span>
      <div className="h-5 w-px bg-white/10" />
      <div className="flex bg-white/6 rounded-lg p-0.5 gap-0.5">
        <button onClick={onUndo} disabled={!canUndo} className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Undo (Ctrl+Z)">
          <Undo2 size={15} />
        </button>
        <button onClick={onRedo} disabled={!canRedo} className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded disabled:opacity-20 transition-all" title="Redo (Ctrl+Y)">
          <Redo2 size={15} />
        </button>
      </div>
      <div className="h-5 w-px bg-white/10" />
      <button onClick={onImport} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Import presentation">
        <Upload size={13} />
      </button>
      <button onClick={onExport} className="p-1.5 hover:bg-white/8 rounded-lg text-slate-500 hover:text-white transition-all" title="Export presentation">
        <Download size={13} />
      </button>
      <div className="h-5 w-px bg-white/10" />
      <button onClick={onSaveAndClose} className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black font-black uppercase text-[11px] rounded-lg transition-all shadow-lg shadow-amber-500/25 active:scale-95 tracking-wide">
        <Save size={14} /> Save & Close
      </button>
    </header>
  );
}