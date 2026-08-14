import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// The phone opens two WebRTC peers: one targeted at the operator main window
// ("operator") for the Cockpit preview, and one targeted at the projection
// window ("output"). The main window hosts the "operator" answering peer here
// so the phone never disconnects when the output window is closed, and so the
// operator can preview the feed before going live. MediaStreams cannot be
// shared across Tauri windows, which is why the projection window runs its own
// peer instead of consuming this one.

interface PhoneCameraHostValue {
  streams: Record<string, MediaStream>;
  states: Record<string, RTCPeerConnectionState>;
}

const PhoneCameraContext = createContext<PhoneCameraHostValue>({ streams: {}, states: {} });

export function usePhoneCameraStreams(): Record<string, MediaStream> {
  return useContext(PhoneCameraContext).streams;
}

export function usePhoneCameraStates(): Record<string, RTCPeerConnectionState> {
  return useContext(PhoneCameraContext).states;
}

export function PhoneCameraProvider({ children }: { children: React.ReactNode }) {
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [states, setStates] = useState<Record<string, RTCPeerConnectionState>>({});
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  const setPeerState = (deviceId: string, state: RTCPeerConnectionState | null) => {
    setStates((prev) => {
      if (state === null || state === "closed") {
        if (!(deviceId in prev)) return prev;
        const next = { ...prev };
        delete next[deviceId];
        return next;
      }
      if (prev[deviceId] === state) return prev;
      return { ...prev, [deviceId]: state };
    });
  };

  useEffect(() => {
    // The provider only ever mounts inside the main operator console (see
    // App.tsx), so it must not gate on the store `label` — a stale or
    // unexpected value would silently skip listener registration.

    const teardown = (deviceId: string) => {
      const pc = pcsRef.current.get(deviceId);
      if (pc) {
        pc.close();
        pcsRef.current.delete(deviceId);
      }
      setPeerState(deviceId, null);
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
            }).catch((e) => console.error("phone_camera_ice failed:", e));
          }
        };

        pc.onconnectionstatechange = () => {
          setPeerState(deviceId, pc.connectionState);
        };

        pc.ontrack = (ev) => {
          const stream = new MediaStream();
          ev.streams[0]?.getTracks().forEach((t) => stream.addTrack(t));
          ev.track && stream.addTrack(ev.track);
          setStreams((prev) => ({ ...prev, [deviceId]: stream }));
        };

        await pc.setRemoteDescription({ type: "offer", sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await invoke("phone_camera_answer", { deviceId, sdp: answer.sdp ?? "", target: "operator" });
      } catch (err) {
        console.error("phone camera answer setup failed:", err);
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
          pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdp_mid, sdpMLineIndex: p.sdp_m_line_index }).catch(
            (err) => console.error("phone ICE failed:", err)
          );
        }
      });
      unlistenStop = await listen("phone-camera-stop", (e) => {
        const deviceId = (e.payload as { device_id: string }).device_id;
        teardown(deviceId);
      });
    })();

    return () => {
      unlistenOffer?.();
      unlistenIce?.();
      unlistenStop?.();
      pcsRef.current.forEach((pc) => pc.close());
      pcsRef.current.clear();
    };
  }, []);

  const value = { streams, states };
  return <PhoneCameraContext.Provider value={value}>{children}</PhoneCameraContext.Provider>;
}