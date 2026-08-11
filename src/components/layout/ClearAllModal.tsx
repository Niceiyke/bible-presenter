import React, { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Undo2, X, Monitor, Clock, Layers, Captions } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel } from "../../utils";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button, IconButton } from "../ui";

interface ClearAllModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function ClearAllModal({ open, onClose, onConfirm }: ClearAllModalProps) {
  const {
    liveItem, stagedItem, currentLowerThird, ltVisible,
    propItems, busyActions,
  } = useAppStore();
  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const clearing = busyActions.includes("clear");

  useFocusTrap(panelRef, open, onClose);

  const layers = [
    {
      icon: Monitor,
      label: "Live content",
      detail: liveItem ? displayItemLabel(liveItem) : "Nothing live",
      active: !!liveItem,
    },
    {
      icon: Clock,
      label: "Staged content",
      detail: stagedItem ? displayItemLabel(stagedItem) : "Nothing staged",
      active: !!stagedItem,
    },
    {
      icon: Captions,
      label: "Lower third",
      detail: ltVisible && currentLowerThird ? "Currently visible" : "Hidden",
      active: !!ltVisible,
    },
    {
      icon: Layers,
      label: "Props overlays",
      detail: propItems.length > 0 ? `${propItems.length} active prop${propItems.length !== 1 ? "s" : ""}` : "No props",
      active: propItems.length > 0,
    },
  ];
  const anyActive = layers.some((l) => l.active);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setConfirming(false);
    }
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
          aria-labelledby="clear-all-title"
        >
          <motion.div
            ref={panelRef}
            className="w-full max-w-md bg-console-surface border border-state-live/40 rounded-xl shadow-2xl overflow-hidden"
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 12 }}
            transition={{ duration: 0.18 }}
            role="document"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-console-border bg-state-live-soft/40">
              <div className="w-9 h-9 rounded-full bg-state-live/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={18} className="text-state-live" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="clear-all-title" className="text-sm font-black text-state-live uppercase tracking-wider">
                  Clear All Output
                </h2>
                <p className="text-xs text-console-text-muted mt-0.5">
                  This affects everything the audience can currently see.
                </p>
              </div>
              <IconButton label="Close" onClick={onClose} disabled={confirming}>
                <X size={16} />
              </IconButton>
            </div>

            <div className="px-5 py-4 space-y-1.5">
              {layers.map((l) => {
                const Icon = l.icon;
                return (
                  <div
                    key={l.label}
                    className={`flex items-center gap-3 py-2 px-3 rounded-lg border ${
                      l.active ? "bg-state-live/10 border-state-live/40" : "bg-console-canvas/40 border-console-border/50 opacity-70"
                    }`}
                  >
                    <Icon size={15} className={l.active ? "text-state-live" : "text-console-text-subtle"} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-bold ${l.active ? "text-console-text" : "text-console-text-muted"}`}>{l.label}</p>
                      <p className="text-[10px] text-console-text-subtle truncate">{l.detail}</p>
                    </div>
                    <span className={`text-[9px] font-black uppercase ${l.active ? "text-state-live" : "text-console-text-subtle"}`}>
                      {l.active ? "Clearing" : "Untouched"}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-console-border bg-console-canvas/40">
              <p className="text-[10px] text-console-text-subtle flex items-center gap-1.5">
                <Undo2 size={12} /> Undo available right after clearing
              </p>
              <div className="flex items-center gap-2">
                <Button variant="bare" onClick={onClose} disabled={confirming} size="sm">
                  Cancel
                </Button>
                <Button
                  variant="live"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!anyActive || confirming || clearing}
                  loading={confirming || clearing}
                >
                  {confirming || clearing ? "Clearing…" : "Clear All"}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}