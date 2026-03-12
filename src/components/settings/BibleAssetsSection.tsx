import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import type { StartupStatus } from "../../types";
import type { DownloadProgress } from "../../store/slices/modelSlice";

export function BibleAssetsSection() {
  const {
    downloadProgress, setDownloadProgress,
    semanticIndexStatus, setSemanticIndexStatus,
    verseIndexStatus, setVerseIndexStatus,
    setWhisperModels,
  } = useAppStore();

  const [startupStatus, setStartupStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    invoke<StartupStatus>("get_startup_status").then(setStartupStatus).catch(() => {});
    invoke<any>("get_semantic_index_status").then(setSemanticIndexStatus).catch(() => {});
    invoke<any>("get_verse_index_status").then(setVerseIndexStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (e) => {
      const p = e.payload;
      const nextProgress = (p.done && !p.error) ? null : p;
      setDownloadProgress(p.model_id, nextProgress);

      if (p.done && !p.error) {
        if (p.model_id === "semantic_index" || p.model_id === "verse_index" || p.model_id === "bible_db") {
          invoke<any>("get_semantic_index_status").then(setSemanticIndexStatus).catch(() => {});
          invoke<any>("get_verse_index_status").then(setVerseIndexStatus).catch(() => {});
          if (p.model_id === "bible_db") {
            window.location.reload();
          }
        } else if (p.model_id === "core_models") {
          invoke<any>("get_startup_status").then(() => {}).catch(() => {});
          window.location.reload();
        } else {
          invoke<any[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
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

  const handleDownloadCoreModels = () => {
    invoke("download_core_search_models_cmd").catch((e: any) => {
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Bible Database & Search Index Card */}
        <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-bold uppercase">Bible Data & Index</span>
            {startupStatus?.db_ok && semanticIndexStatus?.downloaded && verseIndexStatus?.downloaded ? (
              <span className="text-[9px] font-black bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-700">INSTALLED</span>
            ) : (
              <span className="text-[9px] font-black bg-red-900/50 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50 text-xs">MISSING</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">Contains Scripture texts and the AI search index for context-aware verse discovery.</p>
          {downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"] ? (
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                <span>{Math.round((downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).percent)}%</span>
                <span>{Math.round((downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).bytes_downloaded/1024/1024)}MB</span>
              </div>
              <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 transition-all" style={{ width: `${(downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).percent}%` }} />
              </div>
            </div>
          ) : (!startupStatus?.db_ok || !semanticIndexStatus?.downloaded || !verseIndexStatus?.downloaded) && (
            <button
              onClick={handleDownloadBibleDb}
              className="mt-auto w-full py-2 bg-amber-600 hover:bg-amber-500 text-black text-[10px] font-black uppercase rounded-lg transition-all"
            >
              Download Bible Data (~380MB)
            </button>
          )}
        </div>

        {/* AI Neural Search Models Card */}
        <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 font-bold uppercase">Neural Search Models</span>
            {startupStatus?.onnx_model_ok && startupStatus?.reranker_ok ? (
              <span className="text-[9px] font-black bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-700">INSTALLED</span>
            ) : (
              <span className="text-[9px] font-black bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded border border-slate-700">NOT INSTALLED</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">Required for high-precision semantic search and "Pastor Paraphrase" detection.</p>

          {downloadProgress["core_models"] ? (
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                <span>{Math.round(downloadProgress["core_models"].percent)}%</span>
                <span>{Math.round(downloadProgress["core_models"].bytes_downloaded/1024/1024)}MB</span>
              </div>
              <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${downloadProgress["core_models"].percent}%` }} />
              </div>
            </div>
          ) : (!startupStatus?.onnx_model_ok || !startupStatus?.reranker_ok) && (
            <button
              onClick={handleDownloadCoreModels}
              className="mt-auto w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase rounded-lg transition-all"
            >
              Download AI Models (~130MB)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
