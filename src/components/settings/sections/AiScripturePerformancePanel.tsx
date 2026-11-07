import { useState } from "react";
import { BarChart3, Copy, RotateCcw } from "lucide-react";
import { formatLatency } from "../../../ai/scripturePerformance";
import { useAiScripture } from "../../../hooks/useAiScripture";

function Metric({ label, metric }: { label: string; metric: { count: number; p50Ms: number | null; p95Ms: number | null; averageMs: number | null } }) {
  return (
    <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
      <p className="text-[9px] font-black uppercase tracking-wide text-console-text-subtle">{label}</p>
      <p className="mt-1 text-sm font-black text-console-text">{formatLatency(metric.p50Ms)}</p>
      <p className="text-[9px] text-console-text-subtle">p95 {formatLatency(metric.p95Ms)} · avg {formatLatency(metric.averageMs)} · {metric.count} sample{metric.count === 1 ? "" : "s"}</p>
    </div>
  );
}

function performanceReport(performance: ReturnType<typeof useAiScripture>["performance"]): string {
  const sourceTiming = (label: string, metric: { count: number; p50Ms: number | null; p95Ms: number | null }) => (
    `${label} ${metric.count ? `median ${formatLatency(metric.p50Ms)}, p95 ${formatLatency(metric.p95Ms)} (${metric.count})` : "—"}`
  );
  const lines = [
    "Wordlyte AI Scripture Performance Report",
    `Provider: ${performance.provider ?? "Not started"}`,
    `Listening mode: ${performance.mode ?? "Not started"}`,
    `Session started: ${performance.sessionStartedAt ? new Date(performance.sessionStartedAt).toLocaleString() : "—"}`,
    `Transcript: ${performance.finalTranscriptSegments} final segments, ${performance.interimTranscriptUpdates} interim updates`,
    `Suggestions: ${performance.suggestions} (references ${performance.suggestionsByDetection.reference}, quotes ${performance.suggestionsByDetection.quote}, paraphrases ${performance.suggestionsByDetection.paraphrase}, commands ${performance.suggestionsByDetection.command})`,
    `ASR update → verified Scripture: median ${formatLatency(performance.asrUpdateToDetectionMs.p50Ms)}, p95 ${formatLatency(performance.asrUpdateToDetectionMs.p95Ms)}`,
    `ASR update → verified by source: ${sourceTiming("references", performance.asrUpdateToDetectionByDetection.reference)}; ${sourceTiming("quotes", performance.asrUpdateToDetectionByDetection.quote)}; ${sourceTiming("themes", performance.asrUpdateToDetectionByDetection.paraphrase)}; ${sourceTiming("commands", performance.asrUpdateToDetectionByDetection.command)}`,
    `Verified Scripture → operator UI: median ${formatLatency(performance.detectionToOperatorMs.p50Ms)}, p95 ${formatLatency(performance.detectionToOperatorMs.p95Ms)}`,
    `Detected → staged: median ${formatLatency(performance.detectionToStageMs.p50Ms)}, p95 ${formatLatency(performance.detectionToStageMs.p95Ms)}`,
    `Detected → live committed: median ${formatLatency(performance.detectionToLiveMs.p50Ms)}, p95 ${formatLatency(performance.detectionToLiveMs.p95Ms)}`,
    `Auto Live request → acknowledgement: median ${formatLatency(performance.liveCommandMs.p50Ms)}, p95 ${formatLatency(performance.liveCommandMs.p95Ms)}`,
    `Actions: ${performance.staged} staged (${performance.autoStaged} automatic), ${performance.live} live (${performance.autoLive} automatic), ${performance.failedAutoStages} Auto Stage failure(s), ${performance.failedAutoLive} Auto Live failure(s)`,
    "ASR update → verified Scripture measures the local verification work after the transcription provider sends an interim/final update; it excludes speech duration and provider recognition latency. Live committed ends at acknowledgement of Wordlyte’s atomic Send Live command and excludes output-display rendering and downstream stream/CDN delay.",
  ];
  return lines.join("\n");
}

export function AiScripturePerformancePanel() {
  const { performance, clearPerformance } = useAiScripture();
  const [copied, setCopied] = useState(false);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(performanceReport(performance));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      window.alert("Could not copy the performance report. Clipboard access may be blocked by this device.");
    }
  };

  return (
    <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><BarChart3 size={12} /> AI Scripture Performance</p>
          <p className="mt-1 text-[10px] text-console-text-subtle">Local measurements for qualification and customer demos. Service restarts and repeat Operator calls accumulate here until Reset; a provider or mode change starts a fresh set. Audio and credentials are not retained. Final transcripts and suggestion records are saved locally as reviewable sessions and can be deleted or exported from AI Scripture.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void copyReport()} className="rounded border border-console-border px-2 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text flex items-center gap-1"><Copy size={10} /> {copied ? "Copied" : "Copy report"}</button>
          <button type="button" onClick={clearPerformance} className="rounded border border-console-border px-2 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text flex items-center gap-1"><RotateCcw size={10} /> Reset</button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="ASR update → verified" metric={performance.asrUpdateToDetectionMs} />
        <Metric label="Verified → operator UI" metric={performance.detectionToOperatorMs} />
        <Metric label="Verified → staged" metric={performance.detectionToStageMs} />
        <Metric label="Verified → live committed" metric={performance.detectionToLiveMs} />
        <Metric label="Auto Live request → ack" metric={performance.liveCommandMs} />
      </div>

      <div className="grid gap-2 text-[10px] text-console-text-subtle sm:grid-cols-2">
        <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
          <p><strong className="text-console-text">ASR activity:</strong> {performance.finalTranscriptSegments} final segments · {performance.interimTranscriptUpdates} interim updates</p>
          <p className="mt-1"><strong className="text-console-text">Suggestions:</strong> {performance.suggestions} total · {performance.suggestionsByDetection.reference} references · {performance.suggestionsByDetection.quote} quotes · {performance.suggestionsByDetection.paraphrase} themes · {performance.suggestionsByDetection.command} commands</p>
          <p className="mt-1"><strong className="text-console-text">ASR → verified:</strong> reference {formatLatency(performance.asrUpdateToDetectionByDetection.reference.p50Ms)} ({performance.asrUpdateToDetectionByDetection.reference.count}) · quote {formatLatency(performance.asrUpdateToDetectionByDetection.quote.p50Ms)} ({performance.asrUpdateToDetectionByDetection.quote.count}) · theme {formatLatency(performance.asrUpdateToDetectionByDetection.paraphrase.p50Ms)} ({performance.asrUpdateToDetectionByDetection.paraphrase.count}) · command {formatLatency(performance.asrUpdateToDetectionByDetection.command.p50Ms)} ({performance.asrUpdateToDetectionByDetection.command.count})</p>
        </div>
        <div className="rounded-md border border-console-border bg-console-surface px-2.5 py-2">
          <p><strong className="text-console-text">Actions:</strong> {performance.staged} staged ({performance.autoStaged} automatic) · {performance.live} live ({performance.autoLive} automatic)</p>
          <p className={`mt-1 ${performance.failedAutoStages + performance.failedAutoLive > 0 ? "text-state-error" : ""}`}><strong className="text-console-text">Automation failures:</strong> {performance.failedAutoStages} stage · {performance.failedAutoLive} live</p>
        </div>
      </div>
      <p className="text-[9px] text-console-text-subtle">{performance.sessionStartedAt ? `Current ${performance.mode ?? "service"} measurement set: ${performance.provider === "assemblyai" ? "AssemblyAI" : "Deepgram"} · started ${new Date(performance.sessionStartedAt).toLocaleTimeString()}.` : "Start listening to begin a measurement set."} ASR → verified begins after the provider sends an interim/final update; it does not include speech or provider-recognition time. Live committed ends when Wordlyte’s atomic Send Live command succeeds; display rendering and external stream/CDN delay are not included.</p>
    </section>
  );
}
