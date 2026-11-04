import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// Node 26 exposes an experimental global `localStorage` accessor whose value is
// undefined unless Node is launched with --localstorage-file. Install a small
// deterministic test implementation before application modules initialize
// their Zustand slices. Defining it on both objects also avoids jsdom delegating
// back to Node's broken accessor.
const testStorage = (() => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(String(key)) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(String(key)); },
    setItem: (key: string, value: string) => { values.set(String(key), String(value)); },
  } satisfies Storage;
})();

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage });
}

// The tests import store slices and hooks that touch the browser only through
// React/Zustand, so no DOM setup is required beyond jsdom's defaults. localStorage
// is provided by jsdom; keep a clean slate for tests that read persisted prefs.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
