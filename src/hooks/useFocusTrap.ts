import { useEffect, useRef } from "react";

/**
 * Trap keyboard focus inside `ref` while `active` is true.
 *
 * - On activation, the first focusable element in the container is focused.
 * - Tab/Shift+Tab cycle only focusable elements inside the container.
 * - Escape invokes `onEscape` (the caller decides whether to close).
 *
 * Used by modals (RecoveryModal, ShortcutsModal, SlideEditor) to satisfy the
 * WCAG modal dialog pattern. Mutating the DOM (`tabindex`) on outside
 * elements ("inert" pattern) is intentionally avoided to keep this simple
 * and safe across windows.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
) {
  // `onEscape` is usually an inline closure from the caller, so it gets a new
  // identity on every render. Holding it in a ref keeps the effect (and its
  // auto-focus on activation) from re-running on each keystroke — previously a
  // modal re-render stole focus back to the first focusable element and made
  // typing in inputs lose focus after a few characters.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables()[0];
    first?.focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscapeRef.current) { e.preventDefault(); onEscapeRef.current(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const activeEl = document.activeElement as HTMLElement | null;
      const idx = items.indexOf(activeEl as HTMLElement);
      if (e.shiftKey) {
        e.preventDefault();
        items[(idx <= 0 ? items.length : idx) - 1].focus();
      } else {
        e.preventDefault();
        items[(idx + 1) % items.length].focus();
      }
    };
    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
    };
  }, [active, ref]);
}