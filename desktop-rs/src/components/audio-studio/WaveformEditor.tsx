import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  Play, Pause, Scissors, RefreshCw, RotateCcw,
  ZoomIn, ZoomOut, Trash2, Check, X, Edit2, AlertTriangle,
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { useAppStore } from "../../store";

const WAVEFORM_SIZE_LIMIT_MB = 80;

// ── Helpers ─────────────────────────────────────────────────────────────────

// Read a local file and return its raw bytes via Tauri IPC (avoids asset
// protocol issues on Linux/WebKitGTK).
async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const b64 = await invoke<string>("read_file_base64", { path: filePath });
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Build a blob URL from raw bytes (used only for the large-file <audio> fallback).
function bytesToBlobUrl(bytes: Uint8Array): string {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

// Fetch pre-computed waveform peaks from Rust (avoids AudioContext.decodeAudioData).
async function fetchRecordingPeaks(
  id: string,
): Promise<{ peaks: number[][]; duration: number }> {
  const result = await invoke<{ peaks: number[]; duration: number }>(
    "get_recording_peaks",
    { id, nPeaks: 1000 },
  );
  return { peaks: [result.peaks], duration: result.duration };
}

// Parse raw WAV bytes into a Float32Array of mono samples without using
// AudioContext.decodeAudioData.  Supports 16-bit int and 32-bit float PCM.
// Returns null if the header cannot be parsed.
function parseWavBytes(
  bytes: Uint8Array,
): { samples: Float32Array; sampleRate: number } | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 12; // skip "RIFF????WAVE"
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
      // Word-align the next chunk position
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

  // WaveSurfer (visualisation only — no internal audio decode/playback)
  const wavesurferRef  = useRef<HTMLDivElement>(null);
  const wsInstance     = useRef<WaveSurfer | null>(null);
  const regionsRef     = useRef<any>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Large-file <audio> element fallback
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef  = useRef<string | null>(null);

  // Web Audio API playback (bypasses codec / decodeAudioData entirely)
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const audioBufferRef    = useRef<AudioBuffer | null>(null);
  const sourceNodeRef     = useRef<AudioBufferSourceNode | null>(null);
  const playOffsetRef     = useRef<number>(0);   // seconds from start
  const playStartCtxRef   = useRef<number>(0);   // AudioContext.currentTime at play start
  const rafRef            = useRef<number | null>(null);
  const isPlayingRef      = useRef<boolean>(false); // mirror of isPlaying for closures

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

  const startPlaybackFrom = useCallback((offset: number) => {
    const ctx = audioCtxRef.current;
    const buf = audioBufferRef.current;
    if (!ctx || !buf) return;

    stopSource();
    stopCursorRaf();

    const clampedOffset = Math.min(Math.max(offset, 0), buf.duration - 0.001);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0, clampedOffset);
    src.onended = () => {
      stopCursorRaf();
      isPlayingRef.current = false;
      setIsPlaying(false);
      playOffsetRef.current = 0;
      setCurrentTime(0);
      if (wsInstance.current) wsInstance.current.seekTo(0);
    };

    sourceNodeRef.current = src;
    playStartCtxRef.current = ctx.currentTime - clampedOffset;
    isPlayingRef.current = true;
    setIsPlaying(true);

    const tick = () => {
      const t = Math.min(
        ctx.currentTime - playStartCtxRef.current,
        buf.duration,
      );
      setCurrentTime(t);
      if (wsInstance.current) wsInstance.current.seekTo(t / buf.duration);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopSource, stopCursorRaf]);

  const handlePlayPause = useCallback(() => {
    if (!audioCtxRef.current || !audioBufferRef.current) return;
    if (isPlayingRef.current) {
      // Pause: capture current position before stopping
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

  // ── WaveSurfer + AudioBuffer init ───────────────────────────────────────
  useEffect(() => {
    if (!wavesurferRef.current || !selectedRecording?.path || isLargeFile) return;

    const container = wavesurferRef.current;
    const filePath  = selectedRecording.path;
    const recId     = selectedRecording.id;
    let cancelled   = false;

    // Tear down previous instances
    if (wsInstance.current) { wsInstance.current.destroy(); wsInstance.current = null; }
    stopSource();
    stopCursorRaf();
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    audioBufferRef.current  = null;
    playOffsetRef.current   = 0;
    isPlayingRef.current    = false;
    setIsPlaying(false);
    setCurrentTime(0);

    initTimeoutRef.current = setTimeout(() => {
      if (cancelled || !container) return;
      setIsWaveformLoading(true);

      (async () => {
        // 1. Read raw bytes from disk
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

        // 2. Fetch Rust-computed waveform peaks (skips AudioContext.decodeAudioData)
        let peaksData: { peaks: number[][]; duration: number } | null = null;
        try {
          peaksData = await fetchRecordingPeaks(recId);
          if (cancelled) return;
        } catch (e) {
          console.warn("get_recording_peaks failed:", e);
        }

        // 3. Parse WAV bytes → Float32Array and build AudioBuffer.
        //    AudioContext.createBuffer() is just memory allocation — no codec involved.
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

        // 4. Create WaveSurfer for visualisation only (no url / media / decode)
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
            height: 80,
            plugins: [regions],
            // peaks + duration → WaveSurfer renders immediately, no fetch/decode
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
            regions.addRegion({
              start: 0,
              end: d,
              color: "rgba(245,158,11,0.12)",
              drag: true,
              resize: true,
            });
          });

          // User clicks/seeks on waveform → WaveSurfer v7 fires "interaction"
          // with the new absolute time in seconds.
          ws.on("interaction", (newTime: number) => {
            if (cancelled) return;
            playOffsetRef.current = newTime;
            setCurrentTime(newTime);
            if (isPlayingRef.current) {
              startPlaybackFrom(newTime);
            }
          });

          ws.on("error", (err) => {
            console.warn("WaveSurfer (viz) error:", err);
            // Non-fatal: waveform is drawn from peaks, playback is via Web Audio API
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

  // Close AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    };
  }, []);

  // Zoom
  useEffect(() => {
    wsInstance.current?.zoom(zoomLevel);
  }, [zoomLevel]);

  // Large-file fallback — blob URL for the native <audio> element
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

  const handleTrim = async () => {
    if (!selectedRecording || !regionsRef.current) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;
    const ok = await confirm(
      `Trim to ${fmtTime(region.start)} – ${fmtTime(region.end)}?\nThis overwrites the original.`,
      { title: "Trim Recording", kind: "warning" },
    );
    if (!ok) return;
    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", {
        id: selectedRecording.id, startSec: region.start, endSec: region.end,
      });
      setSelectedRecording({ ...selectedRecording, _ts: Date.now() });
      fetchRecordings();
    } catch (err: any) { setError("Trim failed: " + err); }
    finally { setIsTrimming(false); }
  };

  const handleSaveAsConfirm = async () => {
    if (!selectedRecording || !regionsRef.current || !saveAsName.trim()) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;
    setShowSaveAs(false);
    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", {
        id: selectedRecording.id, startSec: region.start, endSec: region.end,
        newId: saveAsName.trim(),
      });
      fetchRecordings();
    } catch (err: any) { setError("Save as clip failed: " + err); }
    finally { setIsTrimming(false); setSaveAsName(""); }
  };

  const fmtTime = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

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
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
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

      {/* ── Waveform / fallback ───────────────────────────────────────────── */}
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
        <div className="relative px-4 pt-3 pb-2 border-b border-slate-800">
          {isWaveformLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 z-10">
              <RefreshCw size={16} className="animate-spin text-amber-500" />
            </div>
          )}
          <div ref={wavesurferRef} className="w-full" />
          {/* Time + zoom */}
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[9px] font-bold tabular-nums text-slate-500">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
            <div className="flex items-center gap-1.5">
              <ZoomOut size={10} className="text-slate-600" />
              <input
                type="range" min="0" max="200" value={zoomLevel}
                onChange={(e) => setZoomLevel(parseInt(e.target.value))}
                className="w-16 h-1 accent-amber-500 cursor-pointer"
              />
              <ZoomIn size={10} className="text-slate-600" />
              {zoomLevel > 0 && (
                <button
                  onClick={() => setZoomLevel(0)}
                  className="p-0.5 rounded text-slate-600 hover:text-slate-300 transition-colors"
                  title="Reset zoom"
                ><RotateCcw size={10} /></button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      {!isLargeFile && (
        <div className="flex items-center gap-2 px-4 py-2.5">
          {/* Play/pause — uses Web Audio API AudioBuffer, not the <audio> element */}
          <button
            onClick={handlePlayPause}
            disabled={!audioBufferRef.current && !isWaveformLoading}
            className="w-8 h-8 bg-amber-500 hover:bg-amber-400 text-black rounded-lg flex items-center justify-center transition-all shadow-lg shadow-amber-500/20 active:scale-95 shrink-0 disabled:opacity-40"
          >
            {isPlaying
              ? <Pause size={14} fill="currentColor" />
              : <Play size={14} fill="currentColor" className="ml-0.5" />
            }
          </button>

          <div className="h-4 w-px bg-slate-800 mx-0.5" />

          {/* Trim to selection */}
          <button
            onClick={handleTrim}
            disabled={isTrimming || isWaveformLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 active:scale-95"
          >
            {isTrimming ? <RefreshCw size={10} className="animate-spin" /> : <Scissors size={10} />}
            Trim
          </button>

          {/* Save as */}
          <button
            onClick={() => { setSaveAsName(`${selectedRecording.name}_clip`); setShowSaveAs(true); }}
            disabled={isTrimming || isWaveformLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40 active:scale-95"
          >
            Save As Clip
          </button>

          {/* Reset selection */}
          <button
            onClick={() => {
              const region = regionsRef.current?.getRegions()[0];
              if (region) region.setOptions({ start: 0, end: duration });
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-500 hover:text-slate-300 rounded-md text-[9px] font-black uppercase tracking-widest transition-all active:scale-95"
          >
            Reset
          </button>

          <p className="ml-auto text-[8px] text-slate-700 uppercase tracking-widest">Drag handles · Space to play</p>
        </div>
      )}
    </div>
  );
}
