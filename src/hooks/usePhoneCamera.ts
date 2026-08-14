import { useCallback, useEffect, useRef, useState } from "react";
import { useRemote } from "../remote/wsClient";

export interface PhoneCameraState {
  deviceId: string;
  deviceName: string;
  facingMode: "user" | "environment";
  stream: MediaStream | null;
  peerConnection: RTCPeerConnection | null;
  status: "connecting" | "connected" | "disconnected" | "failed";
}

export function usePhoneCamera(deviceId: string, deviceName: string, facingMode: "user" | "environment" = "environment") {
  const { command, conn, controllerState, isHeldBySelf } = useRemote();
  const [state, setState] = useState<PhoneCameraState>({
    deviceId,
    deviceName,
    facingMode,
    stream: null,
    peerConnection: null,
    status: "disconnected",
  });

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setState(prev => ({ ...prev, stream: null, peerConnection: null, status: "disconnected" }));
  }, []);

  const start = useCallback(async () => {
    if (conn !== "connected" || !isHeldBySelf) {
      console.warn("Phone camera: not connected or not controller");
      return;
    }

    setState(prev => ({ ...prev, status: "connecting" }));

    try {
      // Request camera access on phone
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      streamRef.current = stream;
      setState(prev => ({ ...prev, stream, status: "connected" }));

      // Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Add video track
      stream.getVideoTracks().forEach(track => {
        pc.addTrack(track, stream);
      });

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          command("camera.ice", {
            candidate: event.candidate.candidate,
            sdp_mid: event.candidate.sdpMid,
            sdp_m_line_index: event.candidate.sdpMLineIndex,
            device_id: deviceId,
          }).catch(console.error);
        }
      };

      // Handle connection state
      pc.onconnectionstatechange = () => {
        const newState = pc.connectionState;
        let mappedStatus: PhoneCameraState["status"] = "disconnected";
        if (newState === "connected") mappedStatus = "connected";
        else if (newState === "connecting" || newState === "new") mappedStatus = "connecting";
        else if (newState === "failed") mappedStatus = "failed";
        else if (newState === "disconnected" || newState === "closed") mappedStatus = "disconnected";
        setState(prev => ({ ...prev, status: mappedStatus }));
        if (newState === "failed" || newState === "disconnected" || newState === "closed") {
          cleanup();
        }
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer to main app
      await command("camera.offer", {
        sdp: offer.sdp!,
        device_id: deviceId,
      });

      setState(prev => ({ ...prev, peerConnection: pc }));
    } catch (err) {
      console.error("Phone camera start failed:", err);
      setState(prev => ({ ...prev, status: "failed" }));
      cleanup();
    }
  }, [conn, isHeldBySelf, command, deviceId, facingMode, cleanup]);

  const handleAnswer = useCallback(async (sdp: string) => {
    if (pcRef.current && state.status === "connecting") {
      try {
        await pcRef.current.setRemoteDescription({
          type: "answer",
          sdp,
        });
        setState(prev => ({ ...prev, status: "connected" }));
      } catch (err) {
        console.error("Failed to set remote answer:", err);
        cleanup();
      }
    }
  }, [state.status, cleanup]);

  const handleIce = useCallback(async (candidate: string, sdpMid: string, sdpMLineIndex: number) => {
    if (pcRef.current) {
      try {
        await pcRef.current.addIceCandidate({
          candidate,
          sdpMid,
          sdpMLineIndex,
        });
      } catch (err) {
        console.error("Failed to add ICE candidate:", err);
      }
    }
  }, []);

  // Listen for answer and ICE from main app
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.kind === "camera.answer" && msg.payload?.device_id === deviceId) {
          handleAnswer(msg.payload.sdp);
        } else if (msg.kind === "camera.ice" && msg.payload?.device_id === deviceId) {
          handleIce(msg.payload.candidate, msg.payload.sdp_mid, msg.payload.sdp_m_line_index);
        }
      } catch {
        // Ignore parse errors
      }
    };

    // We need to hook into the WebSocket message handler
    // This is a simplified approach - in production, use the wsClient's event system
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [deviceId, handleAnswer, handleIce]);

  const stop = useCallback(async () => {
    await command("camera.stop", { device_id: deviceId });
    cleanup();
  }, [command, deviceId, cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    ...state,
    start,
    stop,
    isConnected: state.status === "connected",
    isConnecting: state.status === "connecting",
  };
}