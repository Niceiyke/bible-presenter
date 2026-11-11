import { describe, expect, it } from "vitest";
import type { ScriptureSuggestion } from "../../hooks/useAiScripture";
import { mergeSuggestionFeed } from "../scriptureSuggestions";

function suggestion(
  detection: ScriptureSuggestion["detection"],
  id: string,
  confidence: number,
): ScriptureSuggestion {
  return {
    id,
    detection,
    confidence,
    evidence: `${detection} evidence`,
    verse: {
      book: "John",
      chapter: 3,
      verse: 16,
      version: "KJV",
      text: "For God so loved the world...",
    },
    timestamp: 1,
  };
}

describe("mergeSuggestionFeed", () => {
  it("merges a direct quote into the explicit-reference card without blending confidence", () => {
    const reference = suggestion("reference", "reference-1", 0.94);
    const quote = suggestion("quote", "quote-1", 0.82);

    const merged = mergeSuggestionFeed([reference], quote);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "reference-1",
      detection: "reference",
      evidenceTypes: ["reference", "quote"],
      confidence: 0.94,
    });
  });

  it("promotes a quote card when an explicit reference arrives later", () => {
    const quote = suggestion("quote", "quote-1", 0.86);
    const reference = suggestion("reference", "reference-1", 0.91);

    const merged = mergeSuggestionFeed([quote], reference);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "reference-1",
      detection: "reference",
      evidenceTypes: ["reference", "quote"],
      confidence: 0.91,
    });
  });

  it("keeps paraphrase and direct evidence as separate cards", () => {
    const reference = suggestion("reference", "reference-1", 0.94);
    const paraphrase = suggestion("paraphrase", "paraphrase-1", 0.75);

    expect(mergeSuggestionFeed([reference], paraphrase)).toHaveLength(2);
  });
});
