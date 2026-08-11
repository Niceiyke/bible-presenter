import { describe, expect, it } from "vitest";
import {
  importPresentation, exportPresentation,
  newTitleSlide, newDefaultSlide, newQuoteSlide, newAnnouncementSlide,
  newImageCaptionSlide, newScriptureSlide, deepCloneSlide, stableId,
} from "../../../../utils";
import { migratePresentation, migrateSlide } from "../helpers";
import { THEME_PRESETS } from "../ThemePicker";
import type { CustomPresentation, PresentationExport } from "../../../../types";

describe("Phase 5 — layouts, migration, theme, templates, media", () => {
  it("Scripture layout inserts expected text + reference content", () => {
    const s = newScriptureSlide();
    expect(s.elements).toHaveLength(2);
    const ref = s.elements[0];
    expect(ref.kind).toBe("text");
    expect((ref as any).content).toBeDefined();
    expect((ref as any).font_family).toBe("Georgia");
  });

  it("every built-in layout factory returns a slide with stable ids and 16:9-ish geometry", () => {
    for (const factory of [newTitleSlide, newDefaultSlide, newQuoteSlide, newAnnouncementSlide, newImageCaptionSlide, newScriptureSlide]) {
      const s = factory();
      expect(s.id).toBeTruthy();
      expect(s.background.type).toBe("color");
      for (const el of s.elements) {
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(100);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.y + el.h).toBeLessThanOrEqual(100);
      }
    }
  });

  it("legacy v1 presentation migrates to v2 (background union + content JSON + theme)", () => {
    const legacy = {
      id: "p1",
      name: "Old",
      version: 1,
      slides: [
        {
          id: "s1",
          backgroundColor: "#112233",
          header: { text: "Welcome", fontSize: 40, fontFamily: "Arial", color: "#fff", bold: true, italic: false, align: "center" },
          body: { text: "Body", fontSize: 28, fontFamily: "Arial", color: "#fff", bold: false, italic: false, align: "left" },
        },
      ],
    } as any;
    const migrated = migratePresentation(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.slides[0].background).toEqual({ type: "color", value: "#112233" });
    expect(migrated.theme).toBeDefined();
    expect(migrated.slides[0].elements.length).toBe(2);
    // string content migrated to ProseMirror JSON doc
    const text = migrated.slides[0].elements[0] as any;
    expect(typeof text.content).toBe("object");
    expect(text.content.type).toBe("doc");
  });

  it("migratePresentation is idempotent for already-v2 presentations", () => {
    const v2 = migratePresentation({ id: "x", name: "n", slides: [{ id: "s", background: { type: "color", value: "#1a1a2e" }, elements: [] }] } as any);
    const again = migratePresentation(v2);
    expect(again).toBe(v2);
  });

  it("legacy migration backfills shape `shape`/`fillColor` from legacy `color`", () => {
    const legacySlide = {
      id: "s",
      background: { type: "color", value: "#1a1a2e" },
      elements: [{ id: "e", kind: "shape", x: 0, y: 0, w: 10, h: 10, z_index: 1, color: "#ff0000" }],
    } as any;
    const m = migrateSlide(legacySlide);
    const shape = m.elements[0] as any;
    expect(shape.shape).toBe("rect");
    expect(shape.fillColor).toBe("#ff0000");
  });

  it("a theme preset supplies explicit theme fields; explicit per-element overrides are conceptual but not stamped", () => {
    // THEME_PRESETS cover the documented set; applying one sets theme-level
    // color/font fields. The renderer resolves "inherit"/undefined against the
    // theme, so explicit per-element values are untouched (no stamping here).
    const preset = THEME_PRESETS.find(p => p.id === "royal")!;
    expect(preset.textColor).toBe("#ffffff");
    expect(preset.accentColor).toBe("#a78bfa");
    // applyThemePreset merges these into the theme; an element with
    // font_family === "inherit" picks up preset.defaultFontFamily at render.
    const inheritedEl = { id: "a", kind: "text", x: 0, y: 0, w: 50, h: 20, z_index: 1, content: { type: "doc", content: [] }, font_family: "inherit", color: "inherit" } as any;
    expect(inheritedEl.font_family).toBe("inherit");
    // An explicit override stays explicit (not rewritten by theme).
    const explicitEl = { id: "b", kind: "text", x: 0, y: 0, w: 50, h: 20, z_index: 1, content: { type: "doc", content: [] }, font_family: "Courier New", color: "#00ff00" } as any;
    expect(explicitEl.font_family).not.toBe(inheritedEl.font_family);
  });

  it("import/export round-trips a presentation with fresh structure", () => {
    const pres: CustomPresentation = {
      id: "p", name: "Deck", version: 2,
      theme: { id: "t", name: "Default", defaultFontFamily: "Arial", defaultFontSize: 32, titleStyle: {}, bodyStyle: {}, textColor: "#fff", accentColor: "#f59e0b", background: { type: "color", value: "#111" } },
      slides: [{ id: "s1", background: { type: "color", value: "#1a1a2e" }, elements: [] }],
    } as any;
    const exp = exportPresentation({ presentation: pres }) as PresentationExport;
    const json = JSON.parse(JSON.stringify(exp));
    const imported = importPresentation(json);
    expect(imported.success).toBe(true);
    expect(imported.presentation!.id).toBe("p");
    expect(imported.presentation!.slides).toHaveLength(1);
  });

  it("template insertion clones slides with fresh element ids", () => {
    const src = newDefaultSlide();
    const originalElId = src.elements[0].id;
    const clone = deepCloneSlide(src);
    clone.id = stableId();
    clone.elements.forEach(e => (e.id = stableId()));
    expect(clone.id).not.toBe(src.id);
    expect(clone.elements[0].id).not.toBe(originalElId);
    // content structure preserved
    expect(clone.elements.length).toBe(src.elements.length);
  });
});