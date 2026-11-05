import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiScriptureProvider, type ScriptureSuggestion } from "../useAiScripture";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (payload: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return vi.fn();
  }),
}));

function suggestion(confidence: number, id = `suggestion-${confidence}`): ScriptureSuggestion {
  return {
    id,
    detection: "reference",
    confidence,
    evidence: "John chapter three verse sixteen",
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

async function emitSuggestion(payload: ScriptureSuggestion) {
  await act(async () => {
    mocks.listeners.get("ai-scripture-suggestion")?.({ payload });
    await Promise.resolve();
  });
}

describe("AiScriptureProvider automatic staging", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      state: "stopped",
      provider: "deepgram",
      audioDevice: null,
      version: null,
      message: "AI Scripture is stopped.",
    });
  });

  it("auto-stages suggestions at exactly 90% confidence", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.9));

    expect(onStageVerse).toHaveBeenCalledOnce();
    expect(onStageVerse).toHaveBeenCalledWith(suggestion(0.9).verse);
  });

  it("leaves suggestions below 90% for manual staging", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.899));

    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("never auto-stages any candidate in a paraphrase group", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    for (const rank of [3, 2, 1]) {
      await emitSuggestion({
        ...suggestion(0.99, `theme-${rank}`),
        detection: "paraphrase",
        groupId: "theme-group",
        rank,
      });
    }

    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("never auto-stages the same suggestion event twice", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));
    const payload = suggestion(0.97, "same-id");

    await emitSuggestion(payload);
    await emitSuggestion(payload);

    expect(onStageVerse).toHaveBeenCalledOnce();
  });
});
