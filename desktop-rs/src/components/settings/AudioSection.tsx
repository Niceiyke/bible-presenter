import React, { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { PresentationSettings } from "../../types";

interface AudioSectionProps {
  onUpdateSettings: (s: PresentationSettings) => void;
}

export function AudioSection({ onUpdateSettings }: AudioSectionProps) {
  const {
    settings,
    devices, setDevices,
    operatorDevice, setOperatorDevice,
    preacherDevice, setPreacherDevice,
    operatorMuted, setOperatorMuted,
    preacherMuted, setPreacherMuted,
    transcriptionWindowSec, setTranscriptionWindowSec,
    transcriptionConfig, setTranscriptionConfig,
  } = useAppStore();

  useEffect(() => {
    invoke<[string, string][]>("get_audio_devices")
      .then((res) => setDevices(res))
      .catch((err) => console.error("Failed to fetch audio devices:", err));
  }, []);

  const handleUpdateOperatorDevice = (name: string) => {
    setOperatorDevice(name);
    localStorage.setItem("pref_operatorDevice", name);
    invoke("set_operator_device", { deviceName: name }).catch(console.error);
  };

  const handleUpdatePreacherDevice = (name: string) => {
    setPreacherDevice(name);
    localStorage.setItem("pref_preacherDevice", name);
    invoke("set_preacher_device", { deviceName: name }).catch(console.error);
  };

  const handleToggleOperatorMute = (val: boolean) => {
    setOperatorMuted(val);
    invoke("set_operator_muted", { muted: val }).catch(console.error);
  };

  const handleTogglePreacherMute = (val: boolean) => {
    setPreacherMuted(val);
    invoke("set_preacher_muted", { muted: val }).catch(console.error);
  };

  const handleUpdateTranscriptionWindow = (sec: number) => {
    setTranscriptionWindowSec(sec);
    localStorage.setItem("pref_transcriptionWindowSec", String(sec));
    invoke("set_transcription_window", { samples: Math.round(sec * 16000) }).catch(console.error);
  };

  return (
    <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-xl">
      <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
        Audio Input Sources
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Operator Microphone */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-amber-500 font-bold uppercase">Operator Microphone (Director)</p>
            <button
              onClick={() => handleToggleOperatorMute(!operatorMuted)}
              className={`px-2 py-0.5 text-[9px] font-black uppercase rounded border transition-all ${
                operatorMuted
                  ? "bg-red-600 border-red-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300"
              }`}
            >
              {operatorMuted ? "MUTED" : "MUTE"}
            </button>
          </div>
          <p className="text-[9px] text-slate-500 leading-tight">Controls Bible verse selection via local AI. Best with Push-to-Talk.</p>

          <select
            value={operatorDevice}
            onChange={(e) => handleUpdateOperatorDevice(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
          >
            <option value="">System Default</option>
            {devices.map(([label, value]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Inference Mode</span>
            <div className="flex gap-1">
              {["local", "cloud"].map(m => (
                <button
                  key={m}
                  onClick={() => {
                    const next = { ...transcriptionConfig, operator_mode: m };
                    setTranscriptionConfig(next);
                    invoke("set_cloud_config", { operatorMode: m }).catch(() => {});
                  }}
                  className={`px-2 py-1 text-[9px] font-black uppercase rounded border transition-all ${
                    (transcriptionConfig.operator_mode ?? "local") === m
                      ? "bg-amber-500 border-amber-500 text-black"
                      : "bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-600"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Preacher Microphone */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-blue-400 font-bold uppercase">Preacher Microphone (House)</p>
            <button
              onClick={() => handleTogglePreacherMute(!preacherMuted)}
              className={`px-2 py-0.5 text-[9px] font-black uppercase rounded border transition-all ${
                preacherMuted
                  ? "bg-red-600 border-red-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300"
              }`}
            >
              {preacherMuted ? "MUTED" : "MUTE"}
            </button>
          </div>
          <p className="text-[9px] text-slate-500 leading-tight">Continuous sermon transcription. Best with Cloud (Deepgram/AssemblyAI).</p>

          <select
            value={preacherDevice}
            onChange={(e) => handleUpdatePreacherDevice(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-blue-500"
          >
            <option value="">System Default</option>
            {devices.map(([label, value]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Inference Mode</span>
            <div className="flex gap-1">
              {["local", "cloud"].map(m => (
                <button
                  key={m}
                  onClick={() => {
                    const next = { ...transcriptionConfig, preacher_mode: m };
                    setTranscriptionConfig(next);
                    invoke("set_cloud_config", { preacherMode: m }).catch(() => {});
                  }}
                  className={`px-2 py-1 text-[9px] font-black uppercase rounded border transition-all ${
                    (transcriptionConfig.preacher_mode ?? "cloud") === m
                      ? "bg-blue-500 border-blue-500 text-white"
                      : "bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-600"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-slate-800">
        <div className="flex justify-between items-center mb-1">
          <p className="text-[10px] text-slate-400 font-bold uppercase">Transcription Resolution (Local)</p>
          <span className="text-xs font-mono text-amber-500">{transcriptionWindowSec.toFixed(1)}s samples</span>
        </div>
        <input
          type="range" min="0.5" max="3.0" step="0.5"
          value={transcriptionWindowSec}
          onChange={(e) => handleUpdateTranscriptionWindow(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
        />
        <div className="flex justify-between mt-1">
          <span className="text-[9px] text-slate-600">Fast (High CPU)</span>
          <span className="text-[9px] text-slate-600">Delayed (Low CPU)</span>
        </div>
      </div>
    </div>
  );
}
