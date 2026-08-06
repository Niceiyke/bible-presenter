/**
 * `useAutoSave`
 *
 * Debounced autosave for the active presentation. Commits `pres` to the
 * backend `save_studio_presentation` Tauri command after `delayMs`
 * since the last local change, with a guard so overlapping saves wait
 * for the in-flight one to finish before retrying.
 *
 * Behaviour mirrors the inline autosave the SlideEditor previously
 * owned (`autoSaveTimerRef` + `savePendingRef`), with two differences:
 *
 *   - It no longer touches `isDirtyRef` directly. The caller owns the
 *     "dirty" signal (a ref, in practice) and passes it in; the hook
 *     will save only when `dirtyRef.current` is true. This decouples
 *     the hook from any specific dirty-tracking representation.
 *
 *   - The hook accepts a `savingRef` so the host can synchronously
 *     inspect "is a save currently in-flight?" for the editor's
 *     close-button confirmation flow without coupling to internal
 *     state.
 */

import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CustomPresentation } from "../../../types";

interface UseAutoSaveArgs {
  pres: CustomPresentation;
  dirtyRef: RefObject<boolean>;
  savingRef: RefObject<boolean>;
  /** Called after a successful autosave so the host can clear is-dirty UI. */
  onSaveOK?: () => void;
  /** Called when autosave fails. Host may surface a toast. */
  onSaveError?: (err: unknown) => void;
  delayMs?: number;
}

export function useAutoSave({
  pres,
  dirtyRef,
  savingRef,
  onSaveOK,
  onSaveError,
  delayMs = 3000,
}: UseAutoSaveArgs): void {
  useEffect(() => {
    if (!dirtyRef.current) return;
    const t = setTimeout(async () => {
      if (savingRef.current) return;
      savingRef.current = true;
      try {
        await invoke("save_studio_presentation", { presentation: pres });
        dirtyRef.current = false;
        onSaveOK?.();
      } catch (err) {
        console.error("Auto-save failed", err);
        onSaveError?.(err);
      } finally {
        savingRef.current = false;
      }
    }, delayMs);
    return () => clearTimeout(t);
  }, [pres, dirtyRef, savingRef, onSaveOK, onSaveError, delayMs]);
}