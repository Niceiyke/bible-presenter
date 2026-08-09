import React, { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { displayItemLabel } from "../utils";
import { useT } from "../i18n";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { ScheduleEntry } from "../types";

interface RecoveryModalProps {
  recovery: { activeServiceId: string; scheduleEntries: ScheduleEntry[]; lastUpdate: number };
  onRestore: () => void;
  onDiscard: () => void;
}

export function RecoveryModal({ recovery, onRestore, onDiscard }: RecoveryModalProps) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const timeStr = new Date(recovery.lastUpdate).toLocaleString();
  const count = recovery.scheduleEntries.length;

  const dismiss = (fn: () => void) => {
    setOpen(false);
    setTimeout(fn, 180);
  };

  // Trap focus + close on Esc.
  useFocusTrap(panelRef, open, () => dismiss(onDiscard));

  const close = (fn: () => void) => {
    setOpen(false);
    setTimeout(fn, 180);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="recovery-title"
        >
          <motion.div
            ref={panelRef}
            className="w-full max-w-lg bg-slate-900/95 backdrop-blur-xl border border-amber-500/30 rounded-2xl shadow-float overflow-hidden"
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 12 }}
            transition={{ duration: 0.18 }}
            role="document"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] bg-gradient-to-r from-amber-950/40 to-transparent">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-500/25 to-amber-600/10 flex items-center justify-center shrink-0 ring-1 ring-amber-500/30">
                <AlertTriangle size={18} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="recovery-title" className="text-sm font-black text-amber-200 uppercase tracking-wider">
                  {t("recovery.title")}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {count} item{count !== 1 ? "s" : ""} from <span className="text-amber-300/80">{timeStr}</span>
                </p>
              </div>
            </div>

            <div className="px-5 py-4 max-h-64 overflow-y-auto custom-scrollbar">
              <p className="text-[10px] uppercase font-black text-slate-500 mb-2">{t("recovery.preview")}</p>
              <ol className="space-y-1">
                {recovery.scheduleEntries.map((e, i) => (
                  <li key={e.id} className="flex items-center gap-3 text-sm py-1.5 px-2 rounded bg-black/40 border border-white/[0.06]">
                    <span className="text-[10px] font-black text-slate-600 w-5 text-right shrink-0">{i + 1}</span>
                    <span className="text-slate-200 font-medium truncate flex-1">{displayItemLabel(e.item)}</span>
                    <span className="text-[9px] uppercase font-black text-slate-600 shrink-0">{e.item.type}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06] bg-black/20">
              <button
                onClick={() => dismiss(onDiscard)}
                aria-label={t("recovery.discard")}
                className="px-3 py-2 text-xs font-black uppercase rounded-md text-slate-400 hover:text-red-300 hover:bg-red-900/20 flex items-center gap-1.5 transition-all active:scale-95"
              >
                <Trash2 size={13} /> {t("recovery.discard")}
              </button>
              <button
                onClick={() => dismiss(onRestore)}
                aria-label={t("recovery.restore")}
                className="px-4 py-2 text-xs font-black uppercase rounded-md bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black flex items-center gap-1.5 transition-all shadow-lg shadow-amber-500/25 active:scale-95"
              >
                <RotateCcw size={13} /> {t("recovery.restore")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
