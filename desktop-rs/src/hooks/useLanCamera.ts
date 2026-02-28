import { useState, useEffect, useRef, useCallback } from "react";
import type { CameraSource } from "../types";

const STUN_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceCandidatePoolSize: 10,
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

  // Relay connections to the Output Window
  const relayPcRef = useRef<Record<string, RTCPeerConnection | null>>({ A: null, B: null });
  const relaySenderRef = useRef<Record<string, RTCRtpSender | null>>({ A: null, B: null });

  // Initialize a persistent relay connection for a specific slot (A or B)
  const initRelayPc = useCallback(async (slot: 'A' | 'B') => {
    const existingPc = relayPcRef.current[slot];
    if (existingPc && existingPc.iceConnectionState === 'connected') {
        const offer = await existingPc.createOffer();
        await existingPc.setLocalDescription(offer);
        operatorWsRef.current?.send(JSON.stringify({
            cmd: "camera_offer",
            device_id: `hub_relay_${slot.toLowerCase()}`,
            target: "window:output",
            sdp: offer.sdp
        }));
        return;
    }

    if (existingPc) existingPc.close();
    
    const pc = new RTCPeerConnection(STUN_CONFIG);
    relayPcRef.current[slot] = pc;

    // Create a dummy video track
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d");
    if (ctx) { ctx.fillStyle = "black"; ctx.fillRect(0, 0, 640, 360); }
    const stream = canvas.captureStream(1);
    const track = stream.getVideoTracks()[0];
    
    relaySenderRef.current[slot] = pc.addTrack(track, stream);

    pc.onicecandidate = (ev) => {
      if (ev.candidate && operatorWsRef.current?.readyState === WebSocket.OPEN) {
        operatorWsRef.current.send(JSON.stringify({
          cmd: "camera_ice",
          device_id: `hub_relay_${slot.toLowerCase()}`,
          target: "window:output",
          candidate: ev.candidate
        }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    if (operatorWsRef.current?.readyState === WebSocket.OPEN) {
      operatorWsRef.current.send(JSON.stringify({
        cmd: "camera_offer",
        device_id: `hub_relay_${slot.toLowerCase()}`,
        target: "window:output",
        sdp: offer.sdp
      }));
    }
  }, []);

  const handlePreviewOffer = useCallback(async (msg: { device_id: string; device_name?: string; sdp: string }) => {
    const { device_id, sdp } = msg;
    const oldPc = previewPcMapRef.current.get(device_id);
    if (oldPc) {
      oldPc.close();
      previewPcMapRef.current.delete(device_id);
    }

    const pc = new RTCPeerConnection(STUN_CONFIG);

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
    previewPcMapRef.current.set(device_id, pc);

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
    // Dynamically resolve the backend host if accessed via browser on another machine
    const host = window.location.hostname === 'localhost' || window.location.hostname === 'tauri.localhost' || !window.location.hostname
      ? '127.0.0.1' 
      : window.location.hostname;
    
    const ws = new WebSocket(`ws://${host}:7420/ws`);
    operatorWsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: "auth", pin: authPin, client_type: "window:main" }));
      // Initialize relay slots to output window once connected
      setTimeout(() => {
        initRelayPc('A');
        initRelayPc('B');
      }, 1000);
    };
    ws.onmessage = async (e) => {
      let msg: any; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "auth_ok") return;

      // Handle Relay Answer from Output Window
      if (msg.cmd === "camera_answer" && msg.device_id.startsWith("hub_relay_")) {
        const slot = msg.device_id.endsWith("_a") ? 'A' : 'B';
        const pc = relayPcRef.current[slot];
        if (pc && msg.sdp) {
          try { await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }); } catch {}
        }
        return;
      }
      // Handle Relay ICE from Output Window
      if (msg.cmd === "camera_ice" && msg.device_id.startsWith("hub_relay_")) {
        const slot = msg.device_id.endsWith("_a") ? 'A' : 'B';
        const pc = relayPcRef.current[slot];
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        }
        return;
      }

      // Handle Device Telemetry
      if (msg.cmd === "camera_telemetry") {
        setCameraSources(prev => {
          const next = new Map(prev);
          const src = next.get(msg.device_id);
          if (src) {
            next.set(msg.device_id, {
              ...src,
              battery: msg.battery,
              lastTelemetryAt: Date.now()
            });
          }
          return next;
        });
        return;
      }

      // Handle output_ready from any output window (allows multi-window relay)
      if (msg.cmd === "output_ready") {
        initRelayPc('A');
        initRelayPc('B');
        return;
      }

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
  }, [handlePreviewOffer, initRelayPc]);

  useEffect(() => {
    if (pin) connectOperatorWs(pin);
    return () => {
      operatorWsRef.current?.close();
      if (relayPcRef.current.A) relayPcRef.current.A.close();
      if (relayPcRef.current.B) relayPcRef.current.B.close();
    };
  }, [pin, connectOperatorWs]);

  const lastLiveDeviceIdsRef = useRef<Record<string, string | null>>({ A: null, B: null });

  // Use this to switch the track being forwarded to the Output Window in a specific slot
  const setLiveCamera = useCallback((device_id: string | null, slot: 'A' | 'B' = 'A') => {
    // Notify the server about the Tally (On Air) status change
    if (device_id !== lastLiveDeviceIdsRef.current[slot]) {
        if (lastLiveDeviceIdsRef.current[slot]) {
            operatorWsRef.current?.send(JSON.stringify({ cmd: "camera_disconnect_program", device_id: lastLiveDeviceIdsRef.current[slot] }));
        }
        if (device_id) {
            operatorWsRef.current?.send(JSON.stringify({ cmd: "camera_connect_program", device_id }));
        }
        lastLiveDeviceIdsRef.current[slot] = device_id;
    }

    const sender = relaySenderRef.current[slot];
    if (!sender || !relayPcRef.current[slot]) return;
    
    if (!device_id) {
      // Send black frame if no camera is live in this slot
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (ctx) { ctx.fillStyle = "black"; ctx.fillRect(0, 0, 640, 360); }
      const stream = canvas.captureStream(1);
      sender.replaceTrack(stream.getVideoTracks()[0]);
      return;
    }

    const pc = previewPcMapRef.current.get(device_id);
    if (!pc) return;
    
    const receiver = pc.getReceivers().find(r => r.track.kind === 'video');
    if (receiver && receiver.track) {
      sender.replaceTrack(receiver.track);
    }
  }, []);

  const enableCameraPreview = useCallback(async (device_id: string) => {
    cameraEnabledRef.current.add(device_id);
    setCameraSources(prev => {
      const next = new Map(prev);
      const src = next.get(device_id);
      if (src) next.set(device_id, { ...src, enabled: true });
      return next;
    });
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
    setLiveCamera, // New method to switch output
  };
}
