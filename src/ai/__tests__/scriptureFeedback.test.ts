import { beforeEach, describe, expect, it } from "vitest";
import {
  feedbackReport,
  isSuggestionSuppressed,
  loadScriptureFeedback,
  recordScriptureFeedback,
} from "../scriptureFeedback";
import type { ScriptureSuggestion } from "../../hooks/useAiScripture";

function suggestion(overrides: Partial<ScriptureSuggestion> = {}): ScriptureSuggestion {
  return {
    id: "suggestion-1",
    detection: "quote",
    confidence: 0.92,
    evidence: "the Lord is my shepherd",
    verse: {
      book: "Psalms",
      chapter: 23,
      verse: 1,
      version: "KJV",
      text: "The LORD is my shepherd; I shall not want.",
    },
    timestamp: 1,
    ...overrides,
  };
}

describe("AI Scripture feedback", () => {
  beforeEach(() => localStorage.clear());

  it("stores feedback without transcript text", () => {
    recordScriptureFeedback("correct", suggestion());
    const events = loadScriptureFeedback();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("correct");
    expect(events[0]).not.toHaveProperty("transcript");
    expect(events[0]).not.toHaveProperty("evidence");
    expect(feedbackReport()).toContain("Correct verse: 1");
  });

  it("suppresses future suggestions for that verse", () => {
    recordScriptureFeedback("suppress", suggestion());
    expect(isSuggestionSuppressed(suggestion())).toBe(true);
    expect(isSuggestionSuppressed(suggestion({
      verse: { ...suggestion().verse, verse: 2 },
    }))).toBe(false);
  });

  it("only suppresses quote cards after 'not a quote'", () => {
    recordScriptureFeedback("not_quote", suggestion());
    expect(isSuggestionSuppressed(suggestion({ detection: "quote" }))).toBe(true);
    expect(isSuggestionSuppressed(suggestion({ detection: "reference" }))).toBe(false);
  });
});
