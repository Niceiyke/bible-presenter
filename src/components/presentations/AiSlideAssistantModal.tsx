import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Sparkles, XCircle } from "lucide-react";
import {
  editedSlideVisibleText,
  type AiSlideEditAction,
  type AiSlideEditRequest,
  type AiSlideEditResult,
} from "../../ai/presentations";
import { Button, Modal } from "../ui";

const ACTION_LABELS: Record<AiSlideEditAction, string> = {
  shorten: "Shorten for projection",
  rewrite: "Rewrite clearly",
  bullets: "Convert to bullets",
  highlight: "Highlight key phrases",
  "speaker-notes": "Generate speaker notes",
  "regenerate-slide": "Regenerate this slide",
};

interface AiSlideAssistantModalProps {
  action: AiSlideEditAction | null;
  content: string;
  slideContext: string;
  presentationTitle: string;
  bibleVersion: string;
  onClose: () => void;
  onApply: (result: AiSlideEditResult) => void;
}

export function AiSlideAssistantModal({
  action,
  content,
  slideContext,
  presentationTitle,
  bibleVersion,
  onClose,
  onApply,
}: AiSlideAssistantModalProps) {
  const [result, setResult] = useState<AiSlideEditResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError("");
    setGenerating(false);
    jobIdRef.current = null;
  }, [action]);

  const before = useMemo(() => content.trim() || slideContext.trim(), [content, slideContext]);
  const after = useMemo(() => {
    if (!result || !action) return "";
    return action === "speaker-notes"
      ? result.slide.speakerNotes
      : editedSlideVisibleText(result.slide);
  }, [action, result]);

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
    if (!action) return;
    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    setGenerating(true);
    setError("");
    setResult(null);
    const request: AiSlideEditRequest = {
      jobId,
      action,
      content,
      slideContext,
      presentationTitle,
      bibleVersion,
      model: localStorage.getItem("pref_aiPresentationModel") || "gpt-6-astra",
    };
    try {
      const generated = await invoke<AiSlideEditResult>("ai_edit_presentation_slide", { request });
      if (jobIdRef.current === jobId) setResult(generated);
    } catch (reason) {
      if (jobIdRef.current === jobId) setError(String(reason));
    } finally {
      if (jobIdRef.current === jobId) {
        jobIdRef.current = null;
        setGenerating(false);
      }
    }
  };

  const apply = () => {
    if (!result) return;
    onApply(result);
    onClose();
  };

  if (!action) return null;
  const title = ACTION_LABELS[action];
  const footer = generating ? (
    <Button variant="ghost" onClick={() => void cancel()} icon={<XCircle size={14} />}>Cancel request</Button>
  ) : result ? (
    <>
      <Button variant="ghost" onClick={() => void generate()}>Regenerate preview</Button>
      <Button variant="primary" onClick={apply} icon={<CheckCircle2 size={14} />}>Apply change</Button>
    </>
  ) : (
    <>
      <Button variant="bare" onClick={close}>Cancel</Button>
      <Button variant="primary" onClick={() => void generate()} icon={<Sparkles size={14} />}>Generate preview</Button>
    </>
  );

  return (
    <Modal open onClose={close} title={`AI · ${title}`} maxWidth="max-w-3xl" footer={footer}>
      <div className="p-4 flex flex-col gap-4">
        {error && <div className="rounded-lg border border-state-error/40 bg-state-error/10 p-3 text-xs text-state-error">{error}</div>}
        {result?.warnings.length ? (
          <div className="rounded-lg border border-state-warning/40 bg-state-warning/10 p-3">
            {result.warnings.map((warning) => <p key={warning} className="text-[10px] text-state-warning flex gap-1.5"><AlertTriangle size={12} className="shrink-0" />{warning}</p>)}
          </div>
        ) : null}

        {generating ? (
          <div className="py-12 flex flex-col items-center gap-3 text-center">
            <Sparkles size={28} className="text-action-primary animate-pulse" />
            <p className="text-sm font-bold text-console-text">Preparing an editable preview…</p>
            <p className="text-[10px] text-console-text-subtle">Nothing is changed until you select Apply change.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <PreviewPanel label="Current" text={before} />
            <PreviewPanel label="AI preview" text={after} empty="Select Generate preview to create a suggestion." />
          </div>
        )}
        <p className="text-[10px] text-console-text-subtle">Applying this preview creates one normal Undo step. It never stages the slide or changes live output.</p>
      </div>
    </Modal>
  );
}

function PreviewPanel({ label, text, empty = "No text available." }: { label: string; text: string; empty?: string }) {
  return (
    <section className="rounded-xl border border-console-border bg-console-canvas/50 p-3 min-h-44">
      <p className="text-[9px] font-black uppercase tracking-widest text-console-text-subtle mb-2">{label}</p>
      <div className="whitespace-pre-wrap text-xs leading-relaxed text-console-text-muted">{text || <span className="italic text-console-text-subtle">{empty}</span>}</div>
    </section>
  );
}
