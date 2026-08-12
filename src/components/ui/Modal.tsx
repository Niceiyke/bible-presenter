import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { cn } from "./cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Sticky header content rendered to the right of the title (e.g. save state). */
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  /** Optional max-height class so long bodies scroll inside the modal. */
  maxHeightClass?: string;
  children: React.ReactNode;
}

/** Shared operator modal: trap focus, close on Escape, keyboard accessible.
 *  Replaces raw `fixed inset-0` overlays so song/preview/editor modals satisfy
 *  the Phase 3 modal accessibility requirement. */
export function Modal({
  open,
  onClose,
  title,
  headerRight,
  footer,
  maxWidth = "max-w-lg",
  maxHeightClass = "max-h-[90vh]",
  children,
}: ModalProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(panelRef, open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            ref={panelRef}
            className={cn(
              "w-full flex flex-col bg-console-surface border border-console-border-strong rounded-2xl shadow-2xl overflow-hidden",
              maxWidth,
              maxHeightClass,
            )}
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 12 }}
            transition={{ duration: 0.18 }}
            role="document"
          >
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-console-border shrink-0">
              <h2 id={titleId} className="text-sm font-black text-console-text truncate">
                {title}
              </h2>
              <div className="flex items-center gap-2 shrink-0">
                {headerRight}
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="w-8 h-8 inline-flex items-center justify-center rounded-md text-console-text-muted hover:text-console-text hover:bg-console-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">{children}</div>
            {footer && (
              <div className="shrink-0 px-4 py-3 border-t border-console-border bg-console-canvas/40 flex items-center justify-end gap-2">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}