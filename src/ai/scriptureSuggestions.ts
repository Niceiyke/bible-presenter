import type { ScriptureSuggestion } from "../hooks/useAiScripture";

const DIRECT_SOURCES = ["reference", "quote"] as const;

function isDirectSuggestion(suggestion: ScriptureSuggestion): boolean {
  return DIRECT_SOURCES.includes(suggestion.detection as (typeof DIRECT_SOURCES)[number]);
}

function sameCanonicalVerse(left: ScriptureSuggestion, right: ScriptureSuggestion): boolean {
  return left.verse.book === right.verse.book
    && left.verse.chapter === right.verse.chapter
    && left.verse.verse === right.verse.verse;
}

function directEvidenceTypes(suggestion: ScriptureSuggestion): Array<"reference" | "quote"> {
  const evidence = new Set<"reference" | "quote">(
    suggestion.evidenceTypes?.filter((source): source is "reference" | "quote" => (
      DIRECT_SOURCES.includes(source)
    )) ?? [],
  );
  if (isDirectSuggestion(suggestion)) evidence.add(suggestion.detection as "reference" | "quote");
  return DIRECT_SOURCES.filter((source) => evidence.has(source));
}

function preferredDirectSuggestion(
  current: ScriptureSuggestion,
  incoming: ScriptureSuggestion,
): ScriptureSuggestion {
  // An explicit citation is the primary display/automation source when both
  // detectors identify the same verse; same-source updates use the newest data.
  if (current.detection === "reference" && incoming.detection === "quote") return current;
  return incoming;
}

/** Adds one ASR suggestion while keeping direct reference/quote matches on one card. */
export function mergeSuggestionFeed(
  current: ScriptureSuggestion[],
  incoming: ScriptureSuggestion,
): ScriptureSuggestion[] {
  if (isDirectSuggestion(incoming)) {
    const existingIndex = current.findIndex((item) => (
      isDirectSuggestion(item) && sameCanonicalVerse(item, incoming)
    ));
    if (existingIndex < 0) {
      return [{ ...incoming, evidenceTypes: directEvidenceTypes(incoming) }, ...current].slice(0, 30);
    }

    const existing = current[existingIndex];
    const evidenceTypes = new Set([
      ...directEvidenceTypes(existing),
      ...directEvidenceTypes(incoming),
    ]);
    const preferred = preferredDirectSuggestion(existing, incoming);
    const merged: ScriptureSuggestion = {
      ...preferred,
      evidenceTypes: DIRECT_SOURCES.filter((source) => evidenceTypes.has(source)),
    };
    return [merged, ...current.filter((_, index) => index !== existingIndex)].slice(0, 30);
  }

  // Keep paraphrase alternatives and command cards independent, while still
  // replacing revisions from the same detection path as before.
  return [
    incoming,
    ...current.filter((item) => !(
      item.detection === incoming.detection && sameCanonicalVerse(item, incoming)
    )),
  ].slice(0, 30);
}
