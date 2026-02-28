import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CameraSource } from "../types";

const STUN_CONFIG: RTCConfiguration = { 
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ], 
  iceCandidatePoolSize: 10 
};

export function useLanCamera(pin: string | null) {
  const [cameraSources, setCameraSources] = useState<Map<string, CameraSource>>(new Map());
  
  const operatorWsRef = useRef<WebSocket | null>(null);
  const previewPcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const previewVideoMapRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const previewObserverMapRef = useRef<Map<string, IntersectionObserver>>(new Map());
  const pendingOffersRef = useRef<Map<string, { device_id: string; device_name?: string; sdp: string }>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const cameraEnabledRef = useRef<Set<string>>(new Set());

  const handlePreviewOffer = useCallback(async (msg: { device_id: string; device_name?: string; sdp: string }) => {
    const { device_id, sdp } = msg;
    const oldPc = previewPcMapRef.current.get(device_id);
    if (oldPc) {
      oldPc.close();
      // Remove from map immediately so any ICE candidates arriving before
      // setRemoteDescription completes are buffered in pendingIceRef, not
      // silently dropped by addIceCandidate on an uninitialized PC.
      previewPcMapRef.current.delete(device_id);
    }

    const pc = new RTCPeerConnection(STUN_CONFIG);
    // Do NOT register in previewPcMapRef yet — wait until after setRemoteDescription.

    pc.ontrack = (ev: RTCTrackEvent) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      setCameraSources(prev => {
        const next = new Map(prev);
        const src = next.get(device_id);
        if (src) next.set(device_id, { ...src, previewStream: stream, previewPc: pc, status: "connected" });
        return next;
      });
      const videoEl = previewVideoMapRef.current.get(device_id);
      if (videoEl) videoEl.srcObject = stream;
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        operatorWsRef.current?.send(JSON.stringify({
          cmd: "camera_ice",
          device_id,
          target: `mobile:${device_id}`,
          candidate: ev.candidate
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      setCameraSources(prev => {
        const next = new Map(prev);
        const src = next.get(device_id);
        if (!src) return prev;
        const status = (s === "connected" || s === "completed") ? "connected"
          : (s === "failed" || s === "disconnected" || s === "closed") ? "disconnected"
          : "connecting";
        next.set(device_id, { ...src, status });
        return next;
      });
    };

    await pc.setRemoteDescription({ type: "offer", sdp });

    // Register in map only after remote description is set — now safe to add candidates.
    previewPcMapRef.current.set(device_id, pc);

    // Flush any ICE candidates that arrived while setRemoteDescription was in progress.
    const buffered = pendingIceRef.current.get(device_id) ?? [];
    pendingIceRef.current.delete(device_id);
    for (const candidate of buffered) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    operatorWsRef.current?.send(JSON.stringify({
      cmd: "camera_answer",
      device_id,
      target: `mobile:${device_id}`,
      sdp: answer.sdp
    }));
  }, []);

  const connectOperatorWs = useCallback((authPin: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:7420/ws`);
    operatorWsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ cmd: "auth", pin: authPin, client_type: "window:main" }));
    ws.onmessage = async (e) => {
      let msg: any; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "auth_ok") return;
      if (msg.type === "camera_source_connected") {
        setCameraSources(prev => {
          const next = new Map(prev);
          next.set(msg.device_id, { 
            device_id: msg.device_id, 
            device_name: msg.device_name, 
            previewStream: null, 
            previewPc: null, 
            status: "disconnected", 
            connectedAt: Date.now(), 
            enabled: prev.get(msg.device_id)?.enabled ?? false 
          });
          return next;
        });
      }
      if (msg.type === "camera_source_disconnected") {
        const pc = previewPcMapRef.current.get(msg.device_id); if (pc) pc.close(); previewPcMapRef.current.delete(msg.device_id);
        setCameraSources(prev => { const next = new Map(prev); next.delete(msg.device_id); return next; });
      }
      if (msg.cmd === "camera_offer") {
        pendingOffersRef.current.set(msg.device_id, msg);
        // Ensure the source appears in the UI even if camera_source_connected was
        // missed (e.g. operator WS reconnected after the mobile was already online).
        setCameraSources(prev => {
          if (prev.has(msg.device_id)) return prev;
          const next = new Map(prev);
          next.set(msg.device_id, {
            device_id: msg.device_id,
            device_name: msg.device_name ?? msg.device_id.slice(0, 8),
            previewStream: null,
            previewPc: null,
            status: "connecting",
            connectedAt: Date.now(),
            enabled: false,
          });
          return next;
        });
        // Always answer the offer — preview WebRTC connects automatically.
        // The 'enabled' flag controls visibility in the operator panel, not
        // whether the connection is established.
        await handlePreviewOffer(msg);
      }
      if (msg.cmd === "camera_ice") {
        const pc = previewPcMapRef.current.get(msg.device_id);
        if (pc && msg.candidate) try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        else if (msg.candidate) { 
          const buf = pendingIceRef.current.get(msg.device_id) ?? []; 
          buf.push(msg.candidate); 
          pendingIceRef.current.set(msg.device_id, buf); 
        }
      }
    };
    ws.onclose = () => setTimeout(() => { if (operatorWsRef.current?.readyState === WebSocket.CLOSED) connectOperatorWs(authPin); }, 5000);
  }, [handlePreviewOffer]);

  useEffect(() => {
    if (pin) {
      connectOperatorWs(pin);
    }
    return () => {
      operatorWsRef.current?.close();
    };
  }, [pin, connectOperatorWs]);

  const enableCameraPreview = useCallback(async (device_id: string) => {
    cameraEnabledRef.current.add(device_id);
    setCameraSources(prev => {
      const next = new Map(prev);
      const src = next.get(device_id);
      if (src) next.set(device_id, { ...src, enabled: true });
      return next;
    });
    // WebRTC preview connects automatically on offer receipt.
    // Only re-initiate if the PC was lost (closed/failed) and a pending offer exists.
    const existingPc = previewPcMapRef.current.get(device_id);
    if (!existingPc) {
      const pending = pendingOffersRef.current.get(device_id);
      if (pending) await handlePreviewOffer(pending);
    }
  }, [handlePreviewOffer]);

  const disableCameraPreview = useCallback((device_id: string) => {
    cameraEnabledRef.current.delete(device_id);
    const pc = previewPcMapRef.current.get(device_id);
    if (pc) { pc.close(); previewPcMapRef.current.delete(device_id); }
    const videoEl = previewVideoMapRef.current.get(device_id);
    if (videoEl) videoEl.srcObject = null;
    setCameraSources(prev => {
      const next = new Map(prev);
      const src = next.get(device_id);
      if (src) next.set(device_id, { ...src, enabled: false, previewStream: null, previewPc: null, status: "disconnected" });
      return next;
    });
  }, []);

  const removeCameraSource = useCallback((device_id: string) => {
    disableCameraPreview(device_id);
    pendingOffersRef.current.delete(device_id);
    pendingIceRef.current.delete(device_id);
    setCameraSources(prev => {
      const next = new Map(prev);
      next.delete(device_id);
      return next;
    });
  }, [disableCameraPreview]);

  return {
    cameraSources,
    enableCameraPreview,
    disableCameraPreview,
    removeCameraSource,
    previewVideoMapRef,
    previewObserverMapRef,
  };
}
