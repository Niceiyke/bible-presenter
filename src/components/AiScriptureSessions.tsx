import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, FileText, History, RefreshCw, Trash2 } from "lucide-react";
import {
  savedSessionTranscript,
  type SavedAiScriptureSession,
  type SavedAiScriptureSessionSummary,
} from "../ai/scriptureSessions";
import { useAppStore } from "../store";

function sessionDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function AiScriptureSessions({ active }: { active: boolean }) {
  const setToast = useAppStore((state) => state.setToast);
  const [sessions, setSessions] = useState<SavedAiScriptureSessionSummary[]>([]);
  const [selected, setSelected] = useState<SavedAiScriptureSession | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await invoke<SavedAiScriptureSessionSummary[]>("ai_sessions_list"));
    } catch (error) {
      setToast(`Could not load saved AI Scripture sessions: ${error}`);
    } finally {
      setLoading(false);
    }
  }, [setToast]);

  useEffect(() => {
    void refresh();
  }, [active, refresh]);

  const openSession = async (id: string) => {
    try {
      setSelected(await invoke<SavedAiScriptureSession>("ai_session_get", { id }));
    } catch (error) {
      setToast(`Could not open the saved session: ${error}`);
    }
  };

  const exportSession = async (session: SavedAiScriptureSessionSummary) => {
    const stamp = new Date(session.startedAt).toISOString().replaceAll(":", "-").slice(0, 19);
    const path = await save({
      title: "Export AI Scripture transcript",
      defaultPath: `wordlyte-transcript-${stamp}.md`,
      filters: [
        { name: "Markdown with suggestions", extensions: ["md"] },
        { name: "Plain transcript", extensions: ["txt"] },
        { name: "Complete session data", extensions: ["json"] },
      ],
    });
    if (!path) return;
    try {
      await invoke("ai_session_export", { id: session.id, path });
      setToast("AI Scripture transcript exported.");
    } catch (error) {
      setToast(`Could not export the transcript: ${error}`);
    }
  };

  const deleteSession = async (session: SavedAiScriptureSessionSummary) => {
    if (!window.confirm(`Delete the saved AI Scripture session from ${sessionDate(session.startedAt)}?`)) return;
    try {
      await invoke("ai_session_delete", { id: session.id });
      if (selected?.id === session.id) setSelected(null);
      await refresh();
      setToast("Saved AI Scripture session deleted.");
    } catch (error) {
      setToast(`Could not delete the saved session: ${error}`);
    }
  };

  return (
    <section className="rounded-lg border border-console-border bg-console-surface-raised/30">
      <div className="px-3 py-2 border-b border-console-border flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><History size={11} className="text-violet-400" /> Saved sessions</h3>
          <p className="mt-0.5 text-[9px] text-console-text-subtle">Final transcripts and Scripture suggestions are stored locally and included in Wordlyte backups.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="text-[10px] text-console-text-subtle hover:text-console-text flex items-center gap-1 disabled:opacity-50"><RefreshCw size={10} className={loading ? "animate-spin" : ""} /> Refresh</button>
      </div>

      {sessions.length === 0 ? (
        <p className="p-3 text-[11px] italic text-console-text-subtle">A saved session will be created when listening starts.</p>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)] min-h-48 max-h-[360px]">
          <div className="overflow-y-auto custom-scrollbar border-b xl:border-b-0 xl:border-r border-console-border">
            {sessions.slice(0, 50).map((session) => (
              <article key={session.id} className={`p-3 border-b border-console-border/70 ${selected?.id === session.id ? "bg-violet-500/10" : "hover:bg-console-surface-raised/50"}`}>
                <button type="button" onClick={() => void openSession(session.id)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-[11px] text-console-text">{sessionDate(session.startedAt)}</strong>
                    <span className={`text-[9px] uppercase ${session.endedAt == null ? "text-state-success" : "text-console-text-subtle"}`}>{session.endedAt == null ? "In progress · " : ""}{session.mode} · {session.provider}</span>
                  </div>
                  <p className="mt-1 text-[10px] text-console-text-muted line-clamp-2">{session.transcriptPreview || "No final transcript text was captured."}</p>
                  <p className="mt-1 text-[9px] text-console-text-subtle">{session.transcriptSegments} segments · {session.suggestions} suggestions · {session.version}</p>
                </button>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => void exportSession(session)} className="text-[9px] font-bold uppercase text-action-primary flex items-center gap-1"><Download size={10} /> Export</button>
                  <button type="button" onClick={() => void deleteSession(session)} className="text-[9px] font-bold uppercase text-state-error flex items-center gap-1"><Trash2 size={10} /> Delete</button>
                </div>
              </article>
            ))}
          </div>
          <div className="overflow-y-auto custom-scrollbar p-3 select-text">
            {!selected ? (
              <div className="h-full min-h-36 flex items-center justify-center text-center text-[10px] text-console-text-subtle"><p><FileText size={18} className="mx-auto mb-2 opacity-60" />Select a session to review its transcript and detected Scriptures.<br />Saved transcripts are also available in AI Presentation Creation.</p></div>
            ) : (
              <div>
                <h4 className="text-xs font-bold text-console-text">Transcript</h4>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-console-text-muted">{savedSessionTranscript(selected) || "No final transcript text was captured."}</p>
                {selected.suggestions.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-xs font-bold text-console-text">Suggestions ({selected.suggestions.length})</h4>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selected.suggestions.map((suggestion) => <span key={suggestion.id} className="rounded border border-console-border bg-console-surface px-2 py-1 text-[9px] text-console-text-muted">{suggestion.verse.book} {suggestion.verse.chapter}:{suggestion.verse.verse} · {suggestion.evidenceTypes?.length ? suggestion.evidenceTypes.join(" + ") : suggestion.detection} · {Math.round(suggestion.confidence * 100)}%</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
