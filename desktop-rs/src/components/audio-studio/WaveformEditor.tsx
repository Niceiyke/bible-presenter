import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  Play, Pause, Scissors, RefreshCw, RotateCcw,
  ZoomIn, ZoomOut, Trash2, Check, X, Edit2, AlertTriangle,
  SkipBack, SkipForward, ListEnd, ListStart,
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { useAppStore } from "../../store";

const WAVEFORM_SIZE_LIMIT_MB = 80;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const b64 = await invoke<string>("read_file_base64", { path: filePath });
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBlobUrl(bytes: Uint8Array): string {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

async function fetchRecordingPeaks(id: string): Promise<{ peaks: number[][]; duration: number }> {
  const result = await invoke<{ peaks: number[]; duration: number }>(
    "get_recording_peaks",
    { id, nPeaks: 1000 },
  );
  return { peaks: [result.peaks], duration: result.duration };
}

function parseWavBytes(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 12;
    let sampleRate = 16000;
    let bitsPerSample = 16;
    let numChannels = 1;
    let dataStart = 0;
    let dataSize = 0;

    while (pos + 8 <= bytes.length) {
      const id =
        String.fromCharCode(bytes[pos]) +
        String.fromCharCode(bytes[pos + 1]) +
        String.fromCharCode(bytes[pos + 2]) +
        String.fromCharCode(bytes[pos + 3]);
      const chunkSize = view.getUint32(pos + 4, true);
      if (id === "fmt ") {
        numChannels   = view.getUint16(pos + 10, true);
        sampleRate    = view.getUint32(pos + 12, true);
        bitsPerSample = view.getUint16(pos + 22, true);
      } else if (id === "data") {
        dataStart = pos + 8;
        dataSize  = Math.min(chunkSize, bytes.length - dataStart);
        break;
      }
      pos += 8 + chunkSize + (chunkSize & 1);
    }

    if (!dataStart || !dataSize) return null;

    const bytesPerSample = bitsPerSample / 8;
    const totalFrames    = Math.floor(dataSize / (numChannels * bytesPerSample));
    const mono           = new Float32Array(new ArrayBuffer(totalFrames * 4));

    for (let i = 0; i < totalFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const off = dataStart + (i * numChannels + ch) * bytesPerSample;
        sum +=
          bitsPerSample === 16
            ? view.getInt16(off, true) / 32768.0
            : view.getFloat32(off, true);
      }
      mono[i] = sum / numChannels;
    }

    return { samples: mono, sampleRate };
  } catch {
    return null;
  }
}

/** Format seconds as M:SS.ss */
function fmtTimeFull(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Format seconds as M:SS for display */
function fmtTime(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

/** Parse "M:SS.ss" or "S.ss" → seconds, returns NaN on failure */
function parseTime(s: string): number {
  const trimmed = s.trim();
  if (trimmed.includes(":")) {
    const [mStr, sStr] = trimmed.split(":");
    const m = parseInt(mStr, 10);
    const sec = parseFloat(sStr);
    if (isNaN(m) || isNaN(sec)) return NaN;
    return m * 60 + sec;
  }
  return parseFloat(trimmed);
}

// ── Component ────────────────────────────────────────────────────────────────

export function WaveformEditor() {
  const {
    selectedRecording,
    setSelectedRecording,
    fetchRecordings,
    handleRenameRecording,
    isTrimming,
    setIsTrimming,
    handleDeleteRecording,
    setError,
  } = useAppStore();

  const [isPlaying, setIsPlaying]               = useState(false);
  const [isWaveformLoading, setIsWaveformLoading] = useState(false);
  const [isRenaming, setIsRenaming]             = useState(false);
  const [renameValue, setRenameValue]           = useState("");
  const [zoomLevel, setZoomLevel]               = useState(0);
  const [duration, setDuration]                 = useState(0);
  const [currentTime, setCurrentTime]           = useState(0);
  const [showSaveAs, setShowSaveAs]             = useState(false);
  const [saveAsName, setSaveAsName]             = useState("");

  // In/out point state (seconds)
  const [inPoint, setInPoint]   = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  // Controlled input strings (so user can type freely)
  const [inStr, setInStr]   = useState("0:00.00");
  const [outStr, setOutStr] = useState("0:00.00");

  // Fade in/out (seconds)
  const [fadeIn, setFadeIn]   = useState(0);
  const [fadeOut, setFadeOut] = useState(0);

  // WaveSurfer refs
  const wavesurferRef  = useRef<HTMLDivElement>(null);
  const wsInstance     = useRef<WaveSurfer | null>(null);
  const regionsRef     = useRef<any>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Large-file fallback
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef  = useRef<string | null>(null);

  // Web Audio API playback
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const audioBufferRef    = useRef<AudioBuffer | null>(null);
  const sourceNodeRef     = useRef<AudioBufferSourceNode | null>(null);
  const playOffsetRef     = useRef<number>(0);
  const playStartCtxRef   = useRef<number>(0);
  const rafRef            = useRef<number | null>(null);
  const isPlayingRef      = useRef<boolean>(false);

  const isLargeFile = (selectedRecording?.size_mb ?? 0) > WAVEFORM_SIZE_LIMIT_MB;

  // ── Web Audio playback helpers ──────────────────────────────────────────

  const stopCursorRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const stopSource = useCallback(() => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch { /* already stopped */ }
      sourceNodeRef.current.onended = null;
      sourceNodeRef.current = null;
    }
  }, []);

  const startPlaybackFrom = useCallback((offset: number, stopAt?: number) => {
    const ctx = audioCtxRef.current;
    const buf = audioBufferRef.current;
    if (!ctx || !buf) return;

    stopSource();
    stopCursorRaf();

    const clampedOffset = Math.min(Math.max(offset, 0), buf.duration - 0.001);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    // If stopAt is provided, play only that segment
    const playDuration = stopAt !== undefined ? Math.max(0, stopAt - clampedOffset) : undefined;
    src.start(0, clampedOffset, playDuration);

    src.onended = () => {
      stopCursorRaf();
      isPlayingRef.current = false;
      setIsPlaying(false);
      if (stopAt !== undefined) {
        // Selection playback ended — park cursor at region start
        const region = regionsRef.current?.getRegions()[0];
        const resetPos = region?.start ?? 0;
        playOffsetRef.current = resetPos;
        setCurrentTime(resetPos);
        if (wsInstance.current) wsInstance.current.seekTo(resetPos / buf.duration);
      } else {
        playOffsetRef.current = 0;
        setCurrentTime(0);
        if (wsInstance.current) wsInstance.current.seekTo(0);
      }
    };

    sourceNodeRef.current = src;
    playStartCtxRef.current = ctx.currentTime - clampedOffset;
    isPlayingRef.current = true;
    setIsPlaying(true);

    const endTime = stopAt !== undefined ? stopAt : buf.duration;
    const tick = () => {
      const t = Math.min(ctx.currentTime - playStartCtxRef.current, endTime);
      setCurrentTime(t);
      if (wsInstance.current) wsInstance.current.seekTo(t / buf.duration);
      if (isPlayingRef.current) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopSource, stopCursorRaf]);

  const handlePlayPause = useCallback(() => {
    if (!audioCtxRef.current || !audioBufferRef.current) return;
    if (isPlayingRef.current) {
      const elapsed = audioCtxRef.current.currentTime - playStartCtxRef.current;
      playOffsetRef.current = Math.min(elapsed, audioBufferRef.current.duration);
      stopSource();
      stopCursorRaf();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      startPlaybackFrom(playOffsetRef.current);
    }
  }, [stopSource, stopCursorRaf, startPlaybackFrom]);

  // Play only the selected region
  const handlePlaySelection = useCallback(() => {
    const region = regionsRef.current?.getRegions()[0];
    if (!region || !audioBufferRef.current) return;
    if (isPlayingRef.current) {
      // Pause if already playing
      const elapsed = audioCtxRef.current!.currentTime - playStartCtxRef.current;
      playOffsetRef.current = Math.min(elapsed, audioBufferRef.current.duration);
      stopSource();
      stopCursorRaf();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      playOffsetRef.current = region.start;
      startPlaybackFrom(region.start, region.end);
    }
  }, [stopSource, stopCursorRaf, startPlaybackFrom]);

  // Set in/out from playhead
  const handleSetIn = useCallback(() => {
    const region = regionsRef.current?.getRegions()[0];
    if (!region) return;
    const pos = Math.max(0, Math.min(playOffsetRef.current, region.end - 0.1));
    region.setOptions({ start: pos });
    setInPoint(pos);
    setInStr(fmtTimeFull(pos));
  }, []);

  const handleSetOut = useCallback(() => {
    const region = regionsRef.current?.getRegions()[0];
    if (!region) return;
    const maxDur = audioBufferRef.current?.duration ?? Infinity;
    const pos = Math.max(region.start + 0.1, Math.min(playOffsetRef.current, maxDur));
    region.setOptions({ end: pos });
    setOutPoint(pos);
    setOutStr(fmtTimeFull(pos));
  }, []);

  const handleResetSelection = useCallback(() => {
    const region = regionsRef.current?.getRegions()[0];
    if (!region) return;
    const d = audioBufferRef.current?.duration ?? duration;
    region.setOptions({ start: 0, end: d });
    setInPoint(0);
    setOutPoint(d);
    setInStr(fmtTimeFull(0));
    setOutStr(fmtTimeFull(d));
  }, [duration]);

  // Apply typed in-point
  const applyInStr = useCallback(() => {
    const secs = parseTime(inStr);
    if (isNaN(secs)) { setInStr(fmtTimeFull(inPoint)); return; }
    const region = regionsRef.current?.getRegions()[0];
    if (!region) return;
    const clamped = Math.max(0, Math.min(secs, region.end - 0.01));
    region.setOptions({ start: clamped });
    setInPoint(clamped);
    setInStr(fmtTimeFull(clamped));
  }, [inStr, inPoint]);

  // Apply typed out-point
  const applyOutStr = useCallback(() => {
    const secs = parseTime(outStr);
    if (isNaN(secs)) { setOutStr(fmtTimeFull(outPoint)); return; }
    const region = regionsRef.current?.getRegions()[0];
    if (!region) return;
    const maxDur = audioBufferRef.current?.duration ?? duration;
    const clamped = Math.max(region.start + 0.01, Math.min(secs, maxDur));
    region.setOptions({ end: clamped });
    setOutPoint(clamped);
    setOutStr(fmtTimeFull(clamped));
  }, [outStr, outPoint, duration]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedRecording || isLargeFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space")   { e.preventDefault(); handlePlayPause(); }
      if (e.code === "KeyI")    { e.preventDefault(); handleSetIn(); }
      if (e.code === "KeyO")    { e.preventDefault(); handleSetOut(); }
      if (e.code === "Escape")  { e.preventDefault(); handleResetSelection(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRecording, isLargeFile, handlePlayPause, handleSetIn, handleSetOut, handleResetSelection]);

  // ── WaveSurfer + AudioBuffer init ───────────────────────────────────────

  useEffect(() => {
    if (!wavesurferRef.current || !selectedRecording?.path || isLargeFile) return;

    const container = wavesurferRef.current;
    const filePath  = selectedRecording.path;
    const recId     = selectedRecording.id;
    let cancelled   = false;

    if (wsInstance.current) { wsInstance.current.destroy(); wsInstance.current = null; }
    stopSource();
    stopCursorRaf();
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    audioBufferRef.current  = null;
    playOffsetRef.current   = 0;
    isPlayingRef.current    = false;
    setIsPlaying(false);
    setCurrentTime(0);
    setInPoint(0);
    setOutPoint(0);
    setInStr("0:00.00");
    setOutStr("0:00.00");
    setFadeIn(0);
    setFadeOut(0);

    initTimeoutRef.current = setTimeout(() => {
      if (cancelled || !container) return;
      setIsWaveformLoading(true);

      (async () => {
        let bytes: Uint8Array;
        try {
          bytes = await readFileBytes(filePath);
          if (cancelled) return;
        } catch (e) {
          if (!cancelled) {
            console.error("Failed to read audio file:", e);
            setIsWaveformLoading(false);
            setError("Could not read audio file from disk.");
          }
          return;
        }

        let peaksData: { peaks: number[][]; duration: number } | null = null;
        try {
          peaksData = await fetchRecordingPeaks(recId);
          if (cancelled) return;
        } catch (e) {
          console.warn("get_recording_peaks failed:", e);
        }

        const parsed = parseWavBytes(bytes);
        if (parsed && !cancelled) {
          try {
            const ctx = new AudioContext({ sampleRate: parsed.sampleRate });
            if (cancelled) { ctx.close(); return; }
            audioCtxRef.current = ctx;
            const buf = ctx.createBuffer(1, parsed.samples.length, parsed.sampleRate);
            buf.copyToChannel(parsed.samples as Float32Array<ArrayBuffer>, 0);
            audioBufferRef.current = buf;
          } catch (e) {
            console.warn("AudioBuffer creation failed:", e);
          }
        }

        try {
          const regions = RegionsPlugin.create();
          if (cancelled) return;
          regionsRef.current = regions;

          const dur = peaksData?.duration ?? audioBufferRef.current?.duration ?? 0;
          const wsOpts: Parameters<typeof WaveSurfer.create>[0] = {
            container,
            waveColor: "#f59e0b",
            progressColor: "#d97706",
            cursorColor: "#fbbf24",
            barWidth: 2,
            barRadius: 2,
            height: 90,
            plugins: [regions],
            ...(peaksData
              ? { peaks: peaksData.peaks, duration: peaksData.duration }
              : { peaks: [[0]], duration: dur }),
          };

          const ws = WaveSurfer.create(wsOpts);

          ws.on("ready", () => {
            if (cancelled) return;
            setIsWaveformLoading(false);
            const d = ws.getDuration();
            setDuration(d);
            setOutPoint(d);
            setOutStr(fmtTimeFull(d));

            const region = regions.addRegion({
              start: 0,
              end: d,
              color: "rgba(245,158,11,0.12)",
              drag: true,
              resize: true,
            });

            // Keep in/out state in sync when user drags region handles
            regions.on("region-updated", (r: any) => {
              if (cancelled) return;
              setInPoint(r.start);
              setOutPoint(r.end);
              setInStr(fmtTimeFull(r.start));
              setOutStr(fmtTimeFull(r.end));
            });
          });

          ws.on("interaction", (newTime: number) => {
            if (cancelled) return;
            playOffsetRef.current = newTime;
            setCurrentTime(newTime);
            if (isPlayingRef.current) startPlaybackFrom(newTime);
          });

          ws.on("error", (err) => {
            console.warn("WaveSurfer (viz) error:", err);
            setIsWaveformLoading(false);
          });

          if (cancelled) { ws.destroy(); return; }
          wsInstance.current = ws;
        } catch (e) {
          if (!cancelled) {
            console.error("WaveSurfer init failed:", e);
            setIsWaveformLoading(false);
            setError("Waveform initialisation failed.");
          }
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      if (initTimeoutRef.current) { clearTimeout(initTimeoutRef.current); initTimeoutRef.current = null; }
      if (wsInstance.current)     { wsInstance.current.destroy(); wsInstance.current = null; }
      stopSource();
      stopCursorRaf();
    };
  }, [selectedRecording?.path, selectedRecording?._ts, isLargeFile, stopSource, stopCursorRaf, startPlaybackFrom]);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    };
  }, []);

  useEffect(() => {
    wsInstance.current?.zoom(zoomLevel);
  }, [zoomLevel]);

  // Large-file fallback
  useEffect(() => {
    if (!isLargeFile || !selectedRecording?.path || !audioRef.current) return;
    const el = audioRef.current;
    readFileBytes(selectedRecording.path)
      .then((bytes) => {
        const url = bytesToBlobUrl(bytes);
        blobUrlRef.current = url;
        el.src = url;
        el.load();
        el.oncanplay = () => {
          if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
          el.oncanplay = null;
        };
      })
      .catch((e) => {
        console.error("Failed to load large audio file:", e);
        setError("Could not read audio file from disk.");
      });
  }, [selectedRecording?.path, isLargeFile]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const doTrim = async (overwrite: boolean, clipName?: string) => {
    if (!selectedRecording || !regionsRef.current) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;

    if (overwrite) {
      const ok = await confirm(
        `Trim to ${fmtTime(region.start)} – ${fmtTime(region.end)}?\nThis overwrites the original.`,
        { title: "Trim Recording", kind: "warning" },
      );
      if (!ok) return;
    }

    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", {
        id: selectedRecording.id,
        startSec: region.start,
        endSec: region.end,
        newId: overwrite ? undefined : (clipName ?? undefined),
        fadeInSec: fadeIn > 0 ? fadeIn : undefined,
        fadeOutSec: fadeOut > 0 ? fadeOut : undefined,
      });
      if (overwrite) {
        setSelectedRecording({ ...selectedRecording, _ts: Date.now() });
      }
      fetchRecordings();
    } catch (err: any) {
      setError("Trim failed: " + err);
    } finally {
      setIsTrimming(false);
    }
  };

  const handleTrim = () => doTrim(true);

  const handleSaveAsConfirm = async () => {
    if (!saveAsName.trim()) return;
    setShowSaveAs(false);
    await doTrim(false, saveAsName.trim());
    setSaveAsName("");
  };

  const selectionDuration = outPoint - inPoint;

  if (!selectedRecording) return null;

  return (
    <div className="flex flex-col">
      {/* ── Save-as modal ──────────────────────────────────────────────────── */}
      {showSaveAs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 w-72 shadow-2xl">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Save as New Clip</p>
            <input
              autoFocus
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveAsConfirm();
                if (e.key === "Escape") { setShowSaveAs(false); setSaveAsName(""); }
              }}
              placeholder="Clip name…"
              className="w-full bg-slate-800 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg outline-none focus:border-amber-500 text-xs mb-3 transition-colors"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowSaveAs(false); setSaveAsName(""); }}
                className="flex items-center gap-1 px-3 py-1 text-slate-400 hover:text-white text-[9px] font-black uppercase tracking-widest transition-colors"
              ><X size={10} /> Cancel</button>
              <button
                onClick={handleSaveAsConfirm}
                disabled={!saveAsName.trim()}
                className="flex items-center gap-1 px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40"
              ><Check size={10} /> Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top meta row ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
        <div className="flex items-center gap-3 min-w-0">
          {isRenaming ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameRecording(selectedRecording.id, renameValue).then(() => setIsRenaming(false));
                  if (e.key === "Escape") setIsRenaming(false);
                }}
                onBlur={() => setIsRenaming(false)}
                className="bg-slate-800 border border-amber-500 text-slate-100 text-xs font-bold px-2 py-0.5 rounded-md outline-none w-44"
              />
              <button
                onClick={() => handleRenameRecording(selectedRecording.id, renameValue).then(() => setIsRenaming(false))}
                className="p-1 bg-amber-500 text-black rounded transition-all"
              ><Check size={11} /></button>
            </div>
          ) : (
            <button
              onClick={() => { setIsRenaming(true); setRenameValue(selectedRecording.name); }}
              className="flex items-center gap-1.5 group"
            >
              <span className="text-xs font-bold text-slate-200 group-hover:text-amber-400 transition-colors truncate max-w-[200px]">
                {selectedRecording.name}
              </span>
              <Edit2 size={10} className="text-slate-600 group-hover:text-amber-500 transition-colors shrink-0" />
            </button>
          )}

          <div className="flex items-center gap-2.5 text-[8px] font-bold uppercase tracking-wider text-slate-600">
            <span>WAV · {selectedRecording.size_mb.toFixed(1)} MB · {selectedRecording.duration}</span>
            <span className={selectedRecording.transcribed ? "text-green-500" : "text-amber-600"}>
              {selectedRecording.transcribed ? "✓ Transcribed" : "Not Transcribed"}
            </span>
          </div>
        </div>

        <button
          onClick={() => handleDeleteRecording(selectedRecording.id)}
          className="p-1.5 rounded-md text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
          title="Delete"
        ><Trash2 size={13} /></button>
      </div>

      {/* ── Waveform ──────────────────────────────────────────────────────── */}
      {isLargeFile ? (
        <div className="px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-1.5 mb-2 text-amber-500 text-[9px] font-black uppercase tracking-widest">
            <AlertTriangle size={11} />
            <span>Large file — waveform skipped to prevent memory issues</span>
          </div>
          <audio
            ref={audioRef}
            controls
            className="w-full h-8"
            style={{ colorScheme: "dark" }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />
        </div>
      ) : (
        <div className="relative px-4 pt-3 pb-1 border-b border-slate-800">
          {isWaveformLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 z-10">
              <RefreshCw size={16} className="animate-spin text-amber-500" />
            </div>
          )}
          <div ref={wavesurferRef} className="w-full" />
          {/* Time ruler */}
          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] font-bold tabular-nums text-slate-500">
              {fmtTimeFull(currentTime)}
            </span>
            <span className="text-[9px] font-bold tabular-nums text-slate-600">
              {fmtTimeFull(duration)}
            </span>
          </div>
        </div>
      )}

      {/* ── Edit controls (hidden for large files) ────────────────────────── */}
      {!isLargeFile && (
        <div className="flex flex-col gap-0 border-b border-slate-800">

          {/* Row 1: Playback + In/Out points */}
          <div className="flex items-center gap-2 px-4 py-2">
            {/* Play full */}
            <button
              onClick={handlePlayPause}
              disabled={!audioBufferRef.current && !isWaveformLoading}
              title="Play / Pause (Space)"
              className="w-8 h-8 bg-amber-500 hover:bg-amber-400 text-black rounded-lg flex items-center justify-center transition-all shadow-lg shadow-amber-500/20 active:scale-95 shrink-0 disabled:opacity-40"
            >
              {isPlaying
                ? <Pause size={14} fill="currentColor" />
                : <Play size={14} fill="currentColor" className="ml-0.5" />
              }
            </button>

            {/* Play selection */}
            <button
              onClick={handlePlaySelection}
              disabled={!audioBufferRef.current || selectionDuration <= 0}
              title="Play selection only"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-amber-500/20 border border-slate-700 hover:border-amber-500/40 text-slate-400 hover:text-amber-400 rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 active:scale-95 shrink-0"
            >
              <SkipForward size={10} /> Preview
            </button>

            <div className="h-4 w-px bg-slate-800 mx-1 shrink-0" />

            {/* IN point group */}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 shrink-0">IN</span>
              <input
                value={inStr}
                onChange={(e) => setInStr(e.target.value)}
                onBlur={applyInStr}
                onKeyDown={(e) => { if (e.key === "Enter") applyInStr(); }}
                title="In point (M:SS.ss)"
                className="w-20 bg-slate-800 border border-slate-700 text-amber-400 text-[9px] font-black tabular-nums px-2 py-1 rounded-md outline-none focus:border-amber-500 text-center transition-colors"
              />
              <button
                onClick={handleSetIn}
                title="Set in-point at playhead (I)"
                className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-amber-400 rounded-md text-[8px] font-black uppercase tracking-widest transition-all active:scale-95"
              >
                <ListStart size={10} /> Set
              </button>
            </div>

            <div className="h-4 w-px bg-slate-800 shrink-0" />

            {/* OUT point group */}
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 shrink-0">OUT</span>
              <input
                value={outStr}
                onChange={(e) => setOutStr(e.target.value)}
                onBlur={applyOutStr}
                onKeyDown={(e) => { if (e.key === "Enter") applyOutStr(); }}
                title="Out point (M:SS.ss)"
                className="w-20 bg-slate-800 border border-slate-700 text-amber-400 text-[9px] font-black tabular-nums px-2 py-1 rounded-md outline-none focus:border-amber-500 text-center transition-colors"
              />
              <button
                onClick={handleSetOut}
                title="Set out-point at playhead (O)"
                className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-amber-400 rounded-md text-[8px] font-black uppercase tracking-widest transition-all active:scale-95"
              >
                <ListEnd size={10} /> Set
              </button>
            </div>

            {/* Selection duration badge */}
            {selectionDuration > 0.01 && (
              <div className="ml-1 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded-md shrink-0">
                <span className="text-[8px] font-black tabular-nums text-amber-400">
                  {fmtTimeFull(selectionDuration)}
                </span>
              </div>
            )}

            {/* Zoom */}
            <div className="flex items-center gap-1 ml-auto shrink-0">
              <ZoomOut size={10} className="text-slate-600" />
              <input
                type="range" min="0" max="200" value={zoomLevel}
                onChange={(e) => setZoomLevel(parseInt(e.target.value))}
                className="w-14 h-1 accent-amber-500 cursor-pointer"
              />
              <ZoomIn size={10} className="text-slate-600" />
              {zoomLevel > 0 && (
                <button
                  onClick={() => setZoomLevel(0)}
                  className="p-0.5 rounded text-slate-600 hover:text-slate-300 transition-colors"
                  title="Reset zoom"
                ><RotateCcw size={9} /></button>
              )}
            </div>
          </div>

          {/* Row 2: Trim actions + Fade controls */}
          <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/40">
            {/* Trim to selection */}
            <button
              onClick={handleTrim}
              disabled={isTrimming || isWaveformLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 active:scale-95"
            >
              {isTrimming ? <RefreshCw size={10} className="animate-spin" /> : <Scissors size={10} />}
              Trim
            </button>

            <button
              onClick={() => { setSaveAsName(`${selectedRecording.name}_clip`); setShowSaveAs(true); }}
              disabled={isTrimming || isWaveformLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 active:scale-95"
            >
              Save as Clip
            </button>

            <button
              onClick={handleResetSelection}
              title="Reset selection to full file (Esc)"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-500 hover:text-slate-300 rounded-md text-[9px] font-black uppercase tracking-widest transition-all active:scale-95"
            >
              Reset
            </button>

            <div className="h-4 w-px bg-slate-800 mx-1 shrink-0" />

            {/* Fade In */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Fade In</span>
              <input
                type="range" min="0" max="10" step="0.1" value={fadeIn}
                onChange={(e) => setFadeIn(parseFloat(e.target.value))}
                className="w-16 h-1 accent-amber-500 cursor-pointer"
              />
              <span className="text-[8px] font-bold tabular-nums text-amber-500 w-8">{fadeIn.toFixed(1)}s</span>
            </div>

            {/* Fade Out */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Fade Out</span>
              <input
                type="range" min="0" max="10" step="0.1" value={fadeOut}
                onChange={(e) => setFadeOut(parseFloat(e.target.value))}
                className="w-16 h-1 accent-amber-500 cursor-pointer"
              />
              <span className="text-[8px] font-bold tabular-nums text-amber-500 w-8">{fadeOut.toFixed(1)}s</span>
            </div>

            <p className="ml-auto text-[8px] text-slate-700 uppercase tracking-widest shrink-0">
              Space · I · O · Esc
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
