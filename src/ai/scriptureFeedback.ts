import type { ScriptureSuggestion } from "../hooks/useAiScripture";

export type ScriptureFeedbackKind = "correct" | "wrong" | "not_quote" | "suppress";

export interface ScriptureFeedbackEvent {
  id: string;
  kind: ScriptureFeedbackKind;
  suggestionId: string;
  book: string;
  chapter: number;
  verse: number;
  version: string;
  detection: ScriptureSuggestion["detection"];
  confidence: number;
  timestamp: number;
}

const STORAGE_KEY = "wordlyte.aiScriptureFeedback.v1";
const MAX_EVENTS = 500;
/** “Don’t suggest again” is intentionally temporary so an accidental click is recoverable. */
const SUPPRESSION_DAYS = 90;
const DAY_MS = 86_400_000;

function readEvents(): ScriptureFeedbackEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ScriptureFeedbackEvent => (
      !!entry
      && typeof entry === "object"
      && typeof (entry as ScriptureFeedbackEvent).book === "string"
      && typeof (entry as ScriptureFeedbackEvent).chapter === "number"
      && typeof (entry as ScriptureFeedbackEvent).verse === "number"
      && typeof (entry as ScriptureFeedbackEvent).timestamp === "number"
    ));
  } catch {
    return [];
  }
}

function sameVerse(
  left: Pick<ScriptureFeedbackEvent, "book" | "chapter" | "verse">,
  right: Pick<ScriptureSuggestion["verse"], "book" | "chapter" | "verse">,
): boolean {
  return left.book === right.book && left.chapter === right.chapter && left.verse === right.verse;
}

export function loadScriptureFeedback(): ScriptureFeedbackEvent[] {
  return readEvents();
}

export function recordScriptureFeedback(
  kind: ScriptureFeedbackKind,
  suggestion: ScriptureSuggestion,
): ScriptureFeedbackEvent {
  const event: ScriptureFeedbackEvent = {
    id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    suggestionId: suggestion.id,
    book: suggestion.verse.book,
    chapter: suggestion.verse.chapter,
    verse: suggestion.verse.verse,
    version: suggestion.verse.version,
    detection: suggestion.detection,
    confidence: suggestion.confidence,
    timestamp: Date.now(),
  };
  const next = [event, ...readEvents()].slice(0, MAX_EVENTS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("wordlyte-scripture-feedback"));
  } catch {
    // Feedback is optional and must never interrupt projection.
  }
  return event;
}

/** Suppress repeat quote cards or all suggestions for a verse, depending on feedback. */
export function isSuggestionSuppressed(suggestion: ScriptureSuggestion): boolean {
  const cutoff = Date.now() - SUPPRESSION_DAYS * DAY_MS;
  return readEvents().some((event) => {
    if (event.timestamp < cutoff || !sameVerse(event, suggestion.verse)) return false;
    if (event.kind === "suppress") return true;
    return event.kind === "not_quote" && suggestion.detection === "quote";
  });
}

export function feedbackReport(): string {
  const events = loadScriptureFeedback();
  if (events.length === 0) return "No AI Scripture feedback has been recorded.";
  const count = (kind: ScriptureFeedbackKind) => events.filter((event) => event.kind === kind).length;
  return [
    "Wordlyte AI Scripture Feedback",
    `Correct verse: ${count("correct")}`,
    `Wrong verse: ${count("wrong")}`,
    `Not a quote: ${count("not_quote")}`,
    `Do not suggest again: ${count("suppress")}`,
    "",
    ...events.map((event) => (
      `${new Date(event.timestamp).toLocaleString()} [${event.kind}] ${event.book} ${event.chapter}:${event.verse} (${event.version}) · ${event.detection} · ${Math.round(event.confidence * 100)}%`
    )),
  ].join("\n");
}
