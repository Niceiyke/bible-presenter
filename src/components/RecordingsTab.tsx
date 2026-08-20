import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FolderOpen, Play, Square, Trash2, Video, Clock, HardDrive, MonitorPlay,
} from "lucide-react";
import { useRecording } from "../hooks/useRecordingProvider";
import { useAppStore } from "../store";
import { tierCapabilities } from "../system/tiers";
import { CAPTURE_RESOLUTIONS, CAPTURE_FPS_OPTIONS } from "../types";
import { ProgramFeedPreview } from "./outputs/ProgramFeedPreview";

export interface RecordingFile {
  name: string;
  size: number;
  modified: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

/**
 * `RecordingsTab` — Phase D recorder workspace.
 *
 * The capture → encode → mux pipeline lives in the `wordlyte-engine` sidecar;
 * the App-level `RecordingProvider` owns the recorder surface, so a recording
 * survives navigating away. This tab previews the composited program feed (a
 * canvas verification surface), shows a REC/STOP transport, and lists the saved
 * recordings. Output goes to the app-data `recordings/` dir as MP4 (mux-only
 * ffmpeg, `-c copy`). Audio moves to the engine in a later phase.
 */
export function RecordingsTab() {
  const {
    recording, elapsed, lastSaved, error, transportConnected,
    captureWidth, captureHeight, captureFps, setCapture,
    start, stop,
  } = useRecording();
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [loading, setLoading] = useState(false);
  const license = useAppStore((s) => s.license);
  const recordingBlocked = !!license && license.status === "active" && !tierCapabilities(license.tier).recording;

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<RecordingFile[]>("recordings_list");
      setRecordings(list);
    } catch (e: any) {
      console.error("recordings_list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const handleRecordStop = async () => {
    const name = await stop();
    if (name) {
      await refreshList();
    }
  };

  const handleDelete = async (name: string) => {
    await invoke("recording_delete", { fileName: name });
    await refreshList();
  };

  const handleOpenFolder = () => {
    invoke("recordings_open_folder").catch(console.error);
  };

  const handlePlay = () => {
    // Reveal in the OS file manager — a full media player is out of scope
    // for the recorder surface (MP4 may not preview in the webview).
    void invoke("recordings_open_folder");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <Video size={12} /> Recorder
        </h2>
        <button
          onClick={handleOpenFolder}
          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-all flex items-center gap-1"
        >
          <FolderOpen size={10} /> Open Folder
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Program preview + transport */}
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black" style={{ aspectRatio: "16/9" }}>
            <ProgramFeedPreview
              className="absolute inset-0 w-full h-full"
              config={undefined}
              geometry={{ width: captureWidth, height: captureHeight }}
              fps={captureFps}
            />
            {recording && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> REC
                <span className="font-mono normal-case">{formatDuration(elapsed)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {recording ? (
              <button
                onClick={() => void handleRecordStop()}
                disabled={!recording}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Square size={11} fill="currentColor" /> Stop &amp; Save
              </button>
            ) : (
              <button
                onClick={() => void start()}
                disabled={recordingBlocked || !transportConnected}
                title={
                  recordingBlocked
                    ? "Recording is a Pro feature"
                    : !transportConnected
                      ? "The engine sidecar is not running"
                      : "Record the program feed"
                }
                className="flex-1 py-2.5 rounded-md bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-white" /> Record
              </button>
            )}
          </div>

          {recordingBlocked && (
            <p className="text-[10px] text-amber-500 font-medium">
              Recording is a Pro feature. Upgrade in Settings → License to record the program feed.
            </p>
          )}

          {!transportConnected && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              The engine sidecar is not running — recording is unavailable.
            </p>
          )}

          {/* Capture resolution + fps for the recording */}
          <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <MonitorPlay size={11} className="text-slate-500" /> Capture
            </span>
            <select
              value={`${captureWidth}x${captureHeight}`}
              onChange={(e) => {
                const r = CAPTURE_RESOLUTIONS.find((r) => `${r.width}x${r.height}` === e.target.value);
                if (r) void setCapture(r.width, r.height, captureFps);
              }}
              disabled={recording}
              className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-[11px] text-slate-300"
              title="Recording resolution"
            >
              {CAPTURE_RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.width}x${r.height}`}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              value={captureFps}
              onChange={(e) => void setCapture(captureWidth, captureHeight, Number(e.target.value))}
              disabled={recording}
              className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-[11px] text-slate-300"
              title="Recording frame rate"
            >
              {CAPTURE_FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
            <span className="text-[10px] text-slate-600">MP4 — the engine's compositor rescales the program feed.</span>
          </div>

          {error && (
            <p className="text-[11px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1.5">
              {error}
            </p>
          )}
          {lastSaved && !recording && (
            <p className="text-[11px] text-emerald-400 bg-emerald-900/20 border border-emerald-900/50 rounded px-2 py-1.5 flex items-center gap-1.5">
              <HardDrive size={11} /> Saved {lastSaved}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <Clock size={11} /> Recordings
              <span className="text-slate-600">({recordings.length})</span>
            </h3>
            <button
              onClick={refreshList}
              className="text-[10px] text-slate-500 hover:text-slate-300 uppercase font-bold"
            >
              Refresh
            </button>
          </div>

          {loading && recordings.length === 0 ? (
            <p className="text-slate-600 text-xs italic py-6 text-center">Loading…</p>
          ) : recordings.length === 0 ? (
            <p className="text-slate-600 text-xs italic py-6 text-center">No recordings yet. Press Record to capture the program feed.</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[480px] overflow-y-auto custom-scrollbar">
              {recordings.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-slate-700/60 bg-slate-900/40 hover:border-slate-600 transition-all"
                >
                  <Video size={13} className="text-slate-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-200 truncate">{r.name}</p>
                    <p className="text-[10px] text-slate-500">
                      {formatBytes(r.size)} · {formatDate(r.modified)}
                    </p>
                  </div>
                  <button
                    onClick={handlePlay}
                    title="Reveal in file manager"
                    className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    <Play size={11} />
                  </button>
                  <button
                    onClick={() => handleDelete(r.name)}
                    title="Delete recording"
                    className="p-1.5 rounded bg-slate-800 hover:bg-red-900 hover:text-red-300 text-slate-400 transition-colors"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}