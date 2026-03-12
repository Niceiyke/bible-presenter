import React, { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { Camera, RefreshCw, Video, Play, Monitor } from "lucide-react";
import type { DisplayItem, CameraBackground } from "../types";

interface CameraTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
}

export function CameraTab({ onStage, onLive }: CameraTabProps) {
  const { 
    availableCameras, 
    selectedCameraId, 
    setSelectedCameraId, 
    refreshCameras,
    settings,
    setSettings,
  } = useAppStore();
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    refreshCameras();
  }, []);

  const getCameraData = (): CameraBackground | null => {
    if (!selectedCameraId) return null;
    return {
      deviceId: selectedCameraId,
      opacity: 1,
      objectFit: "cover",
      mirrored: false,
    };
  };

  const handleStage = () => {
    const data = getCameraData();
    if (data && onStage) onStage({ type: "Camera", data });
  };

  const handleLive = () => {
    const data = getCameraData();
    if (data && onLive) {
      onLive({ type: "Camera", data });
    }
  };

  useEffect(() => {
    if (!selectedCameraId) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      return;
    }

    // Always cleanup existing stream before starting a new one
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    navigator.mediaDevices.getUserMedia({ 
      video: { deviceId: { exact: selectedCameraId } } 
    }).then(stream => {
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    }).catch(err => {
      console.error("CameraTab: failed to get stream", err);
    });

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedCameraId]);

  const setAsGlobalBg = () => {
    const data = getCameraData();
    if (!data) return;
    setSettings({
      ...settings,
      background: {
        type: "Camera",
        value: data
      }
    });
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-200">
      <header className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Camera className="text-amber-500" size={20} />
            <h1 className="text-lg font-bold">Camera System</h1>
          </div>
          <div className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-lg text-[10px] font-black text-slate-500 uppercase tracking-widest">
            Browser Engine Active
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={handleStage}
            disabled={!selectedCameraId}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-lg text-xs font-bold transition-all flex items-center gap-2"
          >
            STAGE
          </button>
          <button 
            onClick={handleLive}
            disabled={!selectedCameraId}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-30 rounded-lg text-xs font-bold text-black transition-all flex items-center gap-2"
          >
            <Play size={14} fill="currentColor" />
            GO LIVE
          </button>
          <div className="w-px h-6 bg-slate-800 mx-2" />
          <button 
            onClick={() => { refreshCameras(); }}
            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-amber-500 transition-colors"
            title="Refresh devices"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 p-6 flex gap-6 overflow-hidden">
        {/* Preview Area */}
        <div className="flex-1 flex flex-col gap-4">
          <div className="aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 relative group">
            <video 
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-contain"
            />
            
            {!selectedCameraId && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 gap-2">
                <Video size={48} />
                <p>No camera selected</p>
              </div>
            )}
            <div className="absolute bottom-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full text-[10px] font-bold text-amber-500 border border-amber-500/30 opacity-0 group-hover:opacity-100 transition-opacity uppercase">
              BROWSER PREVIEW
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={setAsGlobalBg}
              disabled={!selectedCameraId}
              className="py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:hover:bg-amber-600 text-white rounded-xl font-bold transition-all shadow-lg shadow-amber-900/20 flex items-center justify-center gap-2"
            >
              <Monitor size={18} />
              Set as Global Background
            </button>
            <button 
              onClick={() => {
                setSettings({ ...settings, background: { type: "None" } });
              }}
              className="py-3 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-all border border-slate-700 flex items-center justify-center gap-2"
            >
              Clear Background
            </button>
          </div>
        </div>

        {/* Sidebar / Settings */}
        <div className="w-80 flex flex-col gap-6 overflow-y-auto pr-2">
          <section>
            <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Available Devices</h2>
            <div className="flex flex-col gap-2">
              {availableCameras.length === 0 ? (
                <p className="text-sm text-slate-600 italic px-2">Searching for cameras...</p>
              ) : (
                availableCameras.map(cam => (
                  <button
                    key={cam.deviceId}
                    onClick={() => {
                      setSelectedCameraId(cam.deviceId);
                    }}
                    className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                      selectedCameraId === cam.deviceId
                        ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                        : "bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800"
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${selectedCameraId === cam.deviceId ? "bg-amber-500 animate-pulse" : "bg-slate-700"}`} />
                    <span className="text-sm font-medium truncate">{cam.label}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="mt-auto p-4 bg-slate-900/50 border border-slate-800 rounded-xl">
            <h3 className="text-[10px] font-black text-amber-500/70 uppercase tracking-widest mb-1">Quick Actions</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Use <span className="text-amber-400 font-bold">GO LIVE</span> to fill the entire output screen with the camera feed, or <span className="text-amber-400 font-bold">Set as Global Background</span> to use it under other content.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
