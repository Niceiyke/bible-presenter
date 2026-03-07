import React, { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { 
  Mic, StopCircle, Play, Pause, Scissors, 
  Trash2, FileAudio, Download, RefreshCw,
  Clock, Save, FileUp
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import WaveSurfer from "wavesurfer.js";

export function AudioStudio() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<any>(null);
  const [studioMicLevel, setStudioMicLevel] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState<number | null>(null);
  const [trimEnd, setTrimEnd] = useState<number | null>(null);
  const [transMode, setTransMode] = useState<"local" | "cloud">("local");

  const wavesurferRef = useRef<HTMLDivElement>(null);
  const wsInstance = useRef<WaveSurfer | null>(null);

  useEffect(() => {
    if (!wavesurferRef.current || !selectedRecording) return;

    if (wsInstance.current) {
      wsInstance.current.destroy();
    }

    const ws = WaveSurfer.create({
      container: wavesurferRef.current,
      waveColor: '#4f46e5',
      progressColor: '#818cf8',
      cursorColor: '#f59e0b',
      barWidth: 2,
      barRadius: 3,
      responsive: true,
      height: 200,
      normalize: true,
      url: convertFileSrc(selectedRecording.path),
    });

    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('finish', () => setIsPlaying(false));

    wsInstance.current = ws;
    setTrimStart(null);
    setTrimEnd(null);

    // Load existing transcript if any
    if (selectedRecording.transcribed) {
      invoke<string>("get_studio_recording_transcript", { id: selectedRecording.id })
        .then(setTranscript)
        .catch(console.error);
    } else {
      setTranscript(null);
    }

    return () => ws.destroy();
  }, [selectedRecording]);

  const handleSetStart = () => {
    if (wsInstance.current) {
      setTrimStart(wsInstance.current.getCurrentTime());
    }
  };

  const handleSetEnd = () => {
    if (wsInstance.current) {
      setTrimEnd(wsInstance.current.getCurrentTime());
    }
  };

  const handleTrim = async () => {
    if (!selectedRecording || trimStart === null || trimEnd === null) return;
    if (trimStart >= trimEnd) {
      alert("Start time must be before end time");
      return;
    }
    if (!window.confirm("Trim the file? This will overwrite the original recording.")) return;
    try {
      await invoke("trim_studio_recording", { 
        id: selectedRecording.id, 
        startSec: trimStart, 
        endSec: trimEnd 
      });
      setTrimStart(null);
      setTrimEnd(null);
      // Force reload by updating selectedRecording path slightly or just refetching
      fetchRecordings();
      // Since we overwrite, we might need to re-trigger the useEffect
      const updated = { ...selectedRecording };
      setSelectedRecording(null);
      setTimeout(() => setSelectedRecording(updated), 100);
    } catch (err) {
      console.error(err);
      alert("Trim failed: " + err);
    }
  };

  useEffect(() => {
    const unlistenTrans = listen("studio-transcription-status", (ev: any) => {
      const { id, status, text } = ev.payload;
      if (selectedRecording?.id === id) {
        if (status === "processing") setIsTranscribing(true);
        if (status === "complete") {
          setIsTranscribing(false);
          setTranscript(text);
          fetchRecordings();
        }
      }
    });
    return () => { unlistenTrans.then(f => f()); };
  }, [selectedRecording]);

  const togglePlayPause = () => {
    wsInstance.current?.playPause();
  };

  const handleTranscribe = async () => {
    if (!selectedRecording) return;
    try {
      setIsTranscribing(true);
      await invoke("transcribe_studio_recording", { id: selectedRecording.id, mode: transMode });
    } catch (err) {
      console.error(err);
      setIsTranscribing(false);
      alert("Transcription failed: " + err);
    }
  };

  const handleDelete = async () => {
    if (!selectedRecording) return;
    if (!window.confirm("Delete this recording?")) return;
    try {
      await invoke("delete_studio_recording", { id: selectedRecording.id });
      setSelectedRecording(null);
      fetchRecordings();
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRecordings = () => {
    invoke<any[]>("list_studio_recordings").then(setRecordings).catch(console.error);
  };

  useEffect(() => {
    fetchRecordings();

    // Listen for level updates
    const unlistenLevel = listen("studio-audio-level", (ev: any) => {
      setStudioMicLevel(ev.payload as number);
    });

    const unlistenImport = listen("studio-import-complete", (ev: any) => {
      console.log("Import complete:", ev.payload);
      fetchRecordings();
    });

    const decayInterval = setInterval(() => {
      setStudioMicLevel((prev) => (prev > 0.01 ? prev * 0.85 : 0));
    }, 50);

    return () => {
      unlistenLevel.then(f => f());
      unlistenImport.then(f => f());
      clearInterval(decayInterval);
    };
  }, []);

  const handleStartRecording = async () => {
    try {
      await invoke("start_studio_recording");
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      alert("Failed to start recording: " + err);
    }
  };

  const handleStopRecording = async () => {
    try {
      await invoke("stop_studio_recording");
      setIsRecording(false);
      setTimeout(fetchRecordings, 500);
    } catch (err) {
      console.error(err);
    }
  };

  const handleImport = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "flac"] }],
      });
      if (!selected || typeof selected !== "string") return;
      await invoke("import_studio_audio", { path: selected });
    } catch (err) {
      console.error(err);
      alert("Failed to import audio: " + err);
    }
  };

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">
      <header className="h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
            <Mic size={24} />
          </div>
          <div>
            <h1 className="font-black text-sm uppercase tracking-widest text-slate-200">Audio Studio</h1>
            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Archival & Editing Suite</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
            <button 
              onClick={() => setTransMode("local")}
              className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${transMode === "local" ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-500 hover:text-slate-300"}`}
            >
              Local AI
            </button>
            <button 
              onClick={() => setTransMode("cloud")}
              className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${transMode === "cloud" ? "bg-amber-600 text-white shadow-lg shadow-amber-600/20" : "text-slate-500 hover:text-slate-300"}`}
            >
              Cloud AI
            </button>
          </div>

          <div className="w-px h-6 bg-slate-800 mx-2" />

          {isRecording && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-full animate-pulse">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">Recording</span>
            </div>
          )}
          <div className="flex items-center gap-2 bg-slate-950 px-3 py-2 rounded-xl border border-slate-800 shadow-inner">
            <div className="w-32 h-2 bg-slate-900 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-75 ${isRecording ? 'bg-red-500' : 'bg-indigo-500'}`}
                style={{ width: `${studioMicLevel * 100}%` }}
              />
            </div>
          </div>
          <button 
            onClick={handleImport}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700"
          >
            <FileUp size={16} /> Import Audio
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar: Recordings List */}
        <aside className="w-80 bg-slate-900/50 border-r border-slate-800 flex flex-col">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500">History</h2>
            <button className="text-slate-500 hover:text-white transition-colors">
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
            {recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-600 opacity-50">
                <FileAudio size={32} strokeWidth={1} />
                <p className="text-[10px] font-bold uppercase mt-2 tracking-widest">No Recordings Yet</p>
              </div>
            ) : (
              recordings.map((rec) => (
                <button 
                  key={rec.id}
                  onClick={() => setSelectedRecording(rec)}
                  className={`w-full p-3 rounded-xl border text-left transition-all ${
                    selectedRecording?.id === rec.id 
                      ? "bg-indigo-600/10 border-indigo-500/40" 
                      : "bg-slate-950 border-slate-800 hover:border-slate-700"
                  }`}
                >
                  <p className="text-xs font-bold text-slate-200 truncate">{rec.name}</p>
                  <div className="flex items-center gap-3 mt-1 text-[9px] text-slate-500 font-bold uppercase tracking-wider">
                    <span className="flex items-center gap-1"><Clock size={10} /> {rec.duration}</span>
                    <span>{rec.date}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          
          <div className="p-4 bg-slate-900 border-t border-slate-800">
            <button 
              onClick={isRecording ? handleStopRecording : handleStartRecording}
              className={`w-full py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg ${
                isRecording 
                  ? "bg-red-600 hover:bg-red-500 text-white shadow-red-600/20" 
                  : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20"
              }`}
            >
              {isRecording ? <StopCircle size={18} /> : <Mic size={18} />}
              {isRecording ? "Stop Recording" : "New Recording"}
            </button>
          </div>
        </aside>

        {/* Workspace: Waveform & Editor */}
        <section className="flex-1 flex flex-col bg-slate-950 relative">
          {selectedRecording ? (
            <div className="flex-1 flex flex-col p-8">
              <div className="mb-8">
                <h2 className="text-2xl font-black text-white mb-2">{selectedRecording.name}</h2>
                <div className="flex items-center gap-4 text-xs font-bold text-slate-500 uppercase tracking-widest">
                  <span>Format: WAV</span>
                  <span>Size: {selectedRecording.size} MB</span>
                  <span className="text-indigo-400">Status: {selectedRecording.transcribed ? 'Transcribed' : 'Ready to Process'}</span>
                </div>
              </div>

              {/* Waveform container */}
              <div className="flex-1 flex flex-col gap-6 overflow-hidden">
                <div className="bg-slate-900/50 rounded-3xl border border-slate-800 flex flex-col items-center justify-center relative overflow-hidden group p-4 shrink-0">
                  <div ref={wavesurferRef} className="w-full" />
                  
                  {/* Trim Markers Overlay */}
                  {trimStart !== null && (
                    <div 
                      className="absolute top-0 bottom-0 w-0.5 bg-green-500 z-10"
                      style={{ left: `${(trimStart / (wsInstance.current?.getDuration() || 1)) * 100}%` }}
                    >
                      <span className="absolute top-2 left-2 bg-green-600 text-[8px] font-black px-1 rounded">START</span>
                    </div>
                  )}
                  {trimEnd !== null && (
                    <div 
                      className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
                      style={{ left: `${(trimEnd / (wsInstance.current?.getDuration() || 1)) * 100}%` }}
                    >
                      <span className="absolute top-2 right-2 bg-red-600 text-[8px] font-black px-1 rounded">END</span>
                    </div>
                  )}
                </div>

                <div className="flex gap-4">
                  <button 
                    onClick={handleSetStart}
                    className="flex-1 py-2 bg-slate-800 hover:bg-green-900/30 text-slate-300 hover:text-green-400 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-700 transition-all"
                  >
                    Set Trim Start
                  </button>
                  <button 
                    onClick={handleSetEnd}
                    className="flex-1 py-2 bg-slate-800 hover:bg-red-900/30 text-slate-300 hover:text-red-400 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-700 transition-all"
                  >
                    Set Trim End
                  </button>
                </div>

                {/* Transcription Area */}
                <div className="flex-1 bg-slate-900/30 border border-slate-800/50 rounded-3xl p-6 overflow-y-auto custom-scrollbar">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Transcript</h3>
                    {isTranscribing && (
                      <div className="flex items-center gap-2">
                        <RefreshCw size={12} className="animate-spin text-indigo-400" />
                        <span className="text-[9px] font-bold text-indigo-400 uppercase">AI Processing...</span>
                      </div>
                    )}
                  </div>
                  {transcript ? (
                    <p className="text-slate-300 leading-relaxed font-light text-lg">
                      {transcript}
                    </p>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-700">
                      <p className="text-xs italic">No transcript available. Click 'Transcribe Sermon' below.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Controls */}
              <div className="mt-8 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button 
                    onClick={togglePlayPause}
                    className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform"
                  >
                    {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
                  </button>
                  <div className="flex gap-2">
                    <button 
                      onClick={handleTrim}
                      disabled={trimStart === null || trimEnd === null}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-700 transition-all disabled:opacity-30"
                    >
                      <Scissors size={14} className="inline mr-2" /> Trim Selection
                    </button>
                    <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-700 transition-all">
                      <Save size={14} className="inline mr-2" /> Save Edit
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button 
                    onClick={handleTranscribe}
                    disabled={isTranscribing}
                    className={`px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-indigo-600/20 transition-all disabled:opacity-50`}
                  >
                    {isTranscribing ? "Processing..." : "Transcribe Sermon"}
                  </button>
                  <button 
                    onClick={handleDelete}
                    className="p-2 text-slate-600 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-800">
              <div className="w-24 h-24 bg-slate-900 rounded-3xl flex items-center justify-center mb-6 border border-slate-800">
                <Mic size={48} strokeWidth={1} className="text-slate-700" />
              </div>
              <h3 className="text-xl font-black text-slate-700 uppercase tracking-widest mb-2">Recording Workspace</h3>
              <p className="text-slate-600 max-w-sm text-center text-sm leading-relaxed">
                Select a recording from the history to begin editing or start a new recording session.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
