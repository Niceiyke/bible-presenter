import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { I18nProvider, useT } from "../../../../i18n";

describe("Phase 7 — editor i18n keys", () => {
  it("exposes editor.* keys in the default (en) dictionary", () => {
    const { result } = renderHook(() => useT(), { wrapper: I18nProvider });
    expect(result.current("editor.close")).toBe("Close editor");
    expect(result.current("editor.addSlide")).toBe("Add slide");
    expect(result.current("editor.stageSlide")).toBe("Stage Slide");
    expect(result.current("editor.onAir")).toBe("On Air");
    expect(result.current("editor.staged")).toBe("Staged");
    expect(result.current("editor.saveClose")).toBe("Save & Close");
    expect(result.current("editor.layers")).toBe("Layers");
  });

  it("falls back to the key when a translation is missing", () => {
    const { result } = renderHook(() => useT(), { wrapper: I18nProvider });
    expect(result.current("editor.doesNotExist")).toBe("editor.doesNotExist");
  });

  it("t() interpolates {n} variables", () => {
    const { result } = renderHook(() => useT(), { wrapper: I18nProvider });
    expect(result.current("editor.slide", { n: 3 })).toBe("Slide 3");
  });
});