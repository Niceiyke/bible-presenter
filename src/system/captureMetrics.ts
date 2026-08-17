/**
 * Capture-loop metrics singleton (Phase 7).
 *
 * `useCanvasCapture` calls `markCaptureFrame()` once per drawn frame; the
 * Diagnostics workspace reads a rolling FPS estimate via `readCaptureFps()`
 * so the operator can see whether the compositor is keeping up with its target
 * frame rate. Frame counters accumulate at ~1s granularity; nothing runs on a
 * timer here (the capture loop drives the ticks).
 */

let frameCount = 0;
let lastPush = 0;
const samples: { t: number; n: number }[] = [];

/** Call once per composited frame. Cheap — no allocation beyond the 1s tick. */
export function markCaptureFrame(): void {
  frameCount += 1;
  const now = performance.now();
  if (now - lastPush >= 1000) {
    lastPush = now;
    samples.push({ t: now, n: frameCount });
    if (samples.length > 60) samples.shift();
  }
}

/** Rolling frames-per-second over the last `windowMs`. 0 until two samples. */
export function readCaptureFps(windowMs = 3000): number {
  const now = performance.now();
  while (samples.length > 2 && now - samples[0].t > windowMs) samples.shift();
  if (samples.length < 2) return 0;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  return (b.n - a.n) / dt;
}

/** Reset counters (tests / capture restarts). */
export function resetCaptureMetrics(): void {
  frameCount = 0;
  lastPush = 0;
  samples.length = 0;
}