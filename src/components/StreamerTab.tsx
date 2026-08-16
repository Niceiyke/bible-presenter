import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Signal, Square, Radio, Globe, KeyRound, Play } from "lucide-react";
import { useAppStore } from "../store";
import { useStreamer } from "../hooks/useStreamer";
import { ProgramFeedPreview } from "./outputs/ProgramFeedPreview";
import type { OutputConfig } from "../types";

const STREAM_OUTPUT_ID = "stream-main";

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return "—";
  if (kbps < 1000) return `${kbps} kbps`;
  return `${(kbps / 1000).toFixed(2)} Mbps`;
}

/**
 * `StreamerTab` — Phase 4 WHIP streamer workspace.
 *
 * Shows the live program-feed compositor (the exact pixels being uploaded), a
 * WHIP endpoint configuration (URL + optional bearer token), and a Go Live/Stop
 * transport with connection status and approximate bitrate.
 *
 * The endpoint config persists to the `stream-main` output's `streaming` field
 * through `outputs_update`, so the streamer target survives restarts and stays
 * consistent with the output manager model.
 */
export function StreamerTab() {
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);
  const streamer = useStreamer();
  const streamRef = useRef<MediaStream | null>(null);
  const [streamReady, setStreamReady] = useState(false);

  const output: OutputConfig | undefined = outputs.find((o) => o.id === STREAM_OUTPUT_ID);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  // Hydrate the form from the persisted stream-main config.
  useEffect(() => {
    if (output?.streaming) {
      setUrl((prev) => prev || output!.streaming!.url || "");
      setToken((prev) => prev || output!.streaming!.stream_key || "");
    }
  }, [output]);

  const persistConfig = useCallback(
    async (nextUrl: string, nextToken: string) => {
      setSaving(true);
      try {
        const next = outputs.map((o) =>
          o.id === STREAM_OUTPUT_ID
            ? { ...o, streaming: { mode: "whip" as const, url: nextUrl, stream_key: nextToken || undefined } }
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

  const handleStream = useCallback((stream: MediaStream | null) => {
    streamRef.current = stream;
    setStreamReady(!!stream && stream.getVideoTracks().length > 0);
  }, []);

  const handleGoLive = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    await persistConfig(url, token);
    await streamer.start(stream, { url, token: token || undefined });
  };

  const handleStop = async () => {
    await streamer.stop();
  };

  const live = streamer.status === "live";
  const connecting = streamer.status === "connecting";

  const statusLabel =
    streamer.status === "live"
      ? "Live"
      : streamer.status === "connecting"
        ? "Connecting…"
        : streamer.status === "error"
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
                  : streamer.status === "error"
                    ? "bg-red-900/40 border-red-800 text-red-500"
                    : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {statusLabel}
          </span>
          {live && <span className="text-slate-500 font-mono">{formatBitrate(streamer.bitrateKbps)}</span>}
        </div>
      </div>

      {/* Endpoint configuration */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-slate-700 bg-slate-900/40">
        <div className="flex items-center gap-2">
          <Globe size={11} className="text-slate-500" />
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">WHIP Endpoint</label>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/whip/stream"
            spellCheck={false}
            disabled={streamer.status !== "idle" && streamer.status !== "error"}
            className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
          />
          <div className="flex items-center gap-2">
            <KeyRound size={11} className="text-slate-500" />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bearer token (optional)"
              spellCheck={false}
              type="password"
              disabled={streamer.status !== "idle" && streamer.status !== "error"}
              className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500 w-48"
            />
          </div>
          <button
            onClick={() => persistConfig(url, token)}
            disabled={saving || (streamer.status !== "idle" && streamer.status !== "error")}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs rounded border border-slate-700 transition-all"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-[10px] text-slate-600">
          WebRTC-HTTP Ingestion Protocol. Paste the full WHIP endpoint (e.g. from Cloudflare Stream, SRS, or MediaMTX). The token is sent as a Bearer header.
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
                    ? "Enter a WHIP endpoint first"
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

          {streamer.error && (
            <p className="text-[11px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1.5">
              {streamer.error}
            </p>
          )}
          {live && streamer.resourceUrl && (
            <p className="text-[10px] text-emerald-500 bg-emerald-900/20 border border-emerald-900/50 rounded px-2 py-1.5 break-all">
              WHIP resource: {streamer.resourceUrl}
            </p>
          )}
        </div>

        {/* Explanation panel */}
        <div className="flex flex-col gap-3 p-4 rounded-lg border border-slate-700/60 bg-slate-900/40">
          <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
            <Radio size={11} /> About WHIP Streaming
          </h3>
          <ul className="flex flex-col gap-2 text-[11px] text-slate-400 list-none">
            <li>
              <span className="text-slate-200 font-bold">How it works:</span> the compositor stream is uploaded over
              WebRTC to any WHIP-compatible server (Cloudflare Stream, SRS, MediaMTX, Eyevinn). The server answers with
              an SDP session; WebView2 handles the RTP transport natively.
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
          </ul>
        </div>
      </div>
    </div>
  );
}