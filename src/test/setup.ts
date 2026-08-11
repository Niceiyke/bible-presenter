import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

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
