import { useRef, useCallback } from "react";
import { STUN_CONFIG } from "../types";

interface PcEntry {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
}

type OnTrack      = (deviceId: string, stream: MediaStream) => void;
type OnStateChange= (deviceId: string, state: RTCIceConnectionState) => void;
type SendFn       = (payload: object) => void;

/**
 * Manages one RTCPeerConnection per mobile camera (preview path).
 */
export function usePublisherPc(send: SendFn, onTrack: OnTrack, onStateChange: OnStateChange) {
  const pcsRef        = useRef<Map<string, PcEntry>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const videoMapRef   = useRef<Map<string, HTMLVideoElement>>(new Map());

  const _drainIce = useCallback(async (deviceId: string, pc: RTCPeerConnection) => {
    const candidates = pendingIceRef.current.get(deviceId) ?? [];
    pendingIceRef.current.delete(deviceId);
    for (const c of candidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }, []);

  /**
   * Handle an incoming SDP offer from a mobile device. Creates or replaces the preview PC.
   */
  const handleOffer = useCallback(async (deviceId: string, deviceName: string | undefined, sdp: string) => {
    // Close any existing PC for this device
    const old = pcsRef.current.get(deviceId);
    if (old) { old.pc.close(); pcsRef.current.delete(deviceId); }

    const pc = new RTCPeerConnection(STUN_CONFIG);

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      const entry = pcsRef.current.get(deviceId);
      if (entry) { entry.stream = stream; }
      // Attach to video element if already registered
      const el = videoMapRef.current.get(deviceId);
      if (el) el.srcObject = stream;
      onTrack(deviceId, stream);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ cmd: "camera_ice", device_id: deviceId, target: `mobile:${deviceId}`, candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      onStateChange(deviceId, pc.iceConnectionState);
      // ICE restart on transient failure — avoids full reconnect
      if (pc.iceConnectionState === "failed") {
        pc.restartIce();
      }
    };

    pcsRef.current.set(deviceId, { pc, stream: null });

    await pc.setRemoteDescription({ type: "offer", sdp });
    await _drainIce(deviceId, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ cmd: "camera_answer", device_id: deviceId, target: `mobile:${deviceId}`, sdp: answer.sdp });
  }, [send, onTrack, onStateChange, _drainIce]);

  /**
   * Buffer or apply an ICE candidate for a device.
   */
  const addIce = useCallback(async (deviceId: string, candidate: RTCIceCandidateInit) => {
    const entry = pcsRef.current.get(deviceId);
    if (entry) {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    } else {
      const buf = pendingIceRef.current.get(deviceId) ?? [];
      buf.push(candidate);
      pendingIceRef.current.set(deviceId, buf);
    }
  }, []);

  /**
   * Attach a video element to receive the preview stream for a device.
   */
  const attachVideo = useCallback((deviceId: string, el: HTMLVideoElement | null) => {
    if (!el) {
      videoMapRef.current.delete(deviceId);
      return;
    }
    videoMapRef.current.set(deviceId, el);
    const entry = pcsRef.current.get(deviceId);
    if (entry?.stream) el.srcObject = entry.stream;
  }, []);

  /**
   * Get the video receiver track for a device (used for relay forwarding).
   */
  const getVideoTrack = useCallback((deviceId: string): MediaStreamTrack | null => {
    const entry = pcsRef.current.get(deviceId);
    if (!entry) return null;
    const receiver = entry.pc.getReceivers().find(r => r.track.kind === "video");
    return receiver?.track ?? null;
  }, []);

  /**
   * Close and remove the preview PC for a device.
   */
  const closePc = useCallback((deviceId: string) => {
    const entry = pcsRef.current.get(deviceId);
    if (entry) { entry.pc.close(); pcsRef.current.delete(deviceId); }
    pendingIceRef.current.delete(deviceId);
    const el = videoMapRef.current.get(deviceId);
    if (el) el.srcObject = null;
  }, []);

  /**
   * Close all PCs (cleanup on unmount).
   */
  const closeAll = useCallback(() => {
    for (const { pc } of pcsRef.current.values()) pc.close();
    pcsRef.current.clear();
    pendingIceRef.current.clear();
  }, []);

  return { handleOffer, addIce, attachVideo, getVideoTrack, closePc, closeAll };
}
