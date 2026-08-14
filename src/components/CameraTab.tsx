import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { usePhoneCameraStreams } from "../hooks/usePhoneCameraHost";
import { Camera, RefreshCw, Video, Play, Monitor, AlertTriangle, Smartphone } from "lucide-react";
import type { DisplayItem, CameraBackground } from "../types";

interface CameraTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
}

type CameraError = "permission" | "device" | "unknown" | null;

interface PhoneCameraInfo {
  device_id: string;
  device_name: string;
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
  const phoneStreams = usePhoneCameraStreams();
  const [phoneCameras, setPhoneCameras] = useState<PhoneCameraInfo[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<CameraError>(null);

  const isPhoneSelected = selectedCameraId?.startsWith("phone-camera-") ?? false;

  // Keep the phone-camera list in sync with the backend registry.
  useEffect(() => {
    invoke<PhoneCameraInfo[]>("list_phone_cameras").then(setPhoneCameras).catch(console.error);
  }, []);

  useTauriEvent("phone-cameras-changed", (e) => {
    setPhoneCameras(e.cameras ?? []);
  });

  // If the selected phone camera goes away (phone disconnected / stopped),
  // drop the selection so the preview doesn't linger on a dead feed.
  useEffect(() => {
    if (isPhoneSelected && !phoneCameras.some((c) => c.device_id === selectedCameraId)) {
      setSelectedCameraId(null);
    }
  }, [phoneCameras, isPhoneSelected, selectedCameraId, setSelectedCameraId]);

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

    // Phone cameras arrive over a WebRTC relay hosted by the main window
    // (see PhoneCameraProvider); their ids are synthetic and can never be
    // opened with getUserMedia. Bind the relayed feed once it arrives.
    if (selectedCameraId.startsWith("phone-camera-")) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      const stream = phoneStreams[selectedCameraId] ?? null;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraError(null);
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
      setCameraError(null);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    }).catch(err => {
      console.error("CameraTab: failed to get stream", err);
      const name = (err as DOMException)?.name ?? "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCameraError("permission");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
        setCameraError("device");
      } else {
        setCameraError("unknown");
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    });

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedCameraId, phoneStreams]);

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
    <div className="flex flex-col gap-6">
      <div className="flex-1 flex flex-col lg:flex-row gap-6">
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
            {isPhoneSelected && !phoneStreams[selectedCameraId!] && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="px-2 py-1 bg-black/60 rounded text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  Connecting phone camera…
                </p>
              </div>
            )}
            <div className="absolute bottom-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full text-[10px] font-bold text-amber-500 border border-amber-500/30 opacity-0 group-hover:opacity-100 transition-opacity uppercase">
              {isPhoneSelected ? "PHONE PREVIEW" : "BROWSER PREVIEW"}
            </div>
          </div>

          {cameraError && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-950/60 border border-red-800/60 text-red-300 text-xs">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-400" />
              <div className="flex-1">
                <p className="font-bold uppercase tracking-wider">
                  {cameraError === "permission" ? "Camera permission denied" : cameraError === "device" ? "Camera not found" : "Camera unavailable"}
                </p>
                <p className="text-red-400/80 mt-0.5">
                  {cameraError === "permission"
                    ? "Allow camera access for this app in Windows Settings, then refresh devices."
                    : cameraError === "device"
                      ? "The selected device is disconnected or no longer available. Pick another camera below."
                      : "An error occurred while opening the camera. Refresh devices and try again."}
                </p>
              </div>
              <button
                onClick={() => { setCameraError(null); refreshCameras(); }}
                className="shrink-0 px-2 py-1 text-[10px] font-black uppercase bg-red-900/50 hover:bg-red-800 rounded-md border border-red-800 transition-all"
              >
                Retry
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={handleLive}
              disabled={!selectedCameraId}
              className="py-3 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl font-bold transition-all shadow-lg flex items-center justify-center gap-2"
            >
              <Play size={18} fill="currentColor" />
              Go Live Now
            </button>
            <button 
              onClick={handleStage}
              disabled={!selectedCameraId}
              className="py-3 px-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-xl font-bold transition-all border border-slate-700 flex items-center justify-center gap-2"
            >
              Stage Preview
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={setAsGlobalBg}
              disabled={!selectedCameraId}
              className="py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-bold transition-all shadow-lg shadow-amber-900/20 flex items-center justify-center gap-2"
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
        <div className="w-full lg:w-80 flex flex-col gap-6">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">Available Devices</h2>
              <button 
                onClick={() => { refreshCameras(); }}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-amber-500 transition-colors"
                title="Refresh devices"
              >
                <RefreshCw size={14} />
              </button>
            </div>
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

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">Phone Cameras</h2>
            </div>
            {phoneCameras.length === 0 ? (
              <p className="text-sm text-slate-600 italic px-2">No phones streaming yet</p>
            ) : (
              <div className="flex flex-col gap-2">
                {phoneCameras.map(cam => (
                  <button
                    key={cam.device_id}
                    onClick={() => {
                      setSelectedCameraId(cam.device_id);
                    }}
                    className={`w-full p-3 rounded-xl border text-left transition-all flex items-center gap-3 ${
                      selectedCameraId === cam.device_id
                        ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                        : "bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800"
                    }`}
                  >
                    <Smartphone size={14} className={selectedCameraId === cam.device_id ? "text-amber-400" : "text-slate-600"} />
                    <div className={`w-2 h-2 rounded-full ${selectedCameraId === cam.device_id ? "bg-amber-500 animate-pulse" : "bg-red-500 animate-pulse"}`} />
                    <span className="text-sm font-medium truncate flex-1">{cam.device_name}</span>
                    <span className="text-[8px] font-black uppercase tracking-widest text-red-500/80 shrink-0">LIVE</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="mt-auto p-4 bg-slate-900/50 border border-slate-800 rounded-xl text-slate-400">
            <h3 className="text-[10px] font-black text-amber-500/70 uppercase tracking-widest mb-1 flex items-center gap-1.5">
              <Camera size={10} /> Camera Mode
            </h3>
            <p className="text-[10px] leading-relaxed">
              Native browser integration. Use <span className="text-amber-400 font-bold">GO LIVE</span> to fill the output screen, or <span className="text-amber-400 font-bold">Global Background</span> to overlay text on camera.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
