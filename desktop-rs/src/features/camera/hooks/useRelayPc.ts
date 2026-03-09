import { useRef, useCallback } from "react";
import { STUN_CONFIG } from "../types";

type SendFn = (payload: object) => void;

const SLOTS = ["A", "B"] as const;
type Slot = typeof SLOTS[number];

function slotId(slot: Slot): string {
  return `hub_relay_${slot.toLowerCase()}`;
}

function makeBlackTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 2; canvas.height = 2;
  const ctx = canvas.getContext("2d");
  if (ctx) { ctx.fillStyle = "black"; ctx.fillRect(0, 0, 2, 2); }
  return canvas.captureStream(1).getVideoTracks()[0];
}

interface SlotState {
  pc: RTCPeerConnection;
  sender: RTCRtpSender;
  blackTrack: MediaStreamTrack;
}

/**
 * Manages two relay RTCPeerConnections (slots A and B) from the operator
 * to the output window. Each slot forwards one camera track.
 */
export function useRelayPc(send: SendFn) {
  const slotsRef = useRef<Partial<Record<Slot, SlotState>>>({});

  const init = useCallback(async (slot: Slot) => {
    // Close any existing PC for this slot
    const existing = slotsRef.current[slot];
    if (existing) {
      const s = existing.pc.iceConnectionState;
      if (s === "connected" || s === "completed") return; // already healthy
      existing.pc.close();
    }

    const pc = new RTCPeerConnection(STUN_CONFIG);
    const blackTrack = makeBlackTrack();
    const sender = pc.addTrack(blackTrack);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ cmd: "camera_ice", device_id: slotId(slot), target: "window:output", candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };

    slotsRef.current[slot] = { pc, sender, blackTrack };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ cmd: "camera_offer", device_id: slotId(slot), target: "window:output", sdp: offer.sdp });
  }, [send]);

  const handleAnswer = useCallback(async (slot: Slot, sdp: string) => {
    const s = slotsRef.current[slot];
    if (s) {
      try { await s.pc.setRemoteDescription({ type: "answer", sdp }); } catch {}
    }
  }, []);

  const handleIce = useCallback(async (slot: Slot, candidate: RTCIceCandidateInit) => {
    const s = slotsRef.current[slot];
    if (s) {
      try { await s.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  }, []);

  /**
   * Route the given track (from publisher PC) to the relay slot.
   * Pass null to revert to black frame.
   */
  const setTrack = useCallback((slot: Slot, track: MediaStreamTrack | null) => {
    const s = slotsRef.current[slot];
    if (!s) return;
    s.sender.replaceTrack(track ?? s.blackTrack);
  }, []);

  const slotFromDeviceId = useCallback((deviceId: string): Slot | null => {
    if (deviceId === slotId("A")) return "A";
    if (deviceId === slotId("B")) return "B";
    return null;
  }, []);

  const closeAll = useCallback(() => {
    for (const slot of SLOTS) {
      slotsRef.current[slot]?.pc.close();
    }
    slotsRef.current = {};
  }, []);

  return { init, handleAnswer, handleIce, setTrack, slotFromDeviceId, closeAll };
}
