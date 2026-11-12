import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiScriptureProvider, type ScriptureSuggestion } from "../useAiScripture";
import { useAppStore } from "../../store";
import { DEFAULT_SETTINGS } from "../../types";

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
    localStorage.removeItem("pref_aiListeningMode");
    localStorage.removeItem("pref_aiScripturePerformanceV1");
    useAppStore.getState().setBibleVersion("KJV");
    useAppStore.getState().setSettings({ ...DEFAULT_SETTINGS });
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

  it("keeps a high-confidence loose quote manual", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({
      ...suggestion(0.98, "loose-quote"),
      detection: "quote",
      quoteSupport: "loose",
    });

    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("never takes a loose quote live even with quote auto-live enabled", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    const onSendLiveVerse = vi.fn().mockResolvedValue(true);
    useAppStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      ai_scripture_auto_live: true,
      ai_scripture_auto_live_quotes: true,
    });
    render(<AiScriptureProvider onStageVerse={onStageVerse} onSendLiveVerse={onSendLiveVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({
      ...suggestion(0.98, "loose-live-quote"),
      detection: "quote",
      quoteSupport: "loose",
    });

    expect(onSendLiveVerse).not.toHaveBeenCalled();
    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("auto-stages an anchored quote at 90% confidence", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    const anchored = {
      ...suggestion(0.9, "anchored-quote"),
      detection: "quote" as const,
      quoteSupport: "anchored" as const,
    };
    await emitSuggestion(anchored);

    expect(onStageVerse).toHaveBeenCalledOnce();
    expect(onStageVerse).toHaveBeenCalledWith(anchored.verse);
  });

  it("leaves direct references below the interim threshold for manual staging", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.889));

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

  it("keeps next-verse voice commands manual even at high confidence", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.99, "next-verse"), detection: "command" });

    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("sends only an explicitly selected reference live", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    const onSendLiveVerse = vi.fn().mockResolvedValue(true);
    useAppStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      ai_scripture_auto_live: true,
      ai_scripture_auto_live_references: true,
    });
    render(<AiScriptureProvider onStageVerse={onStageVerse} onSendLiveVerse={onSendLiveVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.97, "reference-live"));

    expect(onSendLiveVerse).toHaveBeenCalledWith(suggestion(0.97, "reference-live").verse);
    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("uses the independently selected command and top paraphrase settings", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    const onSendLiveVerse = vi.fn().mockResolvedValue(true);
    useAppStore.getState().setSettings({
      ...DEFAULT_SETTINGS,
      ai_scripture_auto_live: true,
      ai_scripture_auto_live_voice_commands: true,
      ai_scripture_auto_live_paraphrases: true,
    });
    render(<AiScriptureProvider onStageVerse={onStageVerse} onSendLiveVerse={onSendLiveVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.99, "command-live"), detection: "command" });
    await emitSuggestion({ ...suggestion(0.89, "theme-alternative"), detection: "paraphrase", rank: 2 });
    await emitSuggestion({ ...suggestion(0.89, "theme-live"), detection: "paraphrase", rank: 1 });

    expect(onSendLiveVerse).toHaveBeenCalledTimes(2);
    expect(onStageVerse).not.toHaveBeenCalled();
  });

  it("applies a voice translation command without staging content", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    useAppStore.getState().setBibleVersion("KJV");
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-command")).toBe(true));

    await act(async () => {
      mocks.listeners.get("ai-scripture-command")?.({
        payload: {
          command: "version",
          message: "Voice command: Scripture translation changed to NLT.",
          version: "NLT",
          reference: null,
          timestamp: 1,
        },
      });
      await Promise.resolve();
    });

    expect(useAppStore.getState().bibleVersion).toBe("NLT");
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

  it("uses an interim direct reference once and ignores its final upgrade", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.89, "interim-reference"), timestamp: 1_000 });
    await emitSuggestion({ ...suggestion(0.99, "final-reference"), timestamp: 1_500 });

    expect(onStageVerse).toHaveBeenCalledOnce();
    expect(onStageVerse).toHaveBeenCalledWith(suggestion(0.89, "interim-reference").verse);
  });

  it("does not auto-stage a second time when another detector finds the same verse", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.97, "reference-match"), timestamp: 1_000 });
    await emitSuggestion({
      ...suggestion(0.96, "quote-match"),
      detection: "quote",
      timestamp: 1_500,
    });

    expect(onStageVerse).toHaveBeenCalledOnce();
  });

  it("runs automation again for a fresh mention while reusing the same passage card", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.97, "first-mention"), timestamp: 1_000 });
    await emitSuggestion({ ...suggestion(0.98, "repeated-mention"), timestamp: 10_000 });

    expect(onStageVerse).toHaveBeenCalledTimes(2);
    expect(onStageVerse).toHaveBeenNthCalledWith(1, suggestion(0.97, "first-mention").verse);
    expect(onStageVerse).toHaveBeenNthCalledWith(2, suggestion(0.98, "repeated-mention").verse);
  });

  it("keeps Service mode listening after a recognized suggestion", async () => {
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.5, "service-keeps-listening"));

    expect(mocks.invoke).not.toHaveBeenCalledWith("ai_stop");
  });

  it("stops Operator mode after one verified reference", async () => {
    localStorage.setItem("pref_aiListeningMode", "operator");
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion(suggestion(0.5, "operator-one-result"));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ai_stop"));
  });

  it("does not stop Operator mode for a possible paraphrase theme", async () => {
    localStorage.setItem("pref_aiListeningMode", "operator");
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-suggestion")).toBe(true));

    await emitSuggestion({ ...suggestion(0.89, "operator-theme"), detection: "paraphrase", rank: 1 });

    expect(mocks.invoke).not.toHaveBeenCalledWith("ai_stop");
  });

  it("stops Operator mode for a standalone voice command", async () => {
    localStorage.setItem("pref_aiListeningMode", "operator");
    const onStageVerse = vi.fn().mockResolvedValue(true);
    render(<AiScriptureProvider onStageVerse={onStageVerse}><div /></AiScriptureProvider>);
    await waitFor(() => expect(mocks.listeners.has("ai-scripture-command")).toBe(true));

    await act(async () => {
      mocks.listeners.get("ai-scripture-command")?.({
        payload: { command: "version", message: "Translation changed", version: "NLT", reference: null, timestamp: 1 },
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ai_stop"));
  });
});
