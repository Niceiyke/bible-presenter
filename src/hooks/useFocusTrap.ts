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
  const onKeyDownRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables()[0];
    first?.focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscape) { e.preventDefault(); onEscape(); return; }
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
    onKeyDownRef.current = handler;
    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
      onKeyDownRef.current = null;
    };
  }, [active, ref, onEscape]);
}