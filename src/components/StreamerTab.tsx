import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Signal, Square, Radio, Globe, KeyRound, Play, MonitorUp } from "lucide-react";
import { useAppStore } from "../store";
import { useStreamer } from "../hooks/useStreamer";
import { useRtmpEncoder } from "../hooks/useRtmpEncoder";
import { ProgramFeedPreview } from "./outputs/ProgramFeedPreview";
import type { OutputConfig } from "../types";

const STREAM_OUTPUT_ID = "stream-main";
type StreamMode = "whip" | "rtmp";

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return "—";
  if (kbps < 1000) return `${kbps} kbps`;
  return `${(kbps / 1000).toFixed(2)} Mbps`;
}

/**
 * `StreamerTab` — Phase 4/6 streaming workspace.
 *
 * Shows the live program-feed compositor (the exact pixels being uploaded) and
 * a transport with connection status + approximate bitrate. Two ingest modes:
 *   - WHIP (WebRTC) — WebView2-native `RTCPeerConnection`, sub-second latency.
 *   - RTMP (ffmpeg)  — WebCodecs H.264 in the webview piped to a backend
 *     `ffmpeg -c copy` mux-only publish (YouTube/Facebook/Twitch ingest).
 *
 * The endpoint config persists to the `stream-main` output's `streaming` field
 * through `outputs_update`, so the streamer target survives restarts.
 */
export function StreamerTab() {
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);
  const streamer = useStreamer();
  const rtmp = useRtmpEncoder();
  const streamRef = useRef<MediaStream | null>(null);
  const [streamReady, setStreamReady] = useState(false);

  const output: OutputConfig | undefined = outputs.find((o) => o.id === STREAM_OUTPUT_ID);
  const [mode, setMode] = useState<StreamMode>("whip");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const active = mode === "whip" ? streamer : rtmp;

  // Hydrate the form from the persisted stream-main config.
  useEffect(() => {
    if (output?.streaming) {
      setMode((output!.streaming!.mode === "rtmp" || output!.streaming!.mode === "srt" ? "rtmp" : "whip") as StreamMode);
      setUrl((prev) => prev || output!.streaming!.url || "");
      setToken((prev) => prev || output!.streaming!.stream_key || "");
    }
  }, [output]);

  const persistConfig = useCallback(
    async (nextMode: StreamMode, nextUrl: string, nextToken: string) => {
      setSaving(true);
      try {
        const next = outputs.map((o) =>
          o.id === STREAM_OUTPUT_ID
            ? { ...o, streaming: { mode: nextMode, url: nextUrl, stream_key: nextToken || undefined } }
            : o
        );
        await invoke("outputs_update", { configs: next });
        setOutputs(next);
      } catch (e: any) {
        console.error("outputs_update failed:", e);
      } finally {
        setSaving(false);
      }
    },
    [outputs, setOutputs]
  );

  const switchMode = (m: StreamMode) => {
    if (active.status !== "idle" && active.status !== "error") return;
    setMode(m);
    persistConfig(m, url, token);
  };

  const handleStream = useCallback((stream: MediaStream | null) => {
    streamRef.current = stream;
    setStreamReady(!!stream && stream.getVideoTracks().length > 0);
  }, []);

  const handleGoLive = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    await persistConfig(mode, url, token);
    if (mode === "rtmp") {
      await rtmp.start(stream, url, token || undefined);
    } else {
      await streamer.start(stream, { url, token: token || undefined });
    }
  };

  const handleStop = async () => {
    if (mode === "rtmp") {
      await rtmp.stop();
    } else {
      await streamer.stop();
    }
  };

  const live = active.status === "live";
  const connecting = active.status === "connecting";

  const statusLabel =
    active.status === "live"
      ? "Live"
      : active.status === "connecting"
        ? "Connecting…"
        : active.status === "error"
          ? "Error"
          : "Offline";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <Radio size={12} /> Streamer
        </h2>
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className={`px-2 py-0.5 rounded-full border font-bold uppercase tracking-wider ${
              live
                ? "bg-red-600/20 border-red-600 text-red-400"
                : connecting
                  ? "bg-amber-500/20 border-amber-500 text-amber-400"
                  : active.status === "error"
                    ? "bg-red-900/40 border-red-800 text-red-500"
                    : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {statusLabel}
          </span>
          {live && <span className="text-slate-500 font-mono">{formatBitrate(active.bitrateKbps)}</span>}
        </div>
      </div>

      {/* Ingest mode + endpoint configuration */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-slate-700 bg-slate-900/40">
        <div className="flex items-center gap-2">
          <Globe size={11} className="text-slate-500" />
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            {mode === "rtmp" ? "RTMP Endpoint" : "WHIP Endpoint"}
          </label>
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => switchMode("whip")}
              disabled={active.status !== "idle" && active.status !== "error"}
              className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition-all ${
                mode === "whip"
                  ? "bg-cyan-600/20 border-cyan-600 text-cyan-400"
                  : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300"
              }`}
            >
              <Signal size={9} className="inline -mt-0.5 mr-1" /> WHIP
            </button>
            <button
              onClick={() => switchMode("rtmp")}
              disabled={active.status !== "idle" && active.status !== "error"}
              className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition-all ${
                mode === "rtmp"
                  ? "bg-cyan-600/20 border-cyan-600 text-cyan-400"
                  : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300"
              }`}
            >
              <MonitorUp size={9} className="inline -mt-0.5 mr-1" /> RTMP
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={mode === "rtmp" ? "rtmp://live.twitch.tv/app" : "https://example.com/whip/stream"}
            spellCheck={false}
            disabled={active.status !== "idle" && active.status !== "error"}
            className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
          />
          <div className="flex items-center gap-2">
            <KeyRound size={11} className="text-slate-500" />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={mode === "rtmp" ? "Stream key (optional)" : "Bearer token (optional)"}
              spellCheck={false}
              type="password"
              disabled={active.status !== "idle" && active.status !== "error"}
              className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500 w-48"
            />
          </div>
          <button
            onClick={() => persistConfig(mode, url, token)}
            disabled={saving || (active.status !== "idle" && active.status !== "error")}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs rounded border border-slate-700 transition-all"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-[10px] text-slate-600">
          {mode === "rtmp"
            ? "WebCodecs H.264 in the app piped to ffmpeg (-c copy, no re-encode) for YouTube/Facebook/Twitch ingest. Requires ffmpeg on PATH."
            : "WebRTC-HTTP Ingestion Protocol. Paste the full WHIP endpoint (e.g. from Cloudflare Stream, SRS, or MediaMTX). The token is sent as a Bearer header."}
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Composer preview + transport */}
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black" style={{ aspectRatio: "16/9" }}>
            <ProgramFeedPreview
              geometry={{ width: 1920, height: 1080 }}
              fps={30}
              onStream={handleStream}
              className="absolute inset-0 w-full h-full"
            />
            {live && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE
              </div>
            )}
            {connecting && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500 text-black text-[10px] font-black uppercase tracking-widest">
                <Signal size={10} className="animate-pulse" /> CONNECTING
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {live || connecting ? (
              <button
                onClick={handleStop}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Square size={11} fill="currentColor" /> Stop Stream
              </button>
            ) : (
              <button
                onClick={handleGoLive}
                disabled={!streamReady || !url.trim()}
                title={
                  !url.trim()
                    ? `Enter a ${mode === "rtmp" ? "RTMP" : "WHIP"} endpoint first`
                    : !streamReady
                      ? "Program feed not ready"
                      : "Go live"
                }
                className="flex-1 py-2.5 rounded-md bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Play size={11} /> Go Live
              </button>
            )}
          </div>

          {active.error && (
            <p className="text-[11px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1.5">
              {active.error}
            </p>
          )}
          {live && mode === "whip" && streamer.resourceUrl && (
            <p className="text-[10px] text-emerald-500 bg-emerald-900/20 border border-emerald-900/50 rounded px-2 py-1.5 break-all">
              WHIP resource: {streamer.resourceUrl}
            </p>
          )}
        </div>

        {/* Explanation panel */}
        <div className="flex flex-col gap-3 p-4 rounded-lg border border-slate-700/60 bg-slate-900/40">
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
            <Radio size={11} /> About {mode === "rtmp" ? "RTMP" : "WHIP"} Streaming
          </h3>
          <ul className="flex flex-col gap-2 text-[11px] text-slate-400 list-none">
            {mode === "rtmp" ? (
              <>
                <li>
                  <span className="text-slate-200 font-bold">How it works:</span> the compositor stream is encoded
                  once with WebCodecs (H.264) and piped to ffmpeg, which muxes to FLV and publishes to any RTMP ingest
                  (YouTube, Facebook, Twitch).
                </li>
                <li>
                  <span className="text-slate-200 font-bold">Latency:</span> ~2–5s (RTMP ingest buffers) — higher than
                  WHIP but compatible with every major platform.
                </li>
                <li>
                  <span className="text-slate-200 font-bold">ffmpeg:</span> must be installed and on PATH. Encoding
                  happens in the app (hardware-accelerated where available); ffmpeg never re-encodes.
                </li>
                <li>
                  <span className="text-slate-200 font-bold">Recording:</span> the same compositor drives the Recorder
                  workspace, so a stream can be recorded locally at the same time.
                </li>
              </>
            ) : (
              <>
                <li>
                  <span className="text-slate-200 font-bold">How it works:</span> the compositor stream is uploaded over
                  WebRTC to any WHIP-compatible server (Cloudflare Stream, SRS, MediaMTX, Eyevinn). The server answers
                  with an SDP session; WebView2 handles the RTP transport natively.
                </li>
                <li>
                  <span className="text-slate-200 font-bold">Latency:</span> sub-second — far lower than RTMP, because
                  there is no ingest buffer.
                </li>
                <li>
                  <span className="text-slate-200 font-bold">Firewalls:</span> if STUN-only fails, the endpoint should
                  provide TURN servers (the operator can add them to <code>useStreamer</code> iceServers).
                </li>
                <li>
                  <span className="text-slate-200 font-bold">Recording:</span> the same compositor drives the Recorder
                  workspace, so a stream can be recorded locally at the same time.
                </li>
              </>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}