/**
 * EditorSaveStatus — explicit save-state indicator for the slide editor
 * top bar (SLIDE_EDITOR_MODERNIZATION_PLAN §7.1). The state is shown as
 * text plus an icon so it is never communicated by color alone.
 */

import React from "react";
import { Check, CloudUpload, RefreshCw, TriangleAlert } from "lucide-react";
import type { EditorSaveState } from "./useAutoSave";

export function EditorSaveStatus({
  state,
  onRetry,
}: {
  state: EditorSaveState;
  onRetry: () => void;
}) {
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-state-success shrink-0" role="status" aria-label="Saved">
        <Check size={13} /> Saved
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-state-stage shrink-0" role="status" aria-label="Saving">
        <CloudUpload size={13} className="animate-pulse" /> Saving…
      </span>
    );
  }
  if (state === "save-failed") {
    return (
      <span className="flex items-center gap-2 text-[11px] font-bold text-state-live shrink-0" role="status" aria-label="Save failed">
        <TriangleAlert size={13} /> Save failed
        <button
          onClick={onRetry}
          className="flex items-center gap-1 px-2 py-1 rounded-md bg-state-live/15 hover:bg-state-live/25 text-state-live text-[10px] font-bold transition-all"
          title="Retry save"
          aria-label="Retry save"
        >
          <RefreshCw size={11} /> Retry
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-bold text-state-warning shrink-0" role="status" aria-label="Unsaved changes">
      <span className="w-2 h-2 rounded-full bg-state-warning shrink-0" /> Unsaved changes
    </span>
  );
}
