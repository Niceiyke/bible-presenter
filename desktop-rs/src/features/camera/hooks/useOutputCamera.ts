import { useRef, useCallback } from "react";
import type { WsCameraOffer, WsCameraIce } from "../types";
import { STUN_CONFIG } from "../types";

type SendFn = (payload: object) => void;

/**
 * Manages camera relay peer connections on the output/projection window side.
 * Handles offers from the operator's relay PCs and routes tracks to video elements.
 */
export function useOutputCamera(send: SendFn) {
  const programPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const programVideoRef = useRef<HTMLVideoElement | null>(null);

  const handleOffer = useCallback(async (msg: WsCameraOffer) => {
    const { device_id, sdp } = msg;
    const oldPc = programPcsRef.current.get(device_id);
    if (oldPc) { oldPc.close(); programPcsRef.current.delete(device_id); }

    const pc = new RTCPeerConnection(STUN_CONFIG);

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      // Slot A → main program video element
      if (device_id === "hub_relay_a" && programVideoRef.current) {
        programVideoRef.current.srcObject = stream;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ cmd: "camera_ice", device_id, target: "window:main", candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };

    programPcsRef.current.set(device_id, pc);
    await pc.setRemoteDescription({ type: "offer", sdp });

    // Drain buffered ICE
    const buffered = pendingIceRef.current.get(device_id) ?? [];
    pendingIceRef.current.delete(device_id);
    for (const c of buffered) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ cmd: "camera_answer", device_id, target: "window:main", sdp: answer.sdp });
  }, [send]);

  const addIce = useCallback(async (deviceId: string, candidate: RTCIceCandidateInit) => {
    const pc = programPcsRef.current.get(deviceId);
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    } else {
      const buf = pendingIceRef.current.get(deviceId) ?? [];
      buf.push(candidate);
      pendingIceRef.current.set(deviceId, buf);
    }
  }, []);

  const closeAll = useCallback(() => {
    for (const pc of programPcsRef.current.values()) pc.close();
    programPcsRef.current.clear();
  }, []);

  return { handleOffer, addIce, closeAll, programVideoRef };
}
