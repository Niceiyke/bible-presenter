import React, { useState } from "react";
import { X, Trash2, Search, Filter } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "../store";

export function LogViewer() {
  const { logs, clearLogs, isLogOpen, setIsLogOpen } = useAppStore();
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");

  const filteredLogs = logs.filter(log => {
    const matchesText = log.message.toLowerCase().includes(filter.toLowerCase());
    const matchesLevel = levelFilter === "all" || log.level === levelFilter;
    return matchesText && matchesLevel;
  });

  if (!isLogOpen) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 h-80 bg-slate-950 border-t border-slate-800 z-[100] flex flex-col shadow-2xl">
      <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">System Logs</h3>
          </div>
          <div className="h-4 w-px bg-slate-800" />
          <div className="flex items-center gap-2 bg-black/40 px-2 py-1 rounded border border-slate-800">
            <Search size={12} className="text-slate-500" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter logs..."
              className="bg-transparent border-none outline-none text-[10px] text-slate-300 w-40"
            />
          </div>
          <div className="flex items-center gap-1.5 bg-black/40 px-2 py-1 rounded border border-slate-800">
            <Filter size={12} className="text-slate-500" />
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="bg-transparent border-none outline-none text-[10px] text-slate-300 font-bold"
            >
              <option value="all">All Levels</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
              <option value="debug">Debug</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearLogs}
            className="flex items-center gap-1.5 px-2 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 rounded transition-all text-[9px] font-bold uppercase border border-red-900/30"
          >
            <Trash2 size={12} /> Clear
          </button>
          <button
            onClick={() => setIsLogOpen(false)}
            className="p-1 text-slate-500 hover:text-white transition-all"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 font-mono text-[10px] custom-scrollbar selection:bg-amber-500/30">
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-800 italic">
            <p>No logs found matching your criteria</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredLogs.map((log, i) => (
              <div key={i} className="flex gap-3 px-2 py-1 hover:bg-white/5 rounded transition-colors group">
                <span className="text-slate-600 shrink-0 select-none">
                  {new Date(log.timestamp * 1000).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`font-bold uppercase w-12 shrink-0 select-none ${
                  log.level === 'error' ? 'text-red-500' : 
                  log.level === 'warn' ? 'text-amber-500' : 
                  log.level === 'debug' ? 'text-blue-500' : 
                  'text-emerald-500'
                }`}>
                  [{log.level}]
                </span>
                <span className="text-slate-300 break-all">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
