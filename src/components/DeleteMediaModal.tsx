import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { MediaItem } from "../types";

interface DeleteMediaModalProps {
  item: MediaItem | null;
  /** Called after a successful remove/delete. `removeFile` true = file also deleted. */
  onDelete: (id: string, removeFile: boolean) => Promise<void>;
  onClose: () => void;
}

/** Media deletion safety modal. Shows where a media item is still referenced
 *  (services, presentations, scenes) and lets the operator choose between
 *  removing it from the library while keeping the file, or deleting both. */
export function DeleteMediaModal({ item, onDelete, onClose }: DeleteMediaModalProps) {
  const [references, setReferences] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, !!item, onClose);

  useEffect(() => {
    if (!item) return;
    setChecking(true);
    setReferences([]);
    invoke<string[]>("get_media_references", { id: item.id })
      .then(setReferences)
      .catch(() => setReferences([]))
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const run = async (removeFile: boolean) => {
    if (!item) return;
    setBusy(true);
    try {
      await onDelete(item.id, removeFile);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-media-title"
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
              <div className="w-9 h-9 rounded-full bg-state-live-soft flex items-center justify-center shrink-0">
                <AlertTriangle size={18} className="text-state-live" />
              </div>
              <div className="min-w-0">
                <h2 id="delete-media-title" className="text-sm font-black text-console-text uppercase tracking-wider truncate">
                  Delete "{item.name}"
                </h2>
              </div>
            </div>

            <div className="px-5 py-4 flex flex-col gap-3">
              {checking ? (
                <p className="text-xs text-console-text-subtle animate-pulse">Checking references…</p>
              ) : references.length > 0 ? (
                <>
                  <p className="text-xs font-bold text-state-warning uppercase tracking-wider">
                    Still used in {references.length} place{references.length === 1 ? "" : "s"}
                  </p>
                  <ul className="list-disc pl-5 text-[11px] text-console-text-muted flex flex-col gap-0.5 max-h-28 overflow-y-auto custom-scrollbar">
                    {references.slice(0, 8).map((r, i) => <li key={i} className="truncate">{r}</li>)}
                    {references.length > 8 && <li className="text-console-text-subtle">+{references.length - 8} more</li>}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-console-text-subtle">Not used by any service, presentation, or scene.</p>
              )}

              <div className="flex flex-col gap-2 mt-1">
                <Button
                  variant="warning"
                  size="md"
                  onClick={() => run(false)}
                  loading={busy}
                  className="w-full"
                >
                  Remove from Library (keep file)
                </Button>
                <Button
                  variant="live"
                  size="md"
                  onClick={() => run(true)}
                  loading={busy}
                  icon={<Trash2 size={13} />}
                  className="w-full"
                >
                  Delete File, too
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-end px-5 py-3 border-t border-console-border bg-console-canvas/40">
              <Button variant="bare" onClick={onClose} disabled={busy}>Cancel</Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}