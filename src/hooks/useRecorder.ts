import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * `useRecorder` — MediaRecorder wrapper for the output-manager recorder
 * surface (Phase 3).
 *
 * Consumes a live `MediaStream` (the `ProgramFeedCanvas` compositor's
 * `captureStream()`), records WebM chunks, and on stop persists the assembled
 * blob to the app-data `recordings/` dir via the `recording_save` command.
 *
 * The hook is window-agnostic and unit-testable: the MediaRecorder is created
 * lazily on start so callers can hand it a stream that only exists after the
 * compositor starts running.
 */
export interface UseRecorderOptions {
  /** Preferred MIME type; falls back to whatever the browser supports. */
  mimeType?: string;
  /** Chunk cadence ms for `timeslice` (0 = only on stop). */
  timeslice?: number;
}

export interface UseRecorderResult {
  /** True while a recording is in progress. */
  recording: boolean;
  /** Recorded duration in seconds so far. */
  elapsed: number;
  /** The last saved file name (after a completed save). */
  lastSaved: string | null;
  /** Save error from the last attempt. */
  error: string | null;
  /** Start recording the given stream. No-op if already recording. */
  start: (stream: MediaStream, suggestedName?: string) => Promise<void>;
  /** Stop recording and persist the WebM blob. */
  stop: () => Promise<string | null>;
  /** Abort without saving. */
  cancel: () => void;
}

/// Documented maximum recording size — must match the backend `recording_save`
/// cap. Refusing here (before the base64 conversion) avoids an out-of-memory
/// spike on an oversized blob that would be rejected anyway.
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/// Pure validation shared by `stop()` and unit tests: returns a user-facing
/// error when a blob should not be saved, else null.
export function recordingSizeError(blobSize: number): string | null {
  if (blobSize === 0) return "Recorder captured no frames (empty stream?).";
  if (blobSize > MAX_RECORDING_BYTES) {
    return "Recording exceeds the 2 GiB limit — split the recording into shorter segments.";
  }
  return null;
}

function defaultFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `recording-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.webm`;
}

function pickMimeType(preferred?: string): string {
  if (typeof MediaRecorder === "undefined") return "";
  if (preferred && MediaRecorder.isTypeSupported(preferred)) return preferred;
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string | null;
      if (!result) return reject(new Error("Empty recording data"));
      // Strip the "data:video/webm;base64," prefix if present.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Blob read failed"));
    reader.readAsDataURL(blob);
  });
}

export function useRecorder(options: UseRecorderOptions = {}): UseRecorderResult {
  const { mimeType, timeslice = 1000 } = options;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const fileNameRef = useRef<string>("");
  const startTimeRef = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current = null;
    setRecording(false);
    setElapsed(0);
    clearTimer();
  }, [clearTimer]);

  const start = useCallback(
    async (stream: MediaStream, suggestedName?: string) => {
      if (recorderRef.current) return;
      if (typeof MediaRecorder === "undefined") {
        setError("MediaRecorder is not available in this webview.");
        return;
      }
      try {
        const mime = pickMimeType(mimeType);
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recorderRef.current = rec;
        streamRef.current = stream;
        chunksRef.current = [];
        fileNameRef.current = suggestedName || defaultFileName();
        setError(null);

        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          // Persist is driven by `stop()` after collecting final chunks.
        };

        rec.start(timeslice);
        startTimeRef.current = Date.now();
        setRecording(true);
        setElapsed(0);
        clearTimer();
        timerRef.current = setInterval(() => {
          setElapsed((Date.now() - startTimeRef.current) / 1000);
        }, 500);
      } catch (e: any) {
        setError(`Failed to start recorder: ${e?.message ?? e}`);
        recorderRef.current = null;
      }
    },
    [mimeType, timeslice, clearTimer]
  );

  const stop = useCallback(async (): Promise<string | null> => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return null;
    clearTimer();

    // `ondataavailable` already collects chunks (including the final one
    // that MediaRecorder emits on stop). Await the stop event, then assemble.
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    await stopped;

    const finalChunks = chunksRef.current;
    const type = rec.mimeType || "video/webm";
    const blob = new Blob(finalChunks, { type });
    const name = fileNameRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current = null;
    setRecording(false);
    setElapsed(0);

    const sizeError = recordingSizeError(blob.size);
    if (sizeError) {
      setError(sizeError);
      return null;
    }

    try {
      const base64 = await blobToBase64(blob);
      const saved = await invoke<{ name: string; size: number; modified: number }>(
        "recording_save",
        { fileName: name, dataBase64: base64 }
      );
      setLastSaved(saved.name);
      setError(null);
      return saved.name;
    } catch (e: any) {
      setError(`Failed to save recording: ${e?.message ?? e}`);
      return null;
    }
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { recording, elapsed, lastSaved, error, start, stop, cancel };
}