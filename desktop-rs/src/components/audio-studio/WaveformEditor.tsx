import React, { useState, useEffect, useRef } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { 
  Pause, Play, Scissors, RefreshCw, Edit2, Save,
  ZoomIn, ZoomOut, RotateCcw, Trash2
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import { useAppStore } from "../../store";

export function WaveformEditor() {
  const { 
    selectedRecording, 
    setSelectedRecording, 
    fetchRecordings,
    handleRenameRecording,
    isTrimming,
    setIsTrimming,
    handleDeleteRecording,
    setError
  } = useAppStore();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaveformLoading, setIsWaveformLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [zoomLevel, setZoomLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const wavesurferRef = useRef<HTMLDivElement>(null);
  const wsInstance = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<any>(null);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!wavesurferRef.current || !selectedRecording?.path) return;

    const container = wavesurferRef.current;
    setIsWaveformLoading(true);
    const url = convertFileSrc(selectedRecording.path);
    
    // Clean up old instance first
    if (wsInstance.current) {
      wsInstance.current.destroy();
      wsInstance.current = null;
    }

    try {
      const regions = RegionsPlugin.create();
      regionsRef.current = regions;

      const ws = WaveSurfer.create({
        container,
        waveColor: '#4f46e5',
        progressColor: '#818cf8',
        cursorColor: '#f59e0b',
        barWidth: 2,
        barRadius: 3,
        height: 160,
        normalize: true,
        url,
        plugins: [regions],
      });

      ws.on('play', () => setIsPlaying(true));
      ws.on('pause', () => setIsPlaying(false));
      ws.on('finish', () => setIsPlaying(false));
      ws.on('ready', () => {
        setIsWaveformLoading(false);
        setDuration(ws.getDuration());
        regions.addRegion({
          start: 0,
          end: ws.getDuration(),
          color: 'rgba(79, 70, 229, 0.2)',
          drag: true,
          resize: true,
        });
      });
      ws.on('error', (err) => {
        console.error("WaveSurfer Error:", err);
        setIsWaveformLoading(false);
        // Only set error if we're still on this recording
        if (wsInstance.current === ws) {
          setError("Failed to load audio. The file might be corrupted or missing.");
        }
      });
      ws.on('timeupdate', (time) => setCurrentTime(time));

      wsInstance.current = ws;
    } catch (e) {
      console.error("WaveSurfer initialization failed:", e);
      setIsWaveformLoading(false);
    }

    return () => {
      if (wsInstance.current) {
        wsInstance.current.destroy();
        wsInstance.current = null;
      }
    };
  }, [selectedRecording?.path, selectedRecording?._ts]); // Re-init on path or explicit refresh timestamp change

  // Apply zoom
  useEffect(() => {
    if (wsInstance.current) {
      wsInstance.current.zoom(zoomLevel);
    }
  }, [zoomLevel]);

  const handleTrim = async () => {
    if (!selectedRecording || !regionsRef.current) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;

    const { start, end } = region;
    if (!window.confirm(`Trim the file to ${start.toFixed(2)}s - ${end.toFixed(2)}s? This will overwrite the original.`)) return;
    
    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", { 
        id: selectedRecording.id, 
        startSec: start, 
        endSec: end 
      });
      // Force refresh by updating timestamp
      setSelectedRecording({ ...selectedRecording, _ts: Date.now() });
      fetchRecordings();
    } catch (err: any) {
      setError("Trim failed: " + err);
    } finally {
      setIsTrimming(false);
    }
  };

  const handleSaveAs = async () => {
    if (!selectedRecording || !regionsRef.current) return;
    const region = regionsRef.current.getRegions()[0];
    if (!region) return;

    const newName = prompt("Enter name for the new clip:", `${selectedRecording.name}_clip`);
    if (!newName) return;

    setIsTrimming(true);
    try {
      await invoke("trim_studio_recording", { 
        id: selectedRecording.id, 
        startSec: region.start, 
        endSec: region.end,
        new_id: newName
      });
      fetchRecordings();
    } catch (err: any) {
      setError("Save As failed: " + err);
    } finally {
      setIsTrimming(false);
    }
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!selectedRecording) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 mb-6 flex items-start justify-between">
        <div>
          {isRenaming ? (
            <div className="flex items-center gap-2 mb-2">
              <input 
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRenameRecording(selectedRecording.id, renameValue).then(() => setIsRenaming(false))}
                onBlur={() => setIsRenaming(false)}
                className="bg-slate-900 border border-indigo-500 text-2xl font-black text-white px-2 py-1 rounded-xl outline-none"
              />
              <button onClick={() => handleRenameRecording(selectedRecording.id, renameValue).then(() => setIsRenaming(false))} className="p-2 bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-600/20"><Save size={20} /></button>
            </div>
          ) : (
            <h2 
              onClick={() => { setIsRenaming(true); setRenameValue(selectedRecording.name); }}
              className="text-2xl font-black text-white mb-2 cursor-pointer hover:text-indigo-400 transition-colors group flex items-center gap-3"
            >
              {selectedRecording.name}
              <Edit2 size={18} className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-500" />
            </h2>
          )}
          <div className="flex items-center gap-4 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
            <span>Format: WAV</span>
            <span>Size: {selectedRecording.size_mb.toFixed(1)} MB</span>
            <span className={selectedRecording.transcribed ? "text-green-500" : "text-amber-500"}>
              {selectedRecording.transcribed ? 'Transcribed' : 'Awaiting Processing'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
           <button 
            onClick={() => handleDeleteRecording(selectedRecording.id)}
            className="p-3 text-slate-500 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all"
            title="Delete Recording"
          >
            <Trash2 size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="bg-slate-900/50 rounded-[2rem] border border-slate-800/50 p-6 relative group mb-6">
          <div className="absolute top-4 right-6 flex items-center gap-4 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
             <div className="flex items-center gap-2 bg-slate-950/80 backdrop-blur-md px-3 py-1.5 rounded-full border border-slate-800">
               <ZoomOut size={14} className="text-slate-500" />
               <input 
                 type="range" 
                 min="0" max="200" 
                 value={zoomLevel} 
                 onChange={(e) => setZoomLevel(parseInt(e.target.value))}
                 className="w-24 accent-indigo-500"
               />
               <ZoomIn size={14} className="text-slate-500" />
             </div>
             <button 
               onClick={() => { setZoomLevel(0); wsInstance.current?.zoom(0); }}
               className="p-2 bg-slate-950/80 backdrop-blur-md rounded-full border border-slate-800 text-slate-400 hover:text-white transition-colors"
               title="Reset Zoom"
             >
               <RotateCcw size={14} />
             </button>
          </div>

          <div className="relative">
            {isWaveformLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/40 z-20 backdrop-blur-sm rounded-2xl">
                <RefreshCw size={32} className="animate-spin text-indigo-500" />
              </div>
            )}
            <div ref={wavesurferRef} className="w-full" />
          </div>

          <div className="flex items-center justify-between mt-4 px-2">
            <span className="text-[10px] font-black text-slate-500 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => wsInstance.current?.playPause()}
              className="w-16 h-16 bg-white text-black rounded-[1.5rem] flex items-center justify-center hover:scale-105 transition-all shadow-xl shadow-white/10 active:scale-95"
            >
              {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
            </button>
            
            <div className="h-10 w-px bg-slate-800 mx-2" />

            <div className="flex gap-2">
              <button 
                onClick={handleTrim}
                disabled={isTrimming || isWaveformLoading}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all shadow-lg shadow-indigo-600/20 flex items-center gap-2 active:scale-95 disabled:opacity-50"
              >
                {isTrimming ? <RefreshCw size={16} className="animate-spin" /> : <Scissors size={16} />}
                Trim to Selection
              </button>
              
              <button 
                onClick={() => {
                  if (regionsRef.current) {
                    const region = regionsRef.current.getRegions()[0];
                    if (region) {
                      region.setOptions({ start: 0, end: duration });
                    }
                  }
                }}
                className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all border border-slate-700 active:scale-95"
              >
                Reset Selection
              </button>
            </div>
          </div>

          <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest text-right max-w-[200px]">
            Drag handles to select audio. <br/>Press SPACE to play/pause.
          </p>
        </div>
      </div>
    </div>
  );
}
