import { useState } from "react";
import { BarChart3, Copy, RotateCcw, ThumbsUp } from "lucide-react";
import { formatLatency } from "../../../ai/scripturePerformance";
import { feedbackReport } from "../../../ai/scriptureFeedback";
import { useAiScripture } from "../../../hooks/useAiScripture";

function Metric({ label, metric }: { label: string; metric: { count: number; p50Ms: number | null; p95Ms: number | null; averageMs: number | null } }) {
  return (
    <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
      <p className="text-[9px] font-black uppercase tracking-wide text-console-text-subtle">{label}</p>
      <p className="mt-1 text-sm font-black text-console-text">{formatLatency(metric.p50Ms)}</p>
      <p className="text-[9px] text-console-text-subtle">95th percentile {formatLatency(metric.p95Ms)} · average {formatLatency(metric.averageMs)} · {metric.count} sample{metric.count === 1 ? "" : "s"}</p>
    </div>
  );
}

function performanceReport(performance: ReturnType<typeof useAiScripture>["performance"]): string {
  const sourceTiming = (label: string, metric: { count: number; p50Ms: number | null; p95Ms: number | null }) => (
    `${label} ${metric.count ? `median ${formatLatency(metric.p50Ms)}, p95 ${formatLatency(metric.p95Ms)} (${metric.count})` : "—"}`
  );
  const lines = [
    "Wordlyte AI Scripture Session Report",
    `Transcription service: ${performance.provider ?? "Not started"}`,
    `Session mode: ${performance.mode ?? "Not started"}`,
    `Session started: ${performance.sessionStartedAt ? new Date(performance.sessionStartedAt).toLocaleString() : "—"}`,
    `Transcript: ${performance.finalTranscriptSegments} finalized turns, ${performance.interimTranscriptUpdates} live updates`,
    `Suggestions: ${performance.suggestions} (references ${performance.suggestionsByDetection.reference}, quotes ${performance.suggestionsByDetection.quote}, themes ${performance.suggestionsByDetection.paraphrase}, commands ${performance.suggestionsByDetection.command})`,
    `Transcription update → suggestion: median ${formatLatency(performance.asrUpdateToDetectionMs.p50Ms)}, p95 ${formatLatency(performance.asrUpdateToDetectionMs.p95Ms)}`,
    `Transcription update → suggestion by source: ${sourceTiming("references", performance.asrUpdateToDetectionByDetection.reference)}; ${sourceTiming("quotes", performance.asrUpdateToDetectionByDetection.quote)}; ${sourceTiming("themes", performance.asrUpdateToDetectionByDetection.paraphrase)}; ${sourceTiming("commands", performance.asrUpdateToDetectionByDetection.command)}`,
    `Suggestion → operator: median ${formatLatency(performance.detectionToOperatorMs.p50Ms)}, p95 ${formatLatency(performance.detectionToOperatorMs.p95Ms)}`,
    `Suggestion → staged: median ${formatLatency(performance.detectionToStageMs.p50Ms)}, p95 ${formatLatency(performance.detectionToStageMs.p95Ms)}`,
    `Suggestion → live: median ${formatLatency(performance.detectionToLiveMs.p50Ms)}, p95 ${formatLatency(performance.detectionToLiveMs.p95Ms)}`,
    `Auto Live → on air: median ${formatLatency(performance.liveCommandMs.p50Ms)}, p95 ${formatLatency(performance.liveCommandMs.p95Ms)}`,
    `Actions: ${performance.staged} staged (${performance.autoStaged} automatic), ${performance.live} live (${performance.autoLive} automatic), ${performance.failedAutoStages} automatic stage failure(s), ${performance.failedAutoLive} automatic live failure(s)`,
    "Timing begins when new transcript text is available and measures Wordlyte's local processing. It excludes speech and speech-recognition time. Live timing ends when the Send Live action succeeds and excludes display rendering and external network delay.",
  ];
  return lines.join("\n");
}

export function AiScripturePerformancePanel() {
  const { performance, clearPerformance } = useAiScripture();
  const [copied, setCopied] = useState(false);
  const [feedbackCopied, setFeedbackCopied] = useState(false);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(performanceReport(performance));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      window.alert("Could not copy the performance report. Clipboard access may be blocked by this device.");
    }
  };

  const copyFeedback = async () => {
    try {
      await navigator.clipboard.writeText(feedbackReport());
      setFeedbackCopied(true);
      window.setTimeout(() => setFeedbackCopied(false), 2_000);
    } catch {
      window.alert("Could not copy suggestion feedback. Clipboard access may be blocked by this device.");
    }
  };

  return (
    <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><BarChart3 size={12} /> AI Scripture insights</p>
          <p className="mt-1 text-[10px] text-console-text-subtle">Live timing and detection totals for the current listening session. Audio and service credentials are never retained. When local retention is enabled, final transcripts and suggestions are saved as reviewable sessions that you can delete or export. Suggestion feedback is stored locally without transcript text.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void copyReport()} className="rounded border border-console-border px-2 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text flex items-center gap-1"><Copy size={10} /> {copied ? "Copied" : "Copy report"}</button>
          <button type="button" onClick={() => void copyFeedback()} title="Copy locally saved suggestion feedback" className="rounded border border-console-border px-2 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text flex items-center gap-1"><ThumbsUp size={10} /> {feedbackCopied ? "Copied" : "Copy feedback"}</button>
          <button type="button" onClick={clearPerformance} className="rounded border border-console-border px-2 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text flex items-center gap-1"><RotateCcw size={10} /> Reset</button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Transcription → suggestion" metric={performance.asrUpdateToDetectionMs} />
        <Metric label="Suggestion → operator" metric={performance.detectionToOperatorMs} />
        <Metric label="Suggestion → staged" metric={performance.detectionToStageMs} />
        <Metric label="Suggestion → live" metric={performance.detectionToLiveMs} />
        <Metric label="Auto Live → on air" metric={performance.liveCommandMs} />
      </div>

      <div className="grid gap-2 text-[10px] text-console-text-subtle sm:grid-cols-2">
        <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
          <p><strong className="text-console-text">Transcription:</strong> {performance.finalTranscriptSegments} finalized turns · {performance.interimTranscriptUpdates} live updates</p>
          <p className="mt-1"><strong className="text-console-text">Suggestions:</strong> {performance.suggestions} total · {performance.suggestionsByDetection.reference} references · {performance.suggestionsByDetection.quote} quotes · {performance.suggestionsByDetection.paraphrase} themes · {performance.suggestionsByDetection.command} commands</p>
          <p className="mt-1"><strong className="text-console-text">Detection timing:</strong> reference {formatLatency(performance.asrUpdateToDetectionByDetection.reference.p50Ms)} ({performance.asrUpdateToDetectionByDetection.reference.count}) · quote {formatLatency(performance.asrUpdateToDetectionByDetection.quote.p50Ms)} ({performance.asrUpdateToDetectionByDetection.quote.count}) · theme {formatLatency(performance.asrUpdateToDetectionByDetection.paraphrase.p50Ms)} ({performance.asrUpdateToDetectionByDetection.paraphrase.count}) · command {formatLatency(performance.asrUpdateToDetectionByDetection.command.p50Ms)} ({performance.asrUpdateToDetectionByDetection.command.count})</p>
        </div>
        <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
          <p><strong className="text-console-text">Actions:</strong> {performance.staged} staged ({performance.autoStaged} automatic) · {performance.live} live ({performance.autoLive} automatic)</p>
          <p className={`mt-1 ${performance.failedAutoStages + performance.failedAutoLive > 0 ? "text-state-error" : ""}`}><strong className="text-console-text">Automation failures:</strong> {performance.failedAutoStages} stage · {performance.failedAutoLive} live</p>
        </div>
      </div>
      <p className="text-[9px] text-console-text-subtle">{performance.sessionStartedAt ? `Current ${performance.mode ?? "service"} session · started ${new Date(performance.sessionStartedAt).toLocaleTimeString()}.` : "Start listening to collect session insights."} Timing begins when new transcript text is available and measures Wordlyte's local processing. It does not include speech or speech-recognition time. Live timing ends when the Send Live action succeeds; display rendering and external network delay are not included.</p>
    </section>
  );
}
