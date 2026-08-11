/**
 * `useAutoSave`
 *
 * Debounced, revision-safe autosave for the active presentation.
 *
 * The slide editor owns a monotonically increasing `revisionRef` that is
 * bumped on every document mutation and an `EditorSaveState` machine:
 *
 *   "saved" | "dirty" | "saving" | "save-failed"
 *
 * Rules enforced here (SLIDE_EDITOR_MODERNIZATION_PLAN §7.2):
 *
 *   - Save after a debounce period since the last local change.
 *   - Save the latest presentation snapshot, never an outdated closure.
 *   - If a mutation occurs while a save is in flight, do not clear dirty
 *     state until the newer revision is also persisted. This is done by
 *     capturing `{ revision, snapshot }` when the save starts and, on
 *     success, clearing dirty only when `revisionRef` still equals the
 *     captured revision; otherwise the state returns to "dirty" and a new
 *     debounced save is scheduled.
 *   - On failure the state becomes "save-failed"; dirty state is retained
 *     and an explicit retry (or any new edit) schedules a fresh save.
 *   - No overlapping saves: the `inFlightRef` promise guard prevents a
 *     second save while one is running, and the effect only schedules
 *     when the state is exactly "dirty".
 *   - The host can await `inFlightRef.current` (e.g. from a close/discard
 *     handler) so a pending save is never silently abandoned.
 *
 * The same `save` function is shared with manual save and Save & Close.
 */

import { useEffect, type RefObject } from "react";
import type { CustomPresentation } from "../../../types";

export type EditorSaveState = "saved" | "dirty" | "saving" | "save-failed";

interface UseAutoSaveArgs {
  /** Latest presentation snapshot (current render value). */
  pres: CustomPresentation;
  /** Live save-state value; included as an effect dep so transitions re-evaluate. */
  saveState: EditorSaveState;
  /** Ref mirror of `saveState` for synchronous reads outside React. */
  saveStateRef: RefObject<EditorSaveState>;
  setSaveState: (s: EditorSaveState) => void;
  /** Monotonically increasing revision, bumped on every document mutation. */
  revisionRef: RefObject<number>;
  /** Shared persistence function (also used by manual save and close). */
  save: (p: CustomPresentation) => Promise<void>;
  /** Host stores the in-flight promise here so close/discard can await it. */
  inFlightRef: RefObject<Promise<void> | null>;
  onSaveError?: (err: unknown) => void;
  delayMs?: number;
}

export function useAutoSave({
  pres,
  saveState,
  saveStateRef,
  setSaveState,
  revisionRef,
  save,
  inFlightRef,
  onSaveError,
  delayMs = 2500,
}: UseAutoSaveArgs): void {
  useEffect(() => {
    if (saveState !== "dirty") return;

    const t = setTimeout(() => {
      if (inFlightRef.current) return;

      const revision = revisionRef.current;
      const snapshot = pres;
      saveStateRef.current = "saving";
      setSaveState("saving");

      inFlightRef.current = (async () => {
        try {
          await save(snapshot);
          if (revisionRef.current === revision) {
            saveStateRef.current = "saved";
            setSaveState("saved");
          } else {
            // A newer revision landed while we were saving: keep dirty so
            // the effect reschedules and persists the latest snapshot.
            saveStateRef.current = "dirty";
            setSaveState("dirty");
          }
        } catch (err) {
          console.error("Auto-save failed", err);
          saveStateRef.current = "save-failed";
          setSaveState("save-failed");
          onSaveError?.(err);
        } finally {
          inFlightRef.current = null;
        }
      })();
    }, delayMs);

    return () => clearTimeout(t);
  }, [pres, saveState, saveStateRef, setSaveState, revisionRef, save, inFlightRef, onSaveError, delayMs]);
}
