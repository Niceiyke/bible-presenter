import { useCallback, useEffect, useRef, useState } from "react";

/**
 * `useCanvasCapture` — drives a `canvas.captureStream()`-backed compositor
 * loop (Phase 2 of the output manager).
 *
 * The hook owns a `requestAnimationFrame` loop that calls a per-frame draw
 * callback on the canvas context at a configurable FPS, and exposes the
 * resulting `MediaStream` for recorder/streamer surfaces. It is a thin,
 * window-agnostic primitive: the actual rasterization is delegated to the
 * draw callback (typically `drawProgramFrame` from the canvas compositor).
 */
export interface UseCanvasCaptureOptions {
  /** Target capture frame rate. `captureStream` records at this cadence;
   *  the draw loop throttles itself so expensive compositing isn't wasted
   *  on frames nobody will see. */
  fps?: number;
  /** Whether to start the loop + stream immediately on mount. */
  autoStart?: boolean;
}

/** Draws one composited frame. Receives the live 2D context plus the
 *  canvas pixel dimensions (already device-pixel-ratio-scaled). */
export type DrawFrame = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

export interface CanvasCaptureHandle {
  /** The canvas the compositor draws into. Attach to a ref on a
   *  `<canvas>` element the host renders (or an offscreen canvas). */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** The live `MediaStream` produced by `captureStream`. `null` until
   *  the loop is running. */
  stream: MediaStream | null;
  /** Whether the capture loop is currently running. */
  running: boolean;
  /** Start (or restart) the capture loop + stream. Idempotent. */
  start: () => void;
  /** Stop the loop and stop the stream's tracks. Idempotent. */
  stop: () => void;
  /** Register the per-frame draw callback. Set once on mount; the callback
   *  reads fresh state from a ref so it never needs re-registering. */
  setDraw: (fn: DrawFrame) => void;
}

export function useCanvasCapture(options: UseCanvasCaptureOptions = {}): CanvasCaptureHandle {
  const { fps = 30, autoStart = true } = options;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef<DrawFrame | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const fpsRef = useRef(fps);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  useEffect(() => {
    fpsRef.current = fps;
  }, [fps]);

  const setDraw = useCallback((fn: DrawFrame) => {
    drawRef.current = fn;
  }, []);

  const loop = (time: number) => {
    if (!runningRef.current) return;
    const canvas = canvasRef.current;
    if (canvas) {
      const interval = 1000 / fpsRef.current;
      if (time - lastFrameRef.current >= interval) {
        lastFrameRef.current = time;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawRef.current?.(ctx, canvas.width, canvas.height);
        }
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  const start = useCallback(() => {
    if (runningRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    runningRef.current = true;
    setRunning(true);
    lastFrameRef.current = 0;
    // `captureStream` is available on HTMLCanvasElement in WebView2/Chromium.
    if (typeof canvas.captureStream === "function") {
      const s = canvas.captureStream(fpsRef.current);
      streamRef.current = s;
      setStream(s);
    }
    rafRef.current = requestAnimationFrame(loop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const s = streamRef.current;
    streamRef.current = null;
    setStream(null);
    if (s) s.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    if (autoStart) start();
    return () => stop();
  }, [autoStart, start, stop]);

  return {
    canvasRef,
    stream,
    running,
    start,
    stop,
    setDraw,
  };
}