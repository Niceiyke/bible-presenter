import React, { useState, useRef, useEffect } from "react";
import { Play, Pause, SkipForward, SkipBack, Volume2, VolumeX, Music, Repeat, Shuffle } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { MediaItem } from "../types";

export function MusicPlayer() {
  const { media } = useAppStore();
  const [currentTrackIdx, setCurrentTrackIdx] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [isMuted, setIsMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLooping, setIsLooping] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const audioFiles = media.filter(m => m.media_type === "Audio");

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  const handleTogglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const handleNext = () => {
    if (audioFiles.length === 0) return;
    let nextIdx = 0;
    if (isShuffle) {
      nextIdx = Math.floor(Math.random() * audioFiles.length);
    } else {
      nextIdx = currentTrackIdx === null ? 0 : (currentTrackIdx + 1) % audioFiles.length;
    }
    setCurrentTrackIdx(nextIdx);
    setIsPlaying(true);
  };

  const handlePrev = () => {
    if (audioFiles.length === 0) return;
    let nextIdx = 0;
    if (currentTrackIdx === null || currentTrackIdx === 0) {
      nextIdx = audioFiles.length - 1;
    } else {
      nextIdx = currentTrackIdx - 1;
    }
    setCurrentTrackIdx(nextIdx);
    setIsPlaying(true);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setProgress((audioRef.current.currentTime / audioRef.current.duration) * 100 || 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current) {
      const time = (parseFloat(e.target.value) / 100) * audioRef.current.duration;
      audioRef.current.currentTime = time;
      setProgress(parseFloat(e.target.value));
    }
  };

  const currentTrack = currentTrackIdx !== null ? audioFiles[currentTrackIdx] : null;

  return (
    <div className="bg-black/50 backdrop-blur-xl border-t border-white/[0.06] px-4 py-2 flex items-center gap-6 h-14">
      {/* Track Info */}
      <div className="flex items-center gap-3 w-64 shrink-0 overflow-hidden">
        <div className="w-10 h-10 bg-gradient-to-br from-amber-400/15 to-indigo-500/15 rounded-lg flex items-center justify-center border border-white/10 shadow-inner">
          <Music size={18} className="text-amber-400" />
        </div>
        <div className="flex flex-col min-w-0">
          <p className="text-xs font-semibold text-slate-200 truncate">
            {currentTrack?.name || "No track selected"}
          </p>
          <p className="text-[10px] text-slate-500 truncate">
            {currentTrack ? "Background Audio" : "Select an audio file from library"}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col gap-1 max-w-xl">
        <div className="flex items-center justify-center gap-4">
          <button 
            onClick={() => setIsShuffle(!isShuffle)}
            className={`p-1 transition-colors ${isShuffle ? "text-indigo-400" : "text-slate-600 hover:text-slate-400"}`}
            title="Shuffle"
          >
            <Shuffle size={14} />
          </button>
          <button onClick={handlePrev} className="p-1 text-slate-400 hover:text-white transition-colors">
            <SkipBack size={18} />
          </button>
          <button 
            onClick={handleTogglePlay}
            className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black rounded-full flex items-center justify-center shadow-lg shadow-amber-500/25 transition-all active:scale-90"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
          </button>
          <button onClick={handleNext} className="p-1 text-slate-400 hover:text-white transition-colors">
            <SkipForward size={18} />
          </button>
          <button 
            onClick={() => setIsLooping(!isLooping)}
            className={`p-1 transition-colors ${isLooping ? "text-indigo-400" : "text-slate-600 hover:text-slate-400"}`}
            title="Loop"
          >
            <Repeat size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-slate-600 w-8 text-right">
            {audioRef.current ? Math.floor(audioRef.current.currentTime / 60) : 0}:{String(Math.floor((audioRef.current?.currentTime || 0) % 60)).padStart(2, '0')}
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={progress}
            onChange={handleSeek}
            className="flex-1 h-1 bg-white/[0.05] accent-indigo-400 rounded-full cursor-pointer"
          />
          <span className="text-[9px] font-mono text-slate-600 w-8">
            {audioRef.current && isFinite(audioRef.current.duration) ? Math.floor(audioRef.current.duration / 60) : 0}:{String(Math.floor((audioRef.current?.duration || 0) % 60)).padStart(2, '0')}
          </span>
        </div>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 w-32 shrink-0">
        <button onClick={() => setIsMuted(!isMuted)} className="text-slate-500 hover:text-white transition-colors">
          {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="flex-1 h-1 bg-white/[0.05] accent-slate-400 rounded-full cursor-pointer"
        />
      </div>

      {/* Hidden Audio Element */}
      <audio
        ref={audioRef}
        src={currentTrack ? convertFileSrc(currentTrack.path) : undefined}
        loop={isLooping}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => {
          if (!isLooping) handleNext();
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        autoPlay={isPlaying}
      />

      {/* Mini Playlist Trigger */}
      <div className="relative group">
        <button className="p-2 text-slate-500 hover:text-white transition-colors border border-white/[0.08] rounded-lg bg-white/[0.03] hover:bg-white/[0.06]">
          <Music size={16} />
        </button>
        <div className="absolute bottom-full right-0 mb-2 w-64 bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl shadow-float overflow-hidden opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-all translate-y-2 group-hover:translate-y-0 z-50">
          <div className="p-3 border-b border-white/[0.06] bg-white/[0.03]">
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Audio Library</h4>
          </div>
          <div className="max-h-64 overflow-y-auto p-1 custom-scrollbar">
            {audioFiles.length === 0 ? (
              <p className="text-[10px] text-slate-600 italic p-4 text-center">No audio files found in media library</p>
            ) : (
              audioFiles.map((track, i) => (
                <button
                  key={track.id}
                  onClick={() => { setCurrentTrackIdx(i); setIsPlaying(true); }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[10px] transition-all flex items-center gap-2 ${
                    currentTrackIdx === i ? "bg-indigo-500/15 text-indigo-300" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  <span className="shrink-0 w-4 text-center text-slate-600">{i + 1}</span>
                  <span className="truncate flex-1">{track.name}</span>
                  {currentTrackIdx === i && isPlaying && <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full dot-flash" />}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
