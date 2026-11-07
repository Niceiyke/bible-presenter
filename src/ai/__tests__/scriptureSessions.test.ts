import { describe, expect, it } from "vitest";
import { savedSessionTranscript, type SavedAiScriptureSession } from "../scriptureSessions";

describe("saved AI Scripture sessions", () => {
  it("builds presentation source from finalized non-empty transcript segments", () => {
    const session: SavedAiScriptureSession = {
      id: "session-1",
      startedAt: 1,
      endedAt: 2,
      provider: "assemblyai",
      mode: "service",
      audioDevice: "Mixer",
      version: "KJV",
      transcript: [
        { id: "1", text: "  Faith comes by hearing. ", isFinal: true, confidence: 0.98, timestamp: 1 },
        { id: "2", text: "revisable words", isFinal: false, confidence: 0.7, timestamp: 2 },
        { id: "3", text: "And hearing by the word of God.", isFinal: true, confidence: 0.99, timestamp: 3 },
      ],
      suggestions: [],
      stopReason: null,
    };

    expect(savedSessionTranscript(session)).toBe(
      "Faith comes by hearing.\nAnd hearing by the word of God.",
    );
  });
});
