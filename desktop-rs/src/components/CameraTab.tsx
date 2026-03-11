import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { Camera, RefreshCw, Video, Play, Monitor, Zap } from "lucide-react";
import type { DisplayItem, CameraBackground } from "../types";

import { useNativeStream } from "../hooks/useNativeStream";

interface CameraTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
}

function NativePreview({ index, mirrored }: { index: number; mirrored: boolean }) {
  const frameUrl = useNativeStream(true);

  useEffect(() => {
    const start = async () => {
      // Initialize the mixer if it's not already running
      await invoke("start_mixer").catch(() => {}); 
      
      // Select this camera as the mixer source
      await invoke("set_mixer_source", {
        source: {
          id: `preview-${index}`,
          name: `Preview Cam ${index}`,
          source_type: { Camera: { index } },
          z_index: 0, opacity: 1, x: 0, y: 0, w: 100, h: 100
        }
      });
    };

    start();
  }, [index]);

  return (
    <div className="w-full h-full bg-black relative flex items-center justify-center">
      <img 
        src={frameUrl}
        className="max-w-full max-h-full object-contain"
        style={{ transform: mirrored ? "scaleX(-1)" : "none" }}
        alt="Native Stream"
        onLoad={() => {
          // Log success occasionally
          if (Math.random() < 0.01) {
            console.log("Native stream frame rendered successfully");
          }
        }}
        onError={(e) => {
          if (frameUrl) {
            console.error("Native preview image failed to load:", frameUrl);
          }
        }}
      />
      <div className="absolute top-2 right-2 px-2 py-1 bg-amber-500 rounded text-[8px] font-black text-black">
        IPC BRIDGE ACTIVE
      </div>
    </div>
  );
}

export function CameraTab({ onStage, onLive }: CameraTabProps) {
  const { 
    availableCameras, 
    selectedCameraId, 
    setSelectedCameraId, 
    refreshCameras,
    settings,
    setSettings,
    logs
  } = useAppStore();
  
  const [useNativeEngine, setUseNativeEngine] = useState(false);
  const [depStatus, setDepStatus] = useState<{gstreamer_ok: boolean, ndi_ok: boolean, version: string} | null>(null);
  const [nativeCameras, setNativeCameras] = useState<{index: number, name: string}[]>([]);
  const [selectedNativeIndex, setSelectedNativeIndex] = useState<number | null>(null);
  const [ndiSources, setNdiSources] = useState<string[]>([]);
  const [selectedNdi, setSelectedNdi] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    refreshCameras();
    const checkDeps = async () => {
      const status: any = await invoke("check_media_dependencies");
      setDepStatus(status);
      if (status.gstreamer_ok) {
        refreshNative();
        refreshNdi();
      }
    };
    checkDeps();
  }, []);

  const refreshNdi = async () => {
    try {
      const sources: any = await invoke("list_ndi_sources");
      setNdiSources(sources);
    } catch (e) {
      console.error("NDI discovery failed", e);
    }
  };

  const refreshNative = async () => {
    try {
      const cams: any = await invoke("list_native_cameras");
      setNativeCameras(cams);
    } catch (e) {
      console.error("Native list failed", e);
    }
  };

  const handleSelectNative = async (index: number) => {
    setUseNativeEngine(true);
    setSelectedNativeIndex(index);
    setSelectedNdi(null);
    setSelectedCameraId(null); // Release browser camera
    await invoke("set_mixer_source", {
      source: {
        id: `native-${index}`,
        name: `Camera ${index}`,
        source_type: { Camera: { index } },
        z_index: 0, opacity: 1, x: 0, y: 0, w: 100, h: 100
      }
    });
  };

  const handleSelectNdi = async (name: string) => {
    setUseNativeEngine(true);
    setSelectedNdi(name);
    setSelectedNativeIndex(null);
    setSelectedCameraId(null); // Release browser camera
    await invoke("set_mixer_source", {
      source: {
        id: `ndi-${name}`,
        name: `NDI: ${name}`,
        source_type: { NDI: { source_name: name } },
        z_index: 0, opacity: 1, x: 0, y: 0, w: 100, h: 100
      }
    });
  };

  const getCameraData = (): CameraBackground | null => {
    if (useNativeEngine) {
      if (selectedNdi) {
        // We'll treat NDI as a specialized "Camera" device for now
        return {
          deviceId: `ndi:${selectedNdi}`,
          opacity: 1,
          objectFit: "cover",
          mirrored: false,
        };
      }
      if (selectedNativeIndex !== null) {
        return {
          deviceId: `native:${selectedNativeIndex}`,
          opacity: 1,
          objectFit: "cover",
          mirrored: false,
        };
      }
      return null;
    }

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
    if (selectedCameraId) {
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
    }

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

  const cameraLogs = logs.filter(l => 
    l.message.toLowerCase().includes("gstreamer") || 
    l.message.toLowerCase().includes("camera") || 
    l.message.toLowerCase().includes("mixer") ||
    l.message.toLowerCase().includes("ndi")
  );

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-200">
      <header className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Camera className="text-amber-500" size={20} />
            <h1 className="text-lg font-bold">Camera System</h1>
          </div>
          
          <div className="flex items-center bg-slate-900 rounded-lg p-1 border border-slate-800">
            <button 
              onClick={() => setUseNativeEngine(false)}
              className={`px-3 py-1 rounded text-[10px] font-black transition-all ${!useNativeEngine ? "bg-amber-500 text-black shadow-lg" : "text-slate-500 hover:text-slate-300"}`}
            >
              BROWSER ENGINE
            </button>
            <button 
              onClick={() => { setUseNativeEngine(true); refreshNative(); }}
              disabled={!depStatus?.gstreamer_ok}
              className={`px-3 py-1 rounded text-[10px] font-black transition-all flex items-center gap-1.5 disabled:opacity-30 disabled:grayscale ${useNativeEngine ? "bg-amber-500 text-black shadow-lg" : "text-slate-500 hover:text-slate-300"}`}
            >
              <Zap size={10} fill="currentColor" />
              {depStatus?.gstreamer_ok ? "NATIVE RUST ENGINE" : "NATIVE (MISSING GSTREAMER)"}
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={handleStage}
            disabled={!selectedCameraId && selectedNativeIndex === null}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-lg text-xs font-bold transition-all flex items-center gap-2"
          >
            STAGE
          </button>
          <button 
            onClick={handleLive}
            disabled={!selectedCameraId && selectedNativeIndex === null}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-30 rounded-lg text-xs font-bold text-black transition-all flex items-center gap-2"
          >
            <Play size={14} fill="currentColor" />
            GO LIVE
          </button>
          <div className="w-px h-6 bg-slate-800 mx-2" />
          <button 
            onClick={() => { refreshCameras(); refreshNative(); }}
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
            {useNativeEngine && selectedNativeIndex !== null ? (
              <NativePreview index={selectedNativeIndex} mirrored={false} />
            ) : (
              <video 
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
            )}
            
            {!selectedCameraId && selectedNativeIndex === null && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 gap-2">
                <Video size={48} />
                <p>No camera selected</p>
              </div>
            )}
            <div className="absolute bottom-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full text-[10px] font-bold text-amber-500 border border-amber-500/30 opacity-0 group-hover:opacity-100 transition-opacity uppercase">
              {useNativeEngine ? "NATIVE RUST PREVIEW" : "BROWSER PREVIEW"}
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
                      setUseNativeEngine(false);
                      setSelectedCameraId(cam.deviceId);
                      setSelectedNativeIndex(null);
                      setSelectedNdi(null);
                    }}
                    className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                      selectedCameraId === cam.deviceId && !useNativeEngine
                        ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                        : "bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800"
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${selectedCameraId === cam.deviceId && !useNativeEngine ? "bg-amber-500 animate-pulse" : "bg-slate-700"}`} />
                    <span className="text-sm font-medium truncate">{cam.label}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Native Cameras */}
          <section>
            <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">Hardware Devices (Native)</h2>
            <div className="flex flex-col gap-2">
              {nativeCameras.map(cam => (
                <button
                  key={cam.index}
                  onClick={() => handleSelectNative(cam.index)}
                  className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                    selectedNativeIndex === cam.index && useNativeEngine
                      ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                      : "bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800"
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full ${selectedNativeIndex === cam.index && useNativeEngine ? "bg-amber-500 animate-pulse" : "bg-slate-700"}`} />
                  <span className="text-sm font-medium truncate">{cam.name}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">NDI® Sources</h2>
              <button 
                onClick={refreshNdi}
                className="text-[10px] text-amber-500 font-bold hover:text-amber-400"
              >
                Scan
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {ndiSources.length === 0 ? (
                <p className="text-sm text-slate-600 italic px-2">No NDI sources found</p>
              ) : (
                ndiSources.map(source => (
                  <button
                    key={source}
                    onClick={() => handleSelectNdi(source)}
                    className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                      selectedNdi === source && useNativeEngine
                        ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                        : "bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800"
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${selectedNdi === source && useNativeEngine ? "bg-amber-500 animate-pulse" : "bg-slate-700"}`} />
                    <span className="text-sm font-medium truncate">{source}</span>
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

          {/* Camera System Log View */}
          <section className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">System Diagnostics</h2>
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              </div>
              <button 
                onClick={() => {
                  const text = cameraLogs.map(l => `[${new Date(l.timestamp * 1000).toLocaleTimeString([], { hour12: false })}] ${l.message}`).join('\n');
                  navigator.clipboard.writeText(text);
                }}
                className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded border border-slate-700 transition-colors font-bold uppercase"
              >
                Copy Logs
              </button>
            </div>
            <div className="h-48 bg-black/40 rounded-xl border border-slate-800 overflow-y-auto p-2 font-mono text-[9px] flex flex-col gap-1 select-text selection:bg-amber-500/30">
              {cameraLogs
                .slice(0, 50)
                .map((log, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-600 shrink-0">[{new Date(log.timestamp * 1000).toLocaleTimeString([], { hour12: false })}]</span>
                    <span className={log.message.toLowerCase().includes("error") ? "text-red-400" : "text-slate-300"}>
                      {log.message}
                    </span>
                  </div>
                ))}
              {cameraLogs.length === 0 && (
                <div className="flex-1 flex items-center justify-center text-slate-600 italic select-none">
                  No camera logs yet...
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
