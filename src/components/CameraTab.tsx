import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { usePhoneCameraStreams, usePhoneCameraStats } from "../hooks/usePhoneCameraHost";
import { useSharedLocalCameraStream } from "../hooks/useSharedLocalCameraStream";
import { CameraFeed, useLocalFeedStats } from "./shared/CameraFeed";
import PhoneCameraVideo from "./shared/PhoneCameraVideo";
import { Camera, RefreshCw, Video, Play, Monitor, AlertTriangle, Smartphone, Tag, Zap, ArrowLeftRight, Aperture, SlidersHorizontal } from "lucide-react";
import type { DisplayItem, CameraBackground, MediaItem } from "../types";
import type { CameraLook, PhoneCameraOrientation } from "../types/remote";
import { DEFAULT_CAMERA_LOOK, DEFAULT_CAMERA_CHROMA } from "../types/remote";

interface CameraTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
}

type CameraError = "permission" | "device" | "unknown" | null;

interface PhoneCameraInfo {
  device_id: string;
  device_name: string;
  orientation?: PhoneCameraOrientation;
}

const BACKDROP_COLORS = ["#000000", "#0f172a", "#475569", "#ffffff", "#00B140", "#0047AB", "#C41E3A", "#6B21A8"];

export function CameraTab({ onStage, onLive }: CameraTabProps) {
  const { 
    availableCameras, 
    selectedCameraId, 
    setSelectedCameraId, 
    refreshCameras,
    settings,
    setSettings,
    cameraOrientations,
    setCameraOrientation,
    cameraNames,
    setCameraName,
    cameraDefaults,
    setCameraDefaults,
    cameraLook,
    setCameraLook,
    cameraChroma,
    setCameraChroma,
    liveItem,
    setToast,
  } = useAppStore();
  const phoneStreams = usePhoneCameraStreams();
  const phoneStats = usePhoneCameraStats();
  const [phoneCameras, setPhoneCameras] = useState<PhoneCameraInfo[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<CameraError>(null);
  const [renameValue, setRenameValue] = useState("");
  const [abA, setAbA] = useState<string | null>(null);
  const [abB, setAbB] = useState<string | null>(null);

  const isPhoneSelected = selectedCameraId?.startsWith("phone-camera-") ?? false;
  const liveDeviceId = liveItem?.type === "Camera" ? liveItem.data.deviceId : null;

  // Local camera previews share a single cached getUserMedia stream per device
  // across the preview, the A/B switcher and the All Camera Feeds grid, so a
  // camera is never opened more than once at a time.
  const previewLocal = useSharedLocalCameraStream(isPhoneSelected ? null : selectedCameraId, "camera-tab-preview");
  const localStats = useLocalFeedStats(videoRef, isPhoneSelected ? null : selectedCameraId);

  const displayName = (cam: PhoneCameraInfo) => cameraNames[cam.device_id] || cam.device_name;

  // Generic name for any camera id (local webcam or phone camera).
  const cameraDisplayName = (id: string) => {
    const phone = phoneCameras.find((c) => c.device_id === id);
    if (phone) return cameraNames[id] || phone.device_name;
    const local = availableCameras.find((c) => c.deviceId === id);
    return cameraNames[id] || local?.label || "Camera";
  };

  // Unified camera list (local webcams first, then phone cameras) for the
  // A/B switcher and the All Camera Feeds grid.
  const combinedCameras: { id: string; isPhone: boolean }[] = [
    ...availableCameras.map((c) => ({ id: c.deviceId, isPhone: false })),
    ...phoneCameras.map((c) => ({ id: c.device_id, isPhone: true })),
  ];
  const combinedKey = combinedCameras.map((c) => c.id).join("|");

  // Keep the phone-camera list in sync with the backend registry.
  useEffect(() => {
    invoke<PhoneCameraInfo[]>("list_phone_cameras").then(setPhoneCameras).catch(console.error);
  }, []);

  useTauriEvent("phone-cameras-changed", (e) => {
    setPhoneCameras(e.cameras ?? []);
  });

  // Persist the phone-reported physical orientation so auxiliary windows
  // (output, stage) can read it through `usePhoneCameraOrientation`, which
  // shares localStorage across the WebView2 origin.
  useEffect(() => {
    try {
      const map = JSON.parse(localStorage.getItem("reportedCameraOrientations") ?? "{}") as Record<string, unknown>;
      let changed = false;
      for (const cam of phoneCameras) {
        if (cam.orientation && map[cam.device_id] !== cam.orientation) {
          map[cam.device_id] = cam.orientation;
          changed = true;
        }
      }
      if (changed) localStorage.setItem("reportedCameraOrientations", JSON.stringify(map));
    } catch {
      /* localStorage unavailable — reported orientation won't cross windows */
    }
  }, [phoneCameras]);

  // Effective display orientation: the operator's explicit override wins,
  // otherwise fall back to the phone-reported physical orientation.
  const effectiveOrientation = (deviceId: string): PhoneCameraOrientation =>
    cameraOrientations[deviceId] ?? phoneCameras.find((c) => c.device_id === deviceId)?.orientation ?? "portrait";

  const reportedOrientationFor = (deviceId: string): PhoneCameraOrientation | undefined =>
    phoneCameras.find((c) => c.device_id === deviceId)?.orientation;

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

  // Pre-fill the A/B slots with the first two cameras (local webcams first,
  // then phones) once they appear.
  useEffect(() => {
    const ids = combinedCameras.map((c) => c.id);
    if (ids.length >= 1 && !abA) setAbA(ids[0]);
    if (ids.length >= 2 && !abB) setAbB(ids[1]);
  }, [combinedKey, abA, abB]);

  // Surface local-camera stream errors (permission/device/unavailable) with
  // the same messaging the phone-less preview used before.
  useEffect(() => {
    setCameraError(isPhoneSelected ? null : previewLocal.error);
  }, [isPhoneSelected, previewLocal.error]);

  // Keep the rename input in sync when the selected camera changes.
  useEffect(() => {
    if (selectedCameraId) {
      setRenameValue(cameraDisplayName(selectedCameraId));
    } else {
      setRenameValue("");
    }
  }, [selectedCameraId, cameraNames, availableCameras, phoneCameras]);

  const getCameraDataFor = (deviceId: string): CameraBackground => {
    const d = cameraDefaults[deviceId];
    return {
      deviceId,
      opacity: d?.opacity ?? 1,
      objectFit: d?.objectFit ?? "cover",
      mirrored: d?.mirrored ?? false,
      backdropColor: d?.backdropColor ?? undefined,
    };
  };

  const getCameraData = (): CameraBackground | null => {
    if (!selectedCameraId) return null;
    return getCameraDataFor(selectedCameraId);
  };

  const handleRename = (deviceId: string, name: string) => {
    setRenameValue(name);
    setCameraName(deviceId, name);
  };

  const toggleMirror = () => {
    if (selectedCameraId) {
      setCameraDefaults(selectedCameraId, { mirrored: !(cameraDefaults[selectedCameraId]?.mirrored ?? false) });
    }
  };

  const setFit = (fit: "cover" | "contain" | "fill") => {
    if (selectedCameraId) setCameraDefaults(selectedCameraId, { objectFit: fit });
  };

  const setOpacity = (opacity: number) => {
    if (selectedCameraId) setCameraDefaults(selectedCameraId, { opacity });
  };

  const abGoLive = (deviceId: string) => {
    if (onLive) onLive({ type: "Camera", data: getCameraDataFor(deviceId) });
  };

  const abSwap = () => {
    const wasA = abA;
    const wasB = abB;
    setAbA(wasB);
    setAbB(wasA);
    // A production A/B cut: when one slot is on air, swapping also switches the
    // live output to the other camera (now occupying slot A). Otherwise the
    // button would only re-label the two feeds, which is surprising on a live
    // cut switcher.
    if (liveDeviceId === wasA && wasB) {
      if (onLive) onLive({ type: "Camera", data: getCameraDataFor(wasB) });
    } else if (liveDeviceId === wasB && wasA) {
      if (onLive) onLive({ type: "Camera", data: getCameraDataFor(wasA) });
    }
  };

  const mirrorOn = selectedCameraId ? (cameraDefaults[selectedCameraId]?.mirrored ?? false) : false;
  const fitValue = selectedCameraId ? (cameraDefaults[selectedCameraId]?.objectFit ?? "cover") : "cover";
  const opacityValue = selectedCameraId ? (cameraDefaults[selectedCameraId]?.opacity ?? 1) : 1;
  const backdropValue = selectedCameraId ? cameraDefaults[selectedCameraId]?.backdropColor : undefined;
  const abSlots: { label: "A" | "B"; value: string | null; set: (v: string | null) => void }[] = [
    { label: "A", value: abA, set: setAbA },
    { label: "B", value: abB, set: setAbB },
  ];

  const look = selectedCameraId ? cameraLook[selectedCameraId] : undefined;
  const lookSliders: { key: keyof CameraLook; label: string; min: number; max: number; step: number; format: (v: number) => string }[] = [
    { key: "brightness", label: "Brightness", min: 0.5, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    { key: "contrast", label: "Contrast", min: 0.5, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    { key: "zoom", label: "Zoom", min: 1, max: 3, step: 0.05, format: (v) => `${v.toFixed(1)}×` },
    { key: "panX", label: "Pan X", min: -50, max: 50, step: 1, format: (v) => `${v}%` },
    { key: "panY", label: "Pan Y", min: -50, max: 50, step: 1, format: (v) => `${v}%` },
  ];

  const setLook = (key: keyof CameraLook, value: number) => {
    if (selectedCameraId) setCameraLook(selectedCameraId, { [key]: value });
  };

  // Chroma key (green/blue screen) config for the selected camera. Stored per
  // device id so the output window can key the same feed live.
  const chroma = selectedCameraId ? (cameraChroma[selectedCameraId] ?? DEFAULT_CAMERA_CHROMA) : undefined;
  const chromaSliders: { key: "threshold" | "smoothness" | "spill"; label: string; min: number; max: number; step: number; format: (v: number) => string }[] = [
    { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, format: (v) => `${v.toFixed(2)}` },
    { key: "smoothness", label: "Smoothness", min: 0, max: 1, step: 0.01, format: (v) => `${v.toFixed(2)}` },
    { key: "spill", label: "Spill", min: 0, max: 1, step: 0.01, format: (v) => `${v.toFixed(2)}` },
  ];

  const handleSnapshot = async () => {
    const el = videoRef.current;
    if (!el || !el.videoWidth || !el.videoHeight) {
      setToast("Wait for the camera feed to start before taking a snapshot");
      return;
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror the same correction PhoneCameraVideo applies so the saved frame
    // matches the preview: rotate only when the delivered frame contradicts
    // the phone's physical orientation.
    const w = el.videoWidth;
    const h = el.videoHeight;
    const rotate =
      isPhoneSelected &&
      w !== h &&
      (effectiveOrientation(selectedCameraId!) === "portrait" ? w > h : w < h);
    if (rotate) {
      canvas.width = h;
      canvas.height = w;
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(el, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/png");
    try {
      const item = await invoke<MediaItem>("save_camera_snapshot", { dataUrl });
      if (onStage) onStage({ type: "Media", data: item });
      setToast(`Snapshot staged: ${item.name}`);
    } catch (err: any) {
      setToast(`Snapshot failed: ${err?.message ?? err}`);
    }
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
            {selectedCameraId ? (
              <div className="relative w-full h-full">
                {!isPhoneSelected && cameraDefaults[selectedCameraId]?.backdropColor ? (
                  <div className="absolute inset-0" style={{ background: cameraDefaults[selectedCameraId]!.backdropColor }} />
                ) : null}
                <PhoneCameraVideo
                  stream={isPhoneSelected ? (phoneStreams[selectedCameraId] ?? null) : previewLocal.stream}
                  orientation={isPhoneSelected ? effectiveOrientation(selectedCameraId) : null}
                  look={cameraLook[selectedCameraId] ?? null}
                  mirrored={mirrorOn}
                  objectFit="contain"
                  chromaKey={chroma ?? null}
                  videoRef={(el) => { videoRef.current = el; }}
                />
              </div>
            ) : (
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
            {!isPhoneSelected && selectedCameraId && !previewLocal.stream && !previewLocal.error && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="px-2 py-1 bg-black/60 rounded text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  Opening camera…
                </p>
              </div>
            )}
            <div className="absolute bottom-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full text-[10px] font-bold text-amber-500 border border-amber-500/30 opacity-0 group-hover:opacity-100 transition-opacity uppercase">
              {isPhoneSelected ? "PHONE PREVIEW" : "BROWSER PREVIEW"}
            </div>
            {selectedCameraId && (
              <div className="absolute top-2 right-2 px-2 py-1 bg-black/70 backdrop-blur-md rounded-md text-[9px] font-bold text-cyan-300 border border-cyan-500/30 flex items-center gap-2 tabular-nums">
                {isPhoneSelected ? (
                  <>
                    <span>{phoneStats[selectedCameraId]?.fps ?? "—"} fps</span>
                    <span>RTT {phoneStats[selectedCameraId]?.rttMs != null ? `${Math.round(phoneStats[selectedCameraId]!.rttMs!)}ms` : "—"}</span>
                    <span>{phoneStats[selectedCameraId]?.width && phoneStats[selectedCameraId]?.height
                      ? `${phoneStats[selectedCameraId]!.width}×${phoneStats[selectedCameraId]!.height}`
                      : ""}</span>
                  </>
                ) : (
                  <>
                    <span>{localStats.fps ?? "—"} fps</span>
                    <span>{localStats.width && localStats.height ? `${localStats.width}×${localStats.height}` : ""}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {isPhoneSelected && (
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <Smartphone size={12} className="inline mr-1 -mt-0.5" />Phone orientation
              </span>
              <div className="flex rounded-lg overflow-hidden border border-slate-700">
                {(["portrait", "landscape"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setCameraOrientation(selectedCameraId!, mode)}
                    className={`px-3 py-1 text-[10px] font-black uppercase transition-all ${
                      effectiveOrientation(selectedCameraId!) === mode
                        ? "bg-cyan-600 text-white"
                        : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                    }`}
                  >
                    {mode === "portrait" ? "Portrait" : "Landscape"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedCameraId && (
            <>
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <Tag size={12} className="inline mr-1 -mt-0.5" />Camera name
                </span>
                <input
                  value={renameValue}
                  onChange={(e) => handleRename(selectedCameraId!, e.target.value)}
                  placeholder={cameraDisplayName(selectedCameraId)}
                  className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 w-44 focus:outline-none focus:border-amber-500/60"
                  title="Friendly name shown instead of the device default"
                />
              </div>

              <div className="flex items-center gap-3 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 shrink-0">Defaults</span>
                <button
                  onClick={toggleMirror}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition-all ${
                    mirrorOn ? "bg-cyan-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                  }`}
                  title="Mirror this camera's feed when staged"
                >
                  Mirror
                </button>
                <select
                  value={fitValue}
                  onChange={(e) => setFit(e.target.value as "cover" | "contain" | "fill")}
                  className="px-1.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-300"
                  title="Fit when staged"
                >
                  <option value="cover">Cover</option>
                  <option value="contain">Fit</option>
                  <option value="fill">Fill</option>
                </select>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opacityValue}
                  onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  className="flex-1 h-1.5 accent-amber-500 cursor-pointer"
                  title="Opacity when staged"
                />
                <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{Math.round(opacityValue * 100)}%</span>
              </div>

              <div className="flex items-center gap-2 px-1 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 shrink-0">Backdrop</span>
                <div className="flex items-center gap-1.5">
                  {BACKDROP_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCameraDefaults(selectedCameraId!, { backdropColor: c })}
                      className={`w-5 h-5 rounded-full border transition-all ${
                        backdropValue === c ? "border-amber-400 ring-2 ring-amber-400/40" : "border-slate-600 hover:border-slate-400"
                      }`}
                      style={{ background: c }}
                      title={c}
                    />
                  ))}
                  <input
                    type="color"
                    value={backdropValue ?? "#000000"}
                    onChange={(e) => setCameraDefaults(selectedCameraId!, { backdropColor: e.target.value })}
                    className="w-5 h-5 rounded cursor-pointer border border-slate-600"
                    title="Custom backdrop color"
                  />
                  <button
                    onClick={() => setCameraDefaults(selectedCameraId!, { backdropColor: undefined })}
                    className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                  >
                    None
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                  <SlidersHorizontal size={12} /> Color / Crop
                </span>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {lookSliders.map((s) => {
                    const val = look?.[s.key] ?? DEFAULT_CAMERA_LOOK[s.key];
                    return (
                      <label key={s.key} className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                        <span className="w-14 shrink-0">{s.label}</span>
                        <input
                          type="range"
                          min={s.min}
                          max={s.max}
                          step={s.step}
                          value={val}
                          onChange={(e) => setLook(s.key, parseFloat(e.target.value))}
                          className="flex-1 h-1.5 accent-amber-500 cursor-pointer"
                        />
                        <span className="w-9 text-right text-slate-400 shrink-0">{s.format(val)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2 px-1 pt-1 border-t border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                    <Aperture size={12} /> Chroma Key
                  </span>
                  <button
                    onClick={() => setCameraChroma(selectedCameraId!, { enabled: !chroma?.enabled })}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition-all ${
                      chroma?.enabled ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                    }`}
                    title="Remove a solid-color background so only the subject remains"
                  >
                    {chroma?.enabled ? "Enabled" : "Off"}
                  </button>
                </div>
                {chroma?.enabled && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 w-14 shrink-0">Key Color</span>
                      <input
                        type="color"
                        value={chroma.keyColor}
                        onChange={(e) => setCameraChroma(selectedCameraId!, { keyColor: e.target.value })}
                        className="w-7 h-7 rounded cursor-pointer border border-slate-600"
                        title="Background color to remove (use a uniform green or blue screen)"
                      />
                      <span className="text-[10px] text-slate-400 font-mono">{chroma.keyColor}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-y-1.5">
                      {chromaSliders.map((s) => (
                        <label key={s.key} className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                          <span className="w-14 shrink-0">{s.label}</span>
                          <input
                            type="range"
                            min={s.min}
                            max={s.max}
                            step={s.step}
                            value={chroma[s.key]}
                            onChange={(e) => setCameraChroma(selectedCameraId!, { [s.key]: parseFloat(e.target.value) })}
                            className="flex-1 h-1.5 accent-emerald-500 cursor-pointer"
                          />
                          <span className="w-9 text-right text-slate-400 shrink-0">{s.format(chroma[s.key])}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      onClick={() => setCameraChroma(selectedCameraId!, { ...DEFAULT_CAMERA_CHROMA })}
                      className="self-start px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                    >
                      Reset
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

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
                onClick={() => { setCameraError(null); refreshCameras(); previewLocal.retry(); }}
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

          <button
            onClick={handleSnapshot}
            disabled={!selectedCameraId}
            className="w-full py-2.5 px-4 bg-slate-800/80 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-xl font-bold transition-all border border-slate-700 flex items-center justify-center gap-2"
            title="Capture the current frame as an image and stage it"
          >
            <Aperture size={16} />
            Snapshot &amp; Stage
          </button>

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

          {combinedCameras.length > 0 && (
            <>
              {/* All camera feeds (local webcams + phones) */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">All Camera Feeds</h2>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {combinedCameras.map((cam) => (
                    <CameraFeedTile
                      key={cam.id}
                      id={cam.id}
                      isPhone={cam.isPhone}
                      name={cameraDisplayName(cam.id)}
                      selected={selectedCameraId === cam.id}
                      reportedOrientation={reportedOrientationFor(cam.id)}
                      onSelect={() => setSelectedCameraId(cam.id)}
                    />
                  ))}
                </div>
              </section>

              {/* A/B switcher (works for phone AND local cameras) */}
              <section>
                <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <Zap size={12} /> A/B Camera Switcher
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  {abSlots.map((slot) => {
                    const isOnAir = slot.value !== null && slot.value === liveDeviceId;
                    return (
                      <div
                        key={slot.label}
                        className={`rounded-xl border overflow-hidden ${
                          isOnAir ? "border-red-500/60 bg-red-950/20" : "border-slate-800 bg-slate-900/40"
                        }`}
                      >
                        <div className="flex items-center justify-between px-2.5 py-1.5 gap-2">
                          <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">{slot.label}</span>
                          <select
                            value={slot.value ?? ""}
                            onChange={(e) => slot.set(e.target.value || null)}
                            className="max-w-[120px] px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300 border border-slate-700"
                          >
                            <option value="">— none —</option>
                            {combinedCameras.map((c) => (
                              <option key={c.id} value={c.id}>{cameraDisplayName(c.id)}</option>
                            ))}
                          </select>
                        </div>
                        <div className="aspect-video bg-black">
                          {slot.value ? (
                            <CameraFeed
                              deviceId={slot.value}
                              reportedOrientation={reportedOrientationFor(slot.value)}
                              objectFit="cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-600 text-[9px] font-bold uppercase">—</div>
                          )}
                        </div>
                        <button
                          onClick={() => slot.value && abGoLive(slot.value)}
                          disabled={!slot.value}
                          className={`w-full py-1.5 text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${
                            isOnAir
                              ? "bg-red-600 text-white"
                              : "bg-slate-800 hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-200"
                          }`}
                        >
                          <Play size={11} fill="currentColor" /> {isOnAir ? "On Air" : "Go Live"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={abSwap}
                  className="mt-2 w-full py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-bold uppercase tracking-widest text-slate-300 flex items-center justify-center gap-1.5 border border-slate-700"
                >
                  <ArrowLeftRight size={11} /> Swap A and B
                </button>
              </section>
            </>
          )}
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
                    <span className="text-sm font-medium truncate flex-1">{displayName(cam)}</span>
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

/** A single thumbnail in the "All Camera Feeds" grid, showing the live feed
 *  (local webcam or phone camera) plus its resolution and feed state. */
function CameraFeedTile({ id, isPhone, name, selected, reportedOrientation, onSelect }: {
  id: string;
  isPhone: boolean;
  name: string;
  selected: boolean;
  reportedOrientation?: PhoneCameraOrientation;
  onSelect: () => void;
}) {
  const [meta, setMeta] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<{ connected: boolean; error: string | null }>({ connected: false, error: null });

  return (
    <button
      onClick={onSelect}
      className={`relative aspect-video rounded-lg overflow-hidden border transition-all ${
        selected ? "border-amber-500 ring-2 ring-amber-500/40" : "border-slate-800 hover:border-slate-600"
      }`}
      title={name}
    >
      <CameraFeed
        deviceId={id}
        reportedOrientation={reportedOrientation}
        objectFit="cover"
        onMetadata={(w, h) => setMeta({ w, h })}
        onStatus={setStatus}
      />
      {!status.connected && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <p className="text-[8px] font-bold uppercase tracking-widest text-slate-300">
            {status.error ? "No feed" : isPhone ? "Connecting…" : "Opening…"}
          </p>
        </div>
      )}
      {meta && status.connected && (
        <div className="absolute top-1 left-1 px-1 py-0.5 bg-black/70 rounded text-[8px] font-mono font-bold text-slate-300">
          {meta.w}×{meta.h}
        </div>
      )}
      <div
        className={`absolute top-1 right-1 px-1 py-0.5 rounded text-[7px] font-black uppercase tracking-widest flex items-center gap-1 ${
          status.connected ? "bg-green-500/80 text-white" : "bg-slate-700/80 text-slate-300"
        }`}
      >
        {status.connected ? <span className="w-1 h-1 rounded-full bg-white animate-pulse" /> : null}
        {status.connected ? "LIVE" : isPhone ? "CONN" : "OFF"}
      </div>
      <div className="absolute bottom-0 inset-x-0 px-1.5 py-0.5 bg-black/70 text-left">
        <p className="text-[9px] font-bold truncate text-slate-200">{name}</p>
      </div>
      {selected && <div className="absolute bottom-1 right-1 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />}
    </button>
  );
}
