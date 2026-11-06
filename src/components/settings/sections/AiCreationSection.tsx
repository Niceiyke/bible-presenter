import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Sparkles } from "lucide-react";

interface KeyStatus {
  configured: boolean;
  provider: "openai";
}

export function AiCreationSection() {
  const [status, setStatus] = useState<KeyStatus>({ configured: false, provider: "openai" });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem("pref_aiPresentationModel") || "gpt-6-astra");

  useEffect(() => {
    void invoke<KeyStatus>("ai_presentation_key_status").then(setStatus).catch(() => undefined);
  }, []);

  const saveKey = async () => {
    setSaving(true);
    try {
      setStatus(await invoke<KeyStatus>("ai_presentation_set_api_key", { apiKey }));
      setApiKey("");
    } catch (error) {
      window.alert(`Could not save OpenAI API key: ${error}`);
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm("Remove the saved OpenAI API key? Existing presentations are unaffected.")) return;
    try {
      await invoke("ai_presentation_clear_api_key");
      setStatus({ configured: false, provider: "openai" });
    } catch (error) {
      window.alert(`Could not remove OpenAI API key: ${error}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <p className="text-xs text-console-text-muted font-bold uppercase mb-1 flex items-center gap-1.5"><Sparkles size={13} /> AI Presentation Creation</p>
        <p className="text-[10px] text-console-text-subtle">Generate editable Studio drafts from a topic or pasted notes. AI creation never stages slides or changes the live program feed.</p>
      </div>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><KeyRound size={12} /> OpenAI</p>
          <span className={`text-[10px] font-bold ${status.configured ? "text-state-success" : "text-state-stage"}`}>{status.configured ? "Configured" : "Required"}</span>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status.configured ? "Enter a replacement key" : "OpenAI API key"}
            className="min-w-0 flex-1 px-2.5 py-2 rounded-md border border-console-border bg-console-surface text-xs text-console-text placeholder:text-console-text-subtle"
          />
          <button onClick={() => void saveKey()} disabled={saving || apiKey.trim().length < 20} className="px-3 py-2 rounded-md bg-action-primary text-black disabled:bg-console-surface-strong disabled:text-console-text-subtle text-[11px] font-bold">{saving ? "Saving…" : "Save key"}</button>
          {status.configured && <button onClick={() => void clearKey()} className="px-3 py-2 rounded-md border border-console-border text-console-text-muted text-[11px] font-bold">Remove</button>}
        </div>
        <p className="text-[10px] text-console-text-subtle">Stored with Windows DPAPI for the current user and excluded from Wordlyte backups. Source notes are sent only when you select Generate.</p>
      </section>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-2">
        <label htmlFor="ai-presentation-model" className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">OpenAI model</label>
        <input
          id="ai-presentation-model"
          value={model}
          onChange={(event) => {
            const next = event.target.value;
            setModel(next);
            localStorage.setItem("pref_aiPresentationModel", next);
          }}
          className="max-w-sm px-2.5 py-2 rounded-md border border-console-border bg-console-surface text-xs text-console-text"
        />
        <p className="text-[10px] text-console-text-subtle">The default is <code>gpt-6-astra</code>. Change this only when your OpenAI account uses another compatible Responses API model.</p>
      </section>
    </div>
  );
}
