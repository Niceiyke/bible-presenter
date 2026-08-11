import React, { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { Button, type ButtonVariant } from "./Button";
import { useFocusTrap } from "../../hooks/useFocusTrap";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  icon?: React.ReactNode;
  busy?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/** Shared confirmation modal. Lists impact, traps focus, stays custom (no browser prompts). */
export function ConfirmModal({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "primary",
  icon,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, open, onClose);

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
          aria-labelledby="confirm-modal-title"
        >
          <motion.div
            ref={panelRef}
            className="w-full max-w-md bg-console-surface border border-console-border-strong rounded-xl shadow-2xl overflow-hidden"
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 12 }}
            transition={{ duration: 0.18 }}
            role="document"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-console-border">
              <div className="w-9 h-9 rounded-full bg-console-surface-raised flex items-center justify-center shrink-0 text-console-text-muted">
                {icon ?? <AlertTriangle size={18} className="text-action-primary" />}
              </div>
              <h2 id="confirm-modal-title" className="text-sm font-black text-console-text uppercase tracking-wider">
                {title}
              </h2>
            </div>

            <div className="px-5 py-4">
              {description && <p className="text-xs text-console-text-muted mb-3">{description}</p>}
              {children}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-console-border bg-console-canvas/40">
              <Button variant="bare" onClick={onClose} disabled={busy || confirming}>
                {cancelLabel}
              </Button>
              <Button variant={confirmVariant} onClick={handleConfirm} loading={busy || confirming}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}