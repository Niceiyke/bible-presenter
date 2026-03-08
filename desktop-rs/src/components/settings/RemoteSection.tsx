import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { PresentationSettings } from "../../types";

interface RemoteSectionProps {
  onUpdateSettings: (s: PresentationSettings) => void;
}

export function RemoteSection({ onUpdateSettings }: RemoteSectionProps) {
  const {
    settings,
    remoteUrl,
    lanUrls,
    remotePin, setRemotePin,
    tailscaleUrl,
  } = useAppStore();

  const [remoteClientCount, setRemoteClientCount] = useState(0);
  useEffect(() => {
    const fetchCount = () => invoke<number>("get_remote_client_count").then(setRemoteClientCount).catch(() => {});
    fetchCount();
    const interval = setInterval(fetchCount, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Remote Control</h2>
        <div className="flex flex-col gap-4">
          {/* Connected client indicator */}
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full shrink-0 ${remoteClientCount > 0 ? "bg-green-500" : "bg-slate-600"}`} />
            <span className="text-[10px] text-slate-400">
              {remoteClientCount > 0 ? `${remoteClientCount} client${remoteClientCount !== 1 ? "s" : ""} connected` : "No clients connected"}
            </span>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">LAN URLs</p>
            <div className="flex flex-col gap-2">
              {lanUrls && lanUrls.length > 0 ? (
                lanUrls.map(([name, url]) => (
                  <div key={url} className="flex items-center gap-2">
                    <span className="text-[9px] font-bold text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded uppercase min-w-[40px] text-center">
                      {name}
                    </span>
                    <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono truncate">
                      {url}
                    </code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(url); }}
                      className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                    >Copy</button>
                  </div>
                ))
              ) : (
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono truncate">
                    {remoteUrl || "http://localhost:7420"}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(remoteUrl || "http://localhost:7420"); }}
                    className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                  >Copy</button>
                </div>
              )}
            </div>
          </div>

          {tailscaleUrl && (
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Tailscale URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-teal-400 font-mono truncate">
                  {tailscaleUrl}
                </code>
                <button
                  onClick={() => { navigator.clipboard.writeText(tailscaleUrl); }}
                  className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                >Copy</button>
              </div>
            </div>
          )}

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1.5">PIN</p>
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                {(remotePin || "------").split("").map((digit, i) => (
                  <span
                    key={i}
                    className="w-10 h-12 flex items-center justify-center bg-slate-900 border border-slate-700 rounded-lg text-2xl font-black text-white font-mono"
                  >
                    {digit}
                  </span>
                ))}
              </div>
              <button
                onClick={() => { navigator.clipboard.writeText(remotePin); }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
              <button
                onClick={() => {
                  invoke("regenerate_remote_pin")
                    .then((pin: any) => setRemotePin(pin as string))
                    .catch(() => {});
                }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 rounded-lg transition-colors"
              >↺ New</button>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">NDI & Standalone Output</h2>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] text-slate-300 font-bold uppercase">Enable NDI Stream</p>
              <p className="text-[9px] text-slate-600 mt-0.5">Broadcast output over local network</p>
            </div>
            <button
              onClick={() => {
                const nextEnabled = !settings.ndi_enabled;
                onUpdateSettings({ ...settings, ndi_enabled: nextEnabled });
                invoke("toggle_ndi", { enabled: nextEnabled }).catch(() => {});
              }}
              className={`px-3 py-1.5 text-[10px] font-black uppercase rounded-lg transition-all border ${
                settings.ndi_enabled
                  ? "bg-teal-600 border-teal-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {settings.ndi_enabled ? "NDI ACTIVE" : "NDI OFF"}
            </button>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Remote Server Port</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={settings.remote_port}
                onChange={(e) => onUpdateSettings({ ...settings, remote_port: parseInt(e.target.value) || 7420 })}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono"
              />
              <p className="text-[9px] text-slate-600 w-24">Requires restart to take effect</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">OBS / Browser Source URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-indigo-400 font-mono truncate">
                {remoteUrl ? `${remoteUrl}/output?pin=${remotePin}` : `http://localhost:${settings.remote_port}/output?pin=${remotePin}`}
              </code>
              <button
                onClick={() => {
                  const url = remoteUrl ? `${remoteUrl}/output?pin=${remotePin}` : `http://localhost:${settings.remote_port}/output?pin=${remotePin}`;
                  navigator.clipboard.writeText(url);
                }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
            </div>
            <p className="text-[9px] text-slate-600 mt-1">Use this URL in OBS "Browser Source" for a transparent overlay.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
