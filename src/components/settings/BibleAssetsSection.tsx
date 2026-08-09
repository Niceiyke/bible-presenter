import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { StartupStatus } from "../../types";

interface DownloadProgress {
  model_id: string;
  bytes_downloaded: number;
  total_bytes: number;
  percent: number;
  done: boolean;
  error: string | null;
}

export function BibleAssetsSection() {
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [startupStatus, setStartupStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    invoke<StartupStatus>("get_startup_status").then(setStartupStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (e) => {
      const p = e.payload;
      setDownloadProgress((prev) => {
        const next = { ...prev };
        if (p.done && !p.error) {
          delete next[p.model_id];
        } else {
          next[p.model_id] = p;
        }
        return next;
      });

      if (p.done && !p.error) {
        if (p.model_id === "bible_db") {
          window.location.reload();
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleDownloadBibleDb = () => {
    invoke("download_bible_db_cmd").catch((e: any) => {
      console.error(e);
      alert("Failed to start download: " + e);
    });
  };

  const installed = startupStatus?.db_ok ?? false;
  const downloading = !!downloadProgress["bible_db"];

  return (
    <div className="rounded-2xl p-5 surface-card">
      {installed ? (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Core Assets Ready</h2>
            <p className="text-[9px] text-slate-600 mt-0.5">Bible database installed. All scripture &amp; media features available.</p>
          </div>
          {!downloading && (
            <button
              onClick={handleDownloadBibleDb}
              className="px-3 py-1.5 text-[9px] font-black uppercase text-slate-500 hover:text-slate-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg transition-all"
            >
              Re-download
            </button>
          )}
        </div>
      ) : (
        <>
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 dot-flash shadow-[0_0_10px_rgba(245,158,11,0.6)]" />
            Required Core Assets
          </h2>
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.08] flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-bold uppercase">Bible Database</span>
              <span className="text-[9px] font-black bg-red-500/15 text-red-400 px-2 py-0.5 rounded-full border border-red-500/30">MISSING</span>
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">Contains Scripture texts with built-in FTS5 full-text search for all Bible versions.</p>
            {downloading ? (
              <div className="space-y-1">
                <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                  <span>{Math.round(downloadProgress["bible_db"].percent)}%</span>
                  <span>{Math.round(downloadProgress["bible_db"].bytes_downloaded/1024/1024)}MB</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-amber-400 to-amber-600 rounded-full transition-all" style={{ width: `${downloadProgress["bible_db"].percent}%` }} />
                </div>
              </div>
            ) : (
              <button
                onClick={handleDownloadBibleDb}
                className="mt-auto w-full py-2 bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black text-[10px] font-black uppercase rounded-lg transition-all active:scale-[0.98] shadow-lg shadow-amber-500/20"
              >
                Download Bible Database (~380MB)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}