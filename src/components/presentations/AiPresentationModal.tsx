import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, BookOpen, CheckCircle2, History, Sparkles, XCircle } from "lucide-react";
import { Button, Modal, StatusBadge } from "../ui";
import {
  compileAiDeckPlan,
  canonicalScriptureReference,
  type AiDeckPlan,
  type AiPresentationRequest,
} from "../../ai/presentations";
import type { CustomPresentation } from "../../types";
import { savedSessionTranscript, type SavedAiScriptureSession, type SavedAiScriptureSessionSummary } from "../../ai/scriptureSessions";

interface AiPresentationModalProps {
  open: boolean;
  defaultBibleVersion: string;
  onClose: () => void;
  onCreate: (presentation: CustomPresentation) => Promise<void>;
}

interface KeyStatus {
  configured: boolean;
  provider: "openai";
}

const PRESENTATION_TYPES = ["Sermon", "Bible study", "Teaching", "Announcement", "Event"];
const FIELD_CLASS = "w-full rounded-lg border border-console-border bg-console-canvas px-3 py-2 text-xs text-console-text outline-none focus:border-action-primary/60";

export function AiPresentationModal({ open, defaultBibleVersion, onClose, onCreate }: AiPresentationModalProps) {
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [audience, setAudience] = useState("General congregation");
  const [presentationType, setPresentationType] = useState("Sermon");
  const [slideCount, setSlideCount] = useState(8);
  const [bibleVersion, setBibleVersion] = useState(defaultBibleVersion || "KJV");
  const [versions, setVersions] = useState<string[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedAiScriptureSessionSummary[]>([]);
  const [savedSessionId, setSavedSessionId] = useState("");
  const [includeSpeakerNotes, setIncludeSpeakerNotes] = useState(true);
  const [highlightKeyPoints, setHighlightKeyPoints] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<AiDeckPlan | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void Promise.all([
      invoke<KeyStatus>("ai_presentation_key_status"),
      invoke<string[]>("get_bible_versions"),
      invoke<SavedAiScriptureSessionSummary[]>("ai_sessions_list"),
    ]).then(([key, available, sessions]) => {
      setConfigured(key.configured);
      setVersions(available);
      setSavedSessions(sessions.filter((session) => session.transcriptSegments > 0));
      if (!available.includes(bibleVersion)) setBibleVersion(available[0] || defaultBibleVersion || "KJV");
    }).catch((reason) => setError(`Could not initialize AI creation: ${reason}`));
  }, [open, defaultBibleVersion]);

  useEffect(() => {
    if (!open) return;
    const refreshSavedSessions = () => {
      void invoke<SavedAiScriptureSessionSummary[]>("ai_sessions_list")
        .then((sessions) => setSavedSessions(sessions.filter((session) => session.transcriptSegments > 0)))
        .catch(() => undefined);
    };
    const interval = window.setInterval(refreshSavedSessions, 3_000);
    return () => window.clearInterval(interval);
  }, [open]);

  const model = useMemo(() => localStorage.getItem("pref_aiPresentationModel") || "gpt-6-astra", [open]);

  const cancel = async () => {
    const jobId = jobIdRef.current;
    if (jobId) await invoke("ai_cancel_presentation", { jobId }).catch(() => undefined);
    jobIdRef.current = null;
    setGenerating(false);
  };

  const close = () => {
    if (generating) void cancel();
    onClose();
  };

  const generate = async () => {
    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    setGenerating(true);
    setError("");
    setPlan(null);
    const request: AiPresentationRequest = {
      jobId,
      topic: topic.trim(),
      notes: notes.trim(),
      audience: audience.trim(),
      presentationType: presentationType.toLowerCase(),
      slideCount,
      bibleVersion,
      includeSpeakerNotes,
      highlightKeyPoints,
      model,
    };
    try {
      setPlan(await invoke<AiDeckPlan>("ai_generate_presentation", { request }));
    } catch (reason) {
      if (jobIdRef.current === jobId) setError(String(reason));
    } finally {
      if (jobIdRef.current === jobId) {
        jobIdRef.current = null;
        setGenerating(false);
      }
    }
  };

  const useSavedTranscript = async () => {
    if (!savedSessionId) return;
    setError("");
    try {
      const session = await invoke<SavedAiScriptureSession>("ai_session_get", { id: savedSessionId });
      const transcript = savedSessionTranscript(session);
      if (!transcript) {
        setError("That session has no finalized transcript text.");
        return;
      }
      setNotes(transcript.slice(0, 23_000));
      if (transcript.length > 23_000) {
        setError("The saved transcript exceeded the 23,000-character generation limit and was trimmed. Review the ending before generating.");
      }
    } catch (reason) {
      setError(`Could not load the saved transcript: ${reason}`);
    }
  };

  const create = async () => {
    if (!plan) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(compileAiDeckPlan(plan));
      setPlan(null);
      setTopic("");
      setNotes("");
      onClose();
    } catch (reason) {
      setError(`Could not create presentation: ${reason}`);
    } finally {
      setCreating(false);
    }
  };

  const footer = plan ? (
    <>
      <Button variant="ghost" onClick={() => setPlan(null)}>Edit request</Button>
      <Button variant="primary" loading={creating} onClick={() => void create()} icon={<CheckCircle2 size={14} />}>Create editable deck</Button>
    </>
  ) : generating ? (
    <Button variant="ghost" onClick={() => void cancel()} icon={<XCircle size={14} />}>Cancel generation</Button>
  ) : (
    <>
      <Button variant="bare" onClick={close}>Cancel</Button>
      <Button variant="primary" onClick={() => void generate()} disabled={!configured || topic.trim().length < 3 || versions.length === 0} icon={<Sparkles size={14} />}>Generate outline</Button>
    </>
  );

  return (
    <Modal open={open} onClose={close} title="Create presentation with AI" maxWidth="max-w-4xl" footer={footer}>
      <div className="p-4">
        {configured === false && (
          <div className="mb-4 rounded-lg border border-state-warning/40 bg-state-warning/10 p-3 text-xs text-state-warning flex gap-2">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>OpenAI is not configured. Save an API key under <strong>Settings → AI Creation</strong>.</span>
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-state-error/40 bg-state-error/10 p-3 text-xs text-state-error">{error}</div>
        )}

        {plan ? (
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-black text-console-text">{plan.title}</h3>
                <StatusBadge tone="design" label={`${plan.slides.length} slides`} />
              </div>
              {plan.objective && <p className="mt-1 text-xs text-console-text-muted">{plan.objective}</p>}
            </div>
            {plan.warnings.length > 0 && (
              <div className="rounded-lg border border-state-warning/30 bg-state-warning/10 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-state-warning mb-1">Review warnings</p>
                {plan.warnings.map((warning) => <p key={warning} className="text-[11px] text-console-text-muted">• {warning}</p>)}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {plan.slides.map((slide, index) => (
                <article key={`${index}-${slide.title}`} className="rounded-lg border border-console-border bg-console-surface-raised/50 p-3 min-h-28">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-action-primary">{index + 1}. {slide.kind}</span>
                    {slide.scriptures.length > 0 && <BookOpen size={12} className="text-state-success" />}
                  </div>
                  <h4 className="text-sm font-bold text-console-text">{slide.title || slide.quote}</h4>
                  {slide.body && <p className="text-[11px] text-console-text-muted mt-1 line-clamp-3">{slide.body}</p>}
                  {slide.bullets.length > 0 && <ul className="mt-1 text-[11px] text-console-text-muted list-disc ml-4">{slide.bullets.slice(0, 3).map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
                  {slide.scriptures.map((scripture) => <p key={scripture.reference} className="mt-2 text-[10px] font-bold text-state-success">Verified: {canonicalScriptureReference(scripture)}</p>)}
                </article>
              ))}
            </div>
            <p className="text-[10px] text-console-text-subtle">This preview is a draft. Creating it saves a normal editable Studio presentation; it does not Stage or Go Live.</p>
          </div>
        ) : generating ? (
          <div className="py-12 flex flex-col items-center gap-3 text-center">
            <Sparkles size={28} className="text-action-primary animate-pulse" />
            <div><p className="text-sm font-bold text-console-text">Creating a structured outline…</p><p className="text-[10px] text-console-text-subtle mt-1">Wordlyte will validate the response and verify Scripture locally.</p></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-[10px] font-black uppercase tracking-widest text-console-text-muted mb-1">Topic or title</label>
              <input autoFocus value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Faith in times of uncertainty" maxLength={500} className="w-full rounded-lg border border-console-border bg-console-canvas px-3 py-2.5 text-sm text-console-text placeholder:text-console-text-subtle outline-none focus:border-action-primary/60" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] font-black uppercase tracking-widest text-console-text-muted mb-1">Notes or manuscript <span className="font-normal normal-case">(optional)</span></label>
              {savedSessions.length > 0 && (
                <div className="mb-2 flex gap-2 rounded-lg border border-console-border bg-console-surface-raised/40 p-2">
                  <History size={14} className="mt-2 text-violet-400 shrink-0" />
                  <select value={savedSessionId} onChange={(event) => setSavedSessionId(event.target.value)} className="min-w-0 flex-1 rounded-md border border-console-border bg-console-canvas px-2 py-1.5 text-[10px] text-console-text">
                    <option value="">Choose a saved AI Scripture transcript…</option>
                    {savedSessions.map((session) => <option key={session.id} value={session.id}>{session.endedAt == null ? "IN PROGRESS · " : ""}{new Date(session.startedAt).toLocaleString()} · {session.transcriptSegments} segments · {session.suggestions} suggestions</option>)}
                  </select>
                  <Button variant="ghost" onClick={() => void useSavedTranscript()} disabled={!savedSessionId}>Use latest snapshot</Button>
                </div>
              )}
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Paste sermon notes, an outline, or source material…" maxLength={23_000} className="w-full h-40 resize-y rounded-lg border border-console-border bg-console-canvas px-3 py-2.5 text-xs text-console-text placeholder:text-console-text-subtle outline-none focus:border-action-primary/60 custom-scrollbar" />
              <p className="text-right text-[9px] text-console-text-subtle mt-1">{notes.length.toLocaleString()} / 23,000</p>
              {savedSessionId && savedSessions.find((session) => session.id === savedSessionId)?.endedAt == null && <p className="mt-1 text-[9px] text-state-stage">This listening session is still in progress. Use latest snapshot again to include newer finalized speech; an active generation request is never changed silently.</p>}
            </div>
            <Field label="Audience">
              <input value={audience} onChange={(event) => setAudience(event.target.value)} maxLength={150} className={FIELD_CLASS} />
            </Field>
            <Field label="Presentation type">
              <select value={presentationType} onChange={(event) => setPresentationType(event.target.value)} className={FIELD_CLASS}>{PRESENTATION_TYPES.map((type) => <option key={type}>{type}</option>)}</select>
            </Field>
            <Field label="Slides">
              <input type="number" min={3} max={20} value={slideCount} onChange={(event) => setSlideCount(Math.max(3, Math.min(20, Number(event.target.value))))} className={FIELD_CLASS} />
            </Field>
            <Field label="Bible version">
              <select value={bibleVersion} onChange={(event) => setBibleVersion(event.target.value)} className={FIELD_CLASS}>{versions.map((version) => <option key={version}>{version}</option>)}</select>
            </Field>
            <div className="md:col-span-2 flex flex-wrap gap-4 rounded-lg border border-console-border bg-console-surface-raised/30 p-3">
              <label className="flex items-center gap-2 text-xs text-console-text-muted"><input type="checkbox" checked={includeSpeakerNotes} onChange={(event) => setIncludeSpeakerNotes(event.target.checked)} className="accent-action-primary" /> Generate speaker notes</label>
              <label className="flex items-center gap-2 text-xs text-console-text-muted"><input type="checkbox" checked={highlightKeyPoints} onChange={(event) => setHighlightKeyPoints(event.target.checked)} className="accent-action-primary" /> Highlight key phrases</label>
            </div>
            <p className="md:col-span-2 text-[10px] text-console-text-subtle">OpenAI receives the text above only after Generate. Scripture references are checked against the installed {bibleVersion || "Bible"} database, and verse text is loaded locally.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-[10px] font-black uppercase tracking-widest text-console-text-muted mb-1">{label}</span>{children}</label>;
}
