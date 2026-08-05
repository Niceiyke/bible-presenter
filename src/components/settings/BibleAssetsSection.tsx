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

  return (
    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-xl">
      <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        Required Core Assets
      </h2>

      <div className="grid grid-cols-1 gap-4">
        <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-bold uppercase">Bible Database</span>
            {startupStatus?.db_ok ? (
              <span className="text-[9px] font-black bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-700">INSTALLED</span>
            ) : (
              <span className="text-[9px] font-black bg-red-900/50 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">MISSING</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">Contains Scripture texts with built-in FTS5 full-text search for all Bible versions.</p>
          {downloadProgress["bible_db"] ? (
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                <span>{Math.round(downloadProgress["bible_db"].percent)}%</span>
                <span>{Math.round(downloadProgress["bible_db"].bytes_downloaded/1024/1024)}MB</span>
              </div>
              <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 transition-all" style={{ width: `${downloadProgress["bible_db"].percent}%` }} />
              </div>
            </div>
          ) : !startupStatus?.db_ok && (
            <button
              onClick={handleDownloadBibleDb}
              className="mt-auto w-full py-2 bg-amber-600 hover:bg-amber-500 text-black text-[10px] font-black uppercase rounded-lg transition-all"
            >
              Download Bible Database (~380MB)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
