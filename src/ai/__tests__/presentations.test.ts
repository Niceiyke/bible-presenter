import { describe, expect, it } from "vitest";
import {
  AI_PRESENTATION_THEME,
  aiTextToDoc,
  applyAiRegeneratedSlide,
  applyAiTextEdit,
  canonicalScriptureReference,
  compileAiDeckPlan,
  proseMirrorToPlainText,
  type AiDeckPlan,
  type AiSlideEditResult,
} from "../presentations";

const plan: AiDeckPlan = {
  title: "Faith in Uncertainty",
  objective: "Encourage trust",
  warnings: [],
  slides: [
    {
      kind: "title",
      title: "Faith in Uncertainty",
      body: "Trust God in every season",
      bullets: [],
      scriptureReferences: [],
      scriptures: [],
      quote: "",
      attribution: "",
      speakerNotes: "Welcome the congregation.",
      emphasis: [{ text: "Uncertainty", style: "accent-bold" }],
    },
    {
      kind: "scripture",
      title: "God Is With You",
      body: "",
      bullets: [],
      scriptureReferences: ["Isaiah 41:10"],
      scriptures: [{
        reference: "Isaiah 41:10",
        verses: [{ book: "Isaiah", chapter: 41, verse: 10, version: "KJV", text: "Fear thou not; for I am with thee." }],
      }],
      quote: "",
      attribution: "",
      speakerNotes: "Read slowly.",
      emphasis: [],
    },
  ],
};

describe("AI presentation compiler", () => {
  it("uses safe rich-text marks for exact emphasis", () => {
    const doc = aiTextToDoc("Choose faith over fear", [{ text: "faith", style: "accent-bold" }], "#f59e0b") as any;
    const marked = doc.content[0].content.find((node: any) => node.text === "faith");
    expect(marked.marks).toEqual([
      { type: "bold" },
      { type: "textStyle", attrs: { color: "#f59e0b" } },
    ]);
  });

  it("compiles a normal editable native presentation", () => {
    const presentation = compileAiDeckPlan(plan);
    expect(presentation.version).toBe(2);
    expect(presentation.slides).toHaveLength(2);
    expect(presentation.slides[0].notes).toBe("Welcome the congregation.");
    expect(presentation.slides[1].elements).toHaveLength(2);
    expect(presentation.slides[1].elements.every((element) => element.kind === "text")).toBe(true);
  });

  it("renders Scripture references from locally verified verses", () => {
    expect(canonicalScriptureReference({
      reference: "a provider alias 3:16-17",
      verses: [
        { book: "John", chapter: 3, verse: 16, version: "KJV", text: "Verse 16" },
        { book: "John", chapter: 3, verse: 17, version: "KJV", text: "Verse 17" },
      ],
    })).toBe("John 3:16-17");
  });

  it("extracts plain text from native rich-text documents", () => {
    const doc = aiTextToDoc("Choose faith over fear", [{ text: "faith", style: "bold" }], "#f59e0b");
    expect(proseMirrorToPlainText(doc)).toBe("Choose faith over fear");
  });

  it("applies highlights without allowing AI to replace the original wording", () => {
    const presentation = compileAiDeckPlan(plan);
    const element = presentation.slides[0].elements[0];
    if (element.kind !== "text") throw new Error("expected text element");
    const result: AiSlideEditResult = {
      warnings: [],
      slide: {
        ...plan.slides[0],
        body: "Provider replacement must be ignored",
        emphasis: [{ text: "Uncertainty", style: "accent-bold" }],
      },
    };
    const update = applyAiTextEdit(element, result, "highlight", "#f59e0b");
    expect(proseMirrorToPlainText(update.content!)).toBe("Faith in Uncertainty");
  });

  it("regenerates text while preserving native slide geometry and identity", () => {
    const presentation = compileAiDeckPlan(plan);
    const existing = presentation.slides[0];
    const first = existing.elements[0];
    const regenerated = applyAiRegeneratedSlide(existing, {
      ...plan.slides[0],
      title: "Courage in Uncertainty",
      body: "Trust God today",
    }, presentation.theme ?? AI_PRESENTATION_THEME, presentation.name);
    expect(regenerated.id).toBe(existing.id);
    expect(regenerated.background).toEqual(existing.background);
    expect(regenerated.elements[0].id).toBe(first.id);
    expect(regenerated.elements[0].x).toBe(first.x);
    const regeneratedTitle = regenerated.elements[0];
    if (regeneratedTitle.kind !== "text") throw new Error("expected text element");
    expect(proseMirrorToPlainText(regeneratedTitle.content)).toBe("Courage in Uncertainty");
  });
});
