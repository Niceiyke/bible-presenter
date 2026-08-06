import { useEffect, useRef } from "react";

/**
 * Centralised keyboard binding registry.
 *
 * One global `window` keydown dispatcher iterates registered bindings in priority
 * order (highest first) and calls the first enabled handler whose `match`
 * returns true. Handlers receive the event and may call `preventDefault`; the
 * dispatcher stops after the first claimed binding so context-specific handlers
 * (SlideEditor, LowerThird lyrics) cleanly override the operator-wide defaults
 * from `useKeyboardShortcuts` — resolving the previous `Ctrl+G`, `Space`, and
 * arrow-key collisions between the three overlapping listeners.
 *
 * Usage:
 *   useKeyboardBinding("slide-editor", 20, () => true, (e) => { ... });
 *   useKeyboardBinding("lt-lyrics", 10, () => active, handler);
 *
 * The fallback `useKeyboardShortcuts` registers at priority 0.
 */

interface Binding {
  id: string;
  priority: number;
  match: (e: KeyboardEvent) => boolean;
  handle: (e: KeyboardEvent) => void;
}

const bindings: Binding[] = [];
let installed = false;

function dispatch(e: KeyboardEvent) {
  // Iterate highest-priority first; skip disabled via match() returning false.
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b.match(e)) {
      b.handle(e);
      if (e.defaultPrevented) return;
    }
  }
}

function ensureInstalled() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", dispatch);
}

/**
 * Register a keyboard binding for the lifetime of the calling component.
 * `match` should return false when the context is inactive (e.g. editor closed
 * or LT-lyrics tab not focused) so the dispatcher falls through to lower
 * priorities.
 */
export function useKeyboardBinding(
  id: string,
  priority: number,
  match: (e: KeyboardEvent) => boolean,
  handle: (e: KeyboardEvent) => void,
) {
  const handleRef = useRef(handle);
  const matchRef = useRef(match);
  handleRef.current = handle;
  matchRef.current = match;

  useEffect(() => {
    ensureInstalled();
    const binding: Binding = {
      id,
      priority,
      match: (e) => matchRef.current(e),
      handle: (e) => handleRef.current(e),
    };
    bindings.push(binding);
    // Keep sorted by descending priority so dispatch iterates in order.
    bindings.sort((a, b) => b.priority - a.priority);
    return () => {
      const idx = bindings.indexOf(binding);
      if (idx >= 0) bindings.splice(idx, 1);
    };
  }, [id, priority]);
}
