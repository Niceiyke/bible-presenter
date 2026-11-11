import type { Verse } from "../types";

export interface SavedTranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  confidence: number;
  timestamp: number;
}

export interface SavedScriptureSuggestion {
  id: string;
  detection: "reference" | "quote" | "paraphrase" | "command";
  evidenceTypes?: Array<"reference" | "quote">;
  confidence: number;
  evidence: string;
  verse: Verse;
  timestamp: number;
  sourceTranscriptTimestamp?: number;
  groupId?: string;
  rank?: number;
  passageStart?: number;
  passageEnd?: number;
  similarity?: number;
  margin?: number;
}

export interface SavedAiScriptureSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  provider: string;
  mode: string;
  audioDevice: string;
  version: string;
  transcript: SavedTranscriptSegment[];
  suggestions: SavedScriptureSuggestion[];
  stopReason: string | null;
}

export interface SavedAiScriptureSessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  provider: string;
  mode: string;
  version: string;
  transcriptSegments: number;
  suggestions: number;
  transcriptPreview: string;
}

export function savedSessionTranscript(session: SavedAiScriptureSession): string {
  return session.transcript
    .filter((segment) => segment.isFinal && segment.text.trim())
    .map((segment) => segment.text.trim())
    .join("\n");
}
