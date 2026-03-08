import React, { useState, useEffect, useRef } from "react";
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

// Read a local file via the existing read_file_base64 Tauri command and return
// a blob: URL.  This works reliably on all platforms (Windows, Linux, macOS)
// because it goes through Rust IPC instead of the asset protocol, which can
// fail to serve files in some WebView2 / WebKitGTK configurations.
async function filePathToBlobUrl(filePath: string): Promise<string> {
  const b64  = await invoke<string>("read_file_base64", { path: filePath });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

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

  const [isPlaying, setIsPlaying]           = useState(false);
  const [isWaveformLoading, setIsWaveformLoading] = useState(false);
  const [isRenaming, setIsRenaming]         = useState(false);
  const [renameValue, setRenameValue]       = useState("");
  const [zoomLevel, setZoomLevel]           = useState(0);
  const [duration, setDuration]             = useState(0);
  const [currentTime, setCurrentTime]       = useState(0);
  const [showSaveAs, setShowSaveAs]         = useState(false);
  const [saveAsName, setSaveAsName]         = useState("");

  const wavesurferRef  = useRef<HTMLDivElement>(null);
  const wsInstance     = useRef<WaveSurfer | null>(null);
  const regionsRef     = useRef<any>(null);
  const audioRef       = useRef<HTMLAudioElement | null>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Blob URL created from the FS-plugin read — must be revoked on cleanup
  const blobUrlRef     = useRef<string | null>(null);

  const isLargeFile = (selectedRecording?.size_mb ?? 0) > WAVEFORM_SIZE_LIMIT_MB;

  const revokeBlobUrl = () => {
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
  };

  // ── WaveSurfer init ────────────────────────────────────────────────────────
  // We read the file through the Tauri FS plugin (readFile) and feed WaveSurfer
  // a blob: URL. This bypasses convertFileSrc / the asset protocol entirely,
  // which fails on some Linux/WebKitGTK builds even for valid local files.
  //
  // setTimeout(fn,0) also survives React 18 StrictMode double-invoke: the
  // cleanup cancels the timeout before WaveSurfer is ever created.
  useEffect(() => {
    if (!wavesurferRef.current || !selectedRecording?.path || isLargeFile) return;

    const container = wavesurferRef.current;
    const filePath  = selectedRecording.path;
    // Abort flag: set to true when cleanup fires so the async IIFE
    // (which may still be awaiting the Tauri IPC round-trip) bails out
    // instead of creating an orphaned WaveSurfer on an unmounted component.
    let cancelled = false;

    if (wsInstance.current) { wsInstance.current.destroy(); wsInstance.current = null; }
    revokeBlobUrl();

    // setTimeout(fn, 0) survives React 18 StrictMode double-invoke:
    // the cleanup cancels the timeout before WaveSurfer is ever created.
    initTimeoutRef.current = setTimeout(() => {
      if (cancelled || !container) return;
      setIsWaveformLoading(true);

      (async () => {
        let url: string;
        try {
          url = await filePathToBlobUrl(filePath);
          // Check after every await — cleanup may have fired while we waited
          if (cancelled) { URL.revokeObjectURL(url); return; }
          blobUrlRef.current = url;
        } catch (e) {
          if (!cancelled) {
            console.error("Failed to read audio file:", e);
            setIsWaveformLoading(false);
            setError("Could not read audio file from disk.");
          }
          return;
        }

        try {
          const regions = RegionsPlugin.create();
          if (cancelled) return;
          regionsRef.current = regions;

          const ws = WaveSurfer.create({
            container,
            waveColor: "#f59e0b",
            progressColor: "#d97706",
            cursorColor: "#fbbf24",
            barWidth: 2,
            barRadius: 2,
            height: 80,
            url,
            plugins: [regions],
          });

          // Guard every async callback — the component may have moved on
          ws.on("play",   () => { if (!cancelled) setIsPlaying(true); });
          ws.on("pause",  () => { if (!cancelled) setIsPlaying(false); });
          ws.on("finish", () => { if (!cancelled) setIsPlaying(false); });
          ws.on("ready",  () => {
            if (cancelled) return;
            setIsWaveformLoading(false);
            setDuration(ws.getDuration());
            regions.addRegion({
              start: 0,
              end: ws.getDuration(),
              color: "rgba(245,158,11,0.12)",
              drag: true,
              resize: true,
            });
          });
          ws.on("error", (err) => {
            if (cancelled) return;
            console.error("WaveSurfer error:", err);
            setIsWaveformLoading(false);
            if (wsInstance.current === ws) {
              setError("Failed to decode audio. Try re-importing or re-recording.");
            }
          });
          ws.on("timeupdate", (t) => { if (!cancelled) setCurrentTime(t); });

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
      cancelled = true; // Signal all in-flight async work to abort
      if (initTimeoutRef.current) { clearTimeout(initTimeoutRef.current); initTimeoutRef.current = null; }
      if (wsInstance.current)     { wsInstance.current.destroy(); wsInstance.current = null; }
      revokeBlobUrl();
    };
  }, [selectedRecording?.path, selectedRecording?._ts, isLargeFile]);

  // Zoom
  useEffect(() => {
    wsInstance.current?.zoom(zoomLevel);
  }, [zoomLevel]);

  // Large-file fallback <audio> src — also uses readFile to avoid asset
  // protocol issues on Linux/WebKitGTK.
  useEffect(() => {
    if (!isLargeFile || !selectedRecording?.path || !audioRef.current) return;
    const el = audioRef.current;
    filePathToBlobUrl(selectedRecording.path).then((url) => {
      el.src = url;
      el.load();
      el.oncanplay = () => { URL.revokeObjectURL(url); el.oncanplay = null; };
    }).catch((e) => {
      console.error("Failed to load large audio file:", e);
      setError("Could not read audio file from disk.");
    });
  }, [selectedRecording?.path, isLargeFile]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleTrim = async () => {
    if (!selectedRecording || !regionsRef.current) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;
    const ok = await confirm(
      `Trim to ${fmtTime(region.start)} – ${fmtTime(region.end)}?\nThis overwrites the original.`,
      { title: "Trim Recording", kind: "warning" }
    );
    if (!ok) return;
    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", { id: selectedRecording.id, startSec: region.start, endSec: region.end });
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
        id: selectedRecording.id, startSec: region.start, endSec: region.end, newId: saveAsName.trim(),
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
          {/* Play/pause */}
          <button
            onClick={() => wsInstance.current?.playPause()}
            className="w-8 h-8 bg-amber-500 hover:bg-amber-400 text-black rounded-lg flex items-center justify-center transition-all shadow-lg shadow-amber-500/20 active:scale-95 shrink-0"
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
