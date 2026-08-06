/**
 * `useSlideHistory`
 *
 * Slide-level undo / redo with keystroke coalescing.
 *
 * P1.4 + P1.6 of the slide-modernization plan. Replaces the inline
 * `history` / `historyIndex` pair the SlideEditor previously owned
 * directly. The hook also coalesces consecutive same-element text
 * edits (debounced 600ms) into a single history entry so typing
 * "Hello" into a text element produces 1 snapshot, not 5.
 *
 * Coalescing rules:
 *
 *   - Two consecutive commits within COALESCE_WINDOW_MS that both
 *     touch the *same* text element's `content` collapse into the
 *     later snapshot (the earlier one is squashed).
 *   - Multi-element ops (`alignElement` with N elements, etc.) are
 *     always distinct because they're atomic at the helper level —
 *     no coalescing needed.
 *   - Drag/resize pass `save=false` to the intermediate updates and
 *     `save=true` on pointer-up; the in-flight frames never reach
 *     `push`, so a drag produces exactly one history entry.
 *
 * The hook exposes `present` (the live presentation), `setPres`
 * (with coalescing knowledge), `undo`, `redo`, `canUndo`, `canRedo`.
 */

import { useCallback, useRef, useState } from "react";
import type { CustomPresentation, SlideElement } from "../../../types";

const HISTORY_MAX = 200;
const COALESCE_WINDOW_MS = 600;

// Localization of the "kind of change" info, in case Phase 2 widens
// coalescing beyond text-element edits.
interface CommitMeta {
  /** Coalesce key — two consecutive commits with the same key and within
    `COALESCE_WINDOW_MS` squash the earlier into the later. */
  coalesceKey: string | null;
  /** Wall-clock time of the commit (Date.now()). */
  at: number;
}

interface HistoryEntry {
  state: CustomPresentation;
  meta: CommitMeta;
}

export interface UseSlideHistory {
  present: CustomPresentation;
  setPres: (
    next: CustomPresentation | ((prev: CustomPresentation) => CustomPresentation),
    opts?: {
      save?: boolean;
      /** Coalesce key — set when commits with the same key inside
          COALESCE_WINDOW_MS should fold. e.g. `"text:${elementId}"`. */
      coalesceKey?: string | null;
    },
  ) => void;
  /** Bypass coalescing (used by undo/redo round-trip). */
  replacePresent: (next: CustomPresentation) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  index: number;
  length: number;
}

export function useSlideHistory(initial: CustomPresentation): UseSlideHistory {
  const [present, setPresent] = useState<CustomPresentation>(initial);
  // History is held in refs so updates don't trigger an extra render
  // pass and the closure refs never go stale.
  const entriesRef = useRef<HistoryEntry[]>([{ state: initial, meta: { coalesceKey: null, at: Date.now() } }]);
  const indexRef = useRef(0);

  // The setPres `setPresent` mask used by React triggers the actual DOM
  // render; the history ref bookkeeping stays in sync.
  const push = useCallback(
    (next: CustomPresentation, coalesceKey: string | null, at: number) => {
      const entries = entriesRef.current.slice(0, indexRef.current + 1);

      // Coalesce: if the last entry has the same coalesce key *AND* the
      // new commit is within COALESCE_WINDOW_MS, drop the previous entry
      // (we squash) and re-push next as the newest. The user thinks
      // "I typed five letters" = one undo step.
      const prev = entries[entries.length - 1];
      if (
        prev &&
        coalesceKey !== null &&
        prev.meta.coalesceKey === coalesceKey &&
        at - prev.meta.at < COALESCE_WINDOW_MS
      ) {
        entries.pop();
      }

      entries.push({ state: structuredClone(next), meta: { coalesceKey, at } });
      if (entries.length > HISTORY_MAX) entries.shift();
      entriesRef.current = entries;
      indexRef.current = entries.length - 1;
    },
    [],
  );

  const setPres = useCallback<UseSlideHistory["setPres"]>(
    (next, opts) => {
      const save = opts?.save !== false; // default save=true
      if (!save) {
        // In-flight drag/resize frame: update React state but don't
        // push a history entry. The pointer-up commit will push once.
        setPresent(typeof next === "function" ? (next as (p: CustomPresentation) => CustomPresentation)(present) : next);
        return;
      }
      setPresent((prev) => {
        const resolved = typeof next === "function" ? (next as (p: CustomPresentation) => CustomPresentation)(prev) : next;
        push(resolved, opts?.coalesceKey ?? null, Date.now());
        return resolved;
      });
    },
    [present, push],
  );

  const replacePresent = useCallback((next: CustomPresentation) => {
    setPresent(next);
  }, []);

  const undo = useCallback(() => {
    if (indexRef.current > 0) {
      indexRef.current -= 1;
      const entry = entriesRef.current[indexRef.current];
      setPresent(structuredClone(entry.state));
    }
  }, []);

  const redo = useCallback(() => {
    if (indexRef.current < entriesRef.current.length - 1) {
      indexRef.current += 1;
      const entry = entriesRef.current[indexRef.current];
      setPresent(structuredClone(entry.state));
    }
  }, []);

  return {
    present,
    setPres,
    replacePresent,
    undo,
    redo,
    canUndo: indexRef.current > 0,
    canRedo: indexRef.current < entriesRef.current.length - 1,
    index: indexRef.current,
    length: entriesRef.current.length,
  };
}

// ─── Coalesce-key helper ─────────────────────────────────────────────────────
//
// Callers can target a *specific* element's `content` change to fold
// consecutive keystrokes. Use this from SlideEditor's `commitInline`:
//   setPres(prev => mutate, { save: true, coalesceKey: textCoalesceKey(elId) });

export function textCoalesceKey(elementId: string): string {
  return `text:${elementId}`;
}

// Detect and discard no-op drag/resize coalesce keys (kept out of the
// returned object for caller convenience — drag commits pass
// `{ save: true }` on pointer-up so by default the editor's commit goes
// straight into history with `coalesceKey: null`).
export function keyForElementContentChange(el: SlideElement): string {
  return `text:${el.id}`;
}