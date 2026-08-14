import React, { useCallback, useEffect, useRef, useState } from "react";
import { Video, VideoOff, Camera, RotateCcw, Settings, AlertTriangle, Maximize2, Minimize2 } from "lucide-react";
import { useRemote } from "../wsClient";
import { Card, Btn, cx } from "../ui";

type FacingMode = "user" | "environment";

export function CameraPanel({ client, pushToast }: { client: ReturnType<typeof useRemote>; pushToast: (msg: unknown, kind?: "error" | "info") => void }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const deviceId = client.selfId ?? `phone-${Date.now()}`;
  const deviceName = client.selfName || "Phone Camera";

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setIsStreaming(false);
  }, [stream]);

  const startStreaming = useCallback(async () => {
    if (!client.isHeldBySelf) {
      pushToast("You need control to start camera", "error");
      return;
    }

    setError(null);
    setIsStreaming(true);

    try {
      // Get camera stream
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      // Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Add video track
      mediaStream.getVideoTracks().forEach(track => {
        pc.addTrack(track, mediaStream);
      });

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          client.command("camera.ice", {
            candidate: event.candidate.candidate,
            sdp_mid: event.candidate.sdpMid,
            sdp_m_line_index: event.candidate.sdpMLineIndex,
            device_id: deviceId,
          }).catch(console.error);
        }
      };

      // Handle connection state
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          pushToast("Camera connection lost", "error");
          cleanup();
        } else if (pc.connectionState === "connected") {
          pushToast("Camera streaming to operator", "info");
        }
      };

      // Handle track events (for receiving answers)
      pc.ontrack = (event) => {
        // Not needed for sender, but keep for completeness
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send start command and offer
      await client.command("camera.start", {
        device_id: deviceId,
        device_name: deviceName,
        facing_mode: facingMode,
      });

      await client.command("camera.offer", {
        sdp: offer.sdp!,
        device_id: deviceId,
      });

      pushToast("Camera streaming started", "info");
    } catch (err) {
      console.error("Camera start failed:", err);
      const msg = err instanceof Error ? err.message : "Failed to start camera";
      setError(msg);
      pushToast(msg, "error");
      cleanup();
    }
  }, [client, deviceId, deviceName, facingMode, pushToast, cleanup]);

  const stopStreaming = useCallback(async () => {
    try {
      await client.command("camera.stop", { device_id: deviceId });
    } catch {
      // Ignore errors
    }
    cleanup();
    pushToast("Camera stopped", "info");
  }, [client, deviceId, cleanup, pushToast]);

  const toggleFacingMode = useCallback(async () => {
    const newMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(newMode);
    
    if (isStreaming) {
      cleanup();
      // Restart with new facing mode
      setTimeout(() => startStreaming(), 100);
    }
  }, [facingMode, isStreaming, cleanup, startStreaming]);

  // Handle incoming answer and ICE from main app
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.kind === "camera.answer" && msg.payload?.device_id === deviceId) {
          if (pcRef.current) {
            pcRef.current.setRemoteDescription({
              type: "answer",
              sdp: msg.payload.sdp,
            }).catch(console.error);
          }
        } else if (msg.kind === "camera.ice" && msg.payload?.device_id === deviceId) {
          if (pcRef.current) {
            pcRef.current.addIceCandidate({
              candidate: msg.payload.candidate,
              sdpMid: msg.payload.sdp_mid,
              sdpMLineIndex: msg.payload.sdp_m_line_index,
            }).catch(console.error);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [deviceId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  if (client.conn !== "connected") {
    return (
      <Card className="flex-1 flex items-center justify-center p-6">
        <p className="text-slate-400 text-center">
          Connect to Wordlyte to use phone camera
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex-1 flex flex-col gap-4 p-4 min-h-0">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Video size={16} className={isStreaming ? "text-red-400" : "text-slate-400"} />
          Phone Camera
          {isStreaming && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />}
        </h2>
        {isStreaming && (
          <Btn variant="ghost" onClick={() => setIsFullscreen(!isFullscreen)} className="px-2 py-1" title="Toggle fullscreen">
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Btn>
        )}
      </div>

      {/* Video Preview */}
      <div className={cx(
        "relative flex-1 bg-black rounded-xl overflow-hidden border border-slate-800",
        isFullscreen && "fixed inset-0 z-50 rounded-none border-none"
      )}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
          style={{ background: "#000" }}
        />

        {!stream && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 gap-3">
            <Camera size={48} />
            <p className="text-sm">Tap "Start Camera" to begin streaming</p>
            <p className="text-[10px] opacity-70">Requires operator control</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 gap-3 p-4 text-center">
            <AlertTriangle size={48} />
            <p className="text-sm font-semibold">Camera Error</p>
            <p className="text-[11px] opacity-80">{error}</p>
            <Btn variant="ghost" onClick={() => { setError(null); startStreaming(); }} className="mt-2">
              Retry
            </Btn>
          </div>
        )}

        {/* Recording indicator */}
        {isStreaming && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-red-500/90 px-2 py-1 rounded-full text-[10px] font-bold tracking-wider">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            LIVE
          </div>
        )}

        {/* Facing mode indicator */}
        {isStreaming && (
          <div className="absolute top-3 right-3 px-2 py-1 bg-black/60 backdrop-blur rounded-full text-[10px] font-medium text-slate-300 capitalize">
            {facingMode === "user" ? "Selfie" : "Rear"}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="grid grid-cols-2 gap-3">
        {isStreaming ? (
          <>
            <Btn
              variant="danger"
              onClick={stopStreaming}
              className="h-12 flex items-center justify-center gap-2 text-sm font-bold"
            >
              <VideoOff size={18} />
              Stop Camera
            </Btn>
            <Btn
              variant="ghost"
              onClick={toggleFacingMode}
              className="h-12 flex items-center justify-center gap-2 text-sm"
            >
              <RotateCcw size={18} />
              Flip ({facingMode === "user" ? "Rear" : "Selfie"})
            </Btn>
          </>
        ) : (
          <>
            <Btn
              variant="primary"
              onClick={startStreaming}
              disabled={!client.isHeldBySelf}
              className="col-span-2 h-12 flex items-center justify-center gap-2 text-sm font-bold"
            >
              <Video size={18} />
              Start Camera
            </Btn>
            <Btn
              variant="ghost"
              onClick={() => setFacingMode(facingMode === "user" ? "environment" : "user")}
              className="h-10 flex items-center justify-center gap-2 text-[11px]"
            >
              <RotateCcw size={14} />
              Default: {facingMode === "user" ? "Selfie" : "Rear"}
            </Btn>
          </>
        )}
      </div>

      {/* Status info */}
      <div className="flex items-center justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-800">
        <span>
          {client.isHeldBySelf ? "You have control" : "Waiting for control"}
        </span>
        <span className={cx("flex items-center gap-1", isStreaming ? "text-green-400" : "text-slate-500")}>
          <span className={cx("w-1.5 h-1.5 rounded-full", isStreaming ? "bg-green-400 animate-pulse" : "bg-slate-700")} />
          {isStreaming ? "Streaming" : "Idle"}
        </span>
      </div>
    </Card>
  );
}