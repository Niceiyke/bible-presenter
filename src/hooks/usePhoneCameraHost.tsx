import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

// The phone opens two WebRTC peers: one targeted at the operator main window
// ("operator") for the Cockpit preview, and one targeted at the projection
// window ("output"). The main window hosts the "operator" answering peer here
// so the phone never disconnects when the output window is closed, and so the
// operator can preview the feed before going live. MediaStreams cannot be
// shared across Tauri windows, which is why the projection window runs its own
// peer instead of consuming this one.

interface PhoneCameraHostValue {
  streams: Record<string, MediaStream>;
}

const PhoneCameraContext = createContext<PhoneCameraHostValue>({ streams: {} });

export function usePhoneCameraStreams(): Record<string, MediaStream> {
  return useContext(PhoneCameraContext).streams;
}

export function PhoneCameraProvider({ children }: { children: React.ReactNode }) {
  const label = useAppStore((s) => s.label);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  useEffect(() => {
    // The provider only ever mounts inside the main operator console (see
    // App.tsx), so this effect must NOT gate on the store `label` — a stale or
    // unexpected value would silently skip listener registration. Each
    // lifecycle step is mirrored to the backend log via `phone_camera_host_log`
    // so we can diagnose the packaged app without DevTools.
    const hostLog = (msg: string) =>
      invoke("phone_camera_host_log", { message: `[provider] ${msg}` }).catch(() => {});

    hostLog(`mounted (label=${label})`);

    const teardown = (deviceId: string) => {
      const pc = pcsRef.current.get(deviceId);
      if (pc) {
        pc.close();
        pcsRef.current.delete(deviceId);
      }
      setStreams((prev) => {
        if (!(deviceId in prev)) return prev;
        const next = { ...prev };
        const stream = next[deviceId];
        delete next[deviceId];
        stream?.getTracks().forEach((t) => t.stop());
        return next;
      });
    };

    const handleOffer = async (deviceId: string, sdp: string) => {
      console.log("[phone-camera] offer received for", deviceId);
      hostLog(`offer received for ${deviceId}`);
      teardown(deviceId);
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pcsRef.current.set(deviceId, pc);

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            invoke("phone_camera_ice", {
              deviceId,
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid ?? "",
              sdpMLineIndex: ev.candidate.sdpMLineIndex ?? 0,
              target: "operator",
            })
              .then(() => console.log("[phone-camera] operator ICE relayed"))
              .catch((e) => console.error("phone_camera_ice failed:", e));
          }
        };

        pc.onconnectionstatechange = () => {
          console.log("[phone-camera] operator peer state:", pc.connectionState);
        };

        pc.ontrack = (ev) => {
          console.log("[phone-camera] ontrack for", deviceId);
          const stream = new MediaStream();
          ev.streams[0]?.getTracks().forEach((t) => stream.addTrack(t));
          ev.track && stream.addTrack(ev.track);
          setStreams((prev) => ({ ...prev, [deviceId]: stream }));
        };

        await pc.setRemoteDescription({ type: "offer", sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await invoke("phone_camera_answer", { deviceId, sdp: answer.sdp ?? "", target: "operator" });
        console.log("[phone-camera] answer sent for", deviceId);
        hostLog(`answer sent for ${deviceId}`);
      } catch (err) {
        console.error("[phone-camera] answer setup failed:", err);
        hostLog(`answer setup failed for ${deviceId}: ${String(err)}`);
        teardown(deviceId);
      }
    };

    let unlistenOffer: (() => void) | null = null;
    let unlistenIce: (() => void) | null = null;
    let unlistenStop: (() => void) | null = null;

    (async () => {
      unlistenOffer = await listen("phone-camera-offer", (e) => {
        const p = e.payload as { device_id: string; sdp: string; target?: string };
        if (p.target === "output") return;
        handleOffer(p.device_id, p.sdp);
      });
      unlistenIce = await listen("phone-camera-ice", (e) => {
        const p = e.payload as { device_id: string; candidate: string; sdp_mid: string; sdp_m_line_index: number; target?: string };
        if (p.target === "output") return;
        const pc = pcsRef.current.get(p.device_id);
        if (pc && p.candidate) {
          console.log("[phone-camera] operator ICE candidate from phone for", p.device_id);
          pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdp_mid, sdpMLineIndex: p.sdp_m_line_index }).catch(
            (err) => console.error("phone ICE failed:", err)
          );
        }
      });
      unlistenStop = await listen("phone-camera-stop", (e) => {
        const deviceId = (e.payload as { device_id: string }).device_id;
        console.log("[phone-camera] stop for", deviceId);
        teardown(deviceId);
      });
      console.log("[phone-camera] main-window phone camera listeners registered (label=" + label + ")");
      hostLog(`listeners registered (label=${label})`);
    })();

    return () => {
      hostLog("unmounted");
      unlistenOffer?.();
      unlistenIce?.();
      unlistenStop?.();
      pcsRef.current.forEach((pc) => pc.close());
      pcsRef.current.clear();
    };
  }, [label]);

  const value = { streams };
  return <PhoneCameraContext.Provider value={value}>{children}</PhoneCameraContext.Provider>;
}