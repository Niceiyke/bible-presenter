import React, { useCallback, useEffect, useRef, useState } from "react";
import { Video, VideoOff, Camera, RotateCcw, Settings, AlertTriangle, Maximize2, Minimize2, Sun, ZoomIn } from "lucide-react";
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
  const pcsRef = useRef<{ operator: RTCPeerConnection | null; output: RTCPeerConnection | null }>({ operator: null, output: null });
  // Streaming lifecycle refs so the open-ended peer re-offer loops and zoom/torch
  // constraints can read the live state without re-creating closures.
  const isStreamingRef = useRef(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const deviceId = client.selfId ?? `phone-${Date.now()}`;
  const deviceName = client.selfName || "Phone Camera";
  const canCamera = client.snapshot?.permissions?.camera ?? false;

  const cleanup = useCallback(() => {
    isStreamingRef.current = false;
    trackRef.current = null;
    setZoomCaps(null);
    setZoom(1);
    setTorchSupported(false);
    setTorchOn(false);
    const pcs = [pcsRef.current.operator, pcsRef.current.output];
    pcs.forEach((pc) => pc?.close());
    pcsRef.current = { operator: null, output: null };
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
    isStreamingRef.current = true;

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

      // Read the hardware capabilities so zoom/torch controls only appear when
      // this device/browser actually supports them.
      const track = mediaStream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      if (track) {
        try {
          const caps = track.getCapabilities() as MediaTrackCapabilities & {
            zoom?: { min: number; max: number; step?: number };
            torch?: boolean;
          };
          if (caps?.zoom && Number.isFinite(caps.zoom.min) && Number.isFinite(caps.zoom.max)) {
            setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.01 });
            setZoom(caps.zoom.min > 1 ? caps.zoom.min : 1);
          }
          setTorchSupported(!!caps?.torch);
        } catch {
          // Capabilities unavailable — hide the controls.
        }
      }

      // Create two peer connections: one for the operator main window
      // (preview) and one for the output projection window. Both send the same
      // local video; each window answers its own peer.
      const operatorPc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const outputPc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcsRef.current = { operator: operatorPc, output: outputPc };

      // Add video track to both peers
      mediaStream.getVideoTracks().forEach(track => {
        operatorPc.addTrack(track, mediaStream);
        outputPc.addTrack(track, mediaStream);
      });

      const setupPeer = (pc: RTCPeerConnection, target: "operator" | "output") => {
        // Handle ICE candidates, tagged with the peer target so the backend
        // relays them to the correct operator-side window.
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            client.command("camera.ice", {
              candidate: event.candidate.candidate,
              sdp_mid: event.candidate.sdpMid,
              sdp_m_line_index: event.candidate.sdpMLineIndex,
              device_id: deviceId,
              target,
            }).catch(console.error);
          }
        };
      };

      setupPeer(operatorPc, "operator");
      setupPeer(outputPc, "output");

      // Only the operator peer is authoritative: if it drops, the camera is
      // dead and the operator can no longer see it. The output/projector peer
      // is best-effort — the output window may be closed, so its failure must
      // not tear down the whole camera.
      operatorPc.onconnectionstatechange = () => {
        if (operatorPc.connectionState === "failed" || operatorPc.connectionState === "disconnected") {
          pushToast("Camera connection lost", "error");
          cleanup();
        } else if (operatorPc.connectionState === "connected") {
          pushToast("Camera streaming to operator", "info");
        }
      };
      outputPc.onconnectionstatechange = () => {
        if (outputPc.connectionState === "connected") {
          pushToast("Camera ready on projector", "info");
        }
      };

      const makeOffer = async (pc: RTCPeerConnection, target: "operator" | "output") => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await client.command("camera.offer", {
          sdp: offer.sdp!,
          device_id: deviceId,
          target,
        });
      };

      // Send start command and offers (operator first so the preview connects
      // even if the projection window never answers).
      await client.command("camera.start", {
        device_id: deviceId,
        device_name: deviceName,
        facing_mode: facingMode,
      });

      await makeOffer(operatorPc, "operator");
      await makeOffer(outputPc, "output");

      // Keep re-offering any peer that never connected while the camera is
      // streaming. The operator main window hosts the "operator" answering
      // peer from app startup, but a projection ("output") window that is
      // opened — or a window that reloaded — *after* the phone started would
      // otherwise never pick up the offer. Stops when the peer connects, the
      // camera stops, or the peer object is replaced by a restart.
      const keepReOffering = async (pc: RTCPeerConnection, target: "operator" | "output") => {
        while (
          isStreamingRef.current &&
          pcsRef.current[target] === pc &&
          (pc.connectionState === "new" || pc.connectionState === "connecting")
        ) {
          await new Promise((r) => setTimeout(r, 2500));
          if (!isStreamingRef.current || pcsRef.current[target] !== pc) break;
          if (pc.connectionState !== "new" && pc.connectionState !== "connecting") break;
          try {
            await makeOffer(pc, target);
          } catch {
            break;
          }
        }
      };
      keepReOffering(operatorPc, "operator");
      keepReOffering(outputPc, "output");

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

  const applyZoom = useCallback(async (z: number) => {
    setZoom(z);
    const t = trackRef.current;
    if (!t) return;
    try {
      await t.applyConstraints({ advanced: [{ zoom: z }] as unknown as MediaTrackConstraintSet[] });
    } catch (err) {
      console.error("zoom failed:", err);
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const t = trackRef.current;
    if (!t) return;
    const next = !torchOn;
    try {
      await t.applyConstraints({ advanced: [{ torch: next }] as unknown as MediaTrackConstraintSet[] });
      setTorchOn(next);
    } catch (err) {
      console.error("torch failed:", err);
    }
  }, [torchOn]);

  // Handle incoming answer and ICE from the main app, routing each to the
  // matching peer connection by its `target`.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.kind === "camera.answer" && msg.payload?.device_id === deviceId) {
          const pc = pcsRef.current[msg.payload.target === "output" ? "output" : "operator"];
          if (pc) {
            pc.setRemoteDescription({
              type: "answer",
              sdp: msg.payload.sdp,
            }).catch(console.error);
          }
        } else if (msg.kind === "camera.ice" && msg.payload?.device_id === deviceId) {
          const pc = pcsRef.current[msg.payload.target === "output" ? "output" : "operator"];
          if (pc) {
            pc.addIceCandidate({
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

  // Cleanup on unmount. Keying this effect on `cleanup` itself would tear down
  // the live peer connections every time `stream` changes — `setStream` inside
  // startStreaming re-creates `cleanup`, so the previous effect's cleanup would
  // close the PCs mid-startup and createOffer would throw "signalingState is
  // closed". Keep the latest cleanup in a ref and run it only on unmount.
  const cleanupRef = useRef<() => void>(() => {});
  cleanupRef.current = cleanup;
  useEffect(() => {
    return () => cleanupRef.current();
  }, []);

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

      {/* Zoom + torch controls (only when the device reports support) */}
      {isStreaming && (zoomCaps || torchSupported) && (
        <div className="flex items-center gap-3 px-1">
          {zoomCaps && (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <ZoomIn size={14} className="text-slate-400 shrink-0" />
              <input
                type="range"
                min={zoomCaps.min}
                max={zoomCaps.max}
                step={zoomCaps.step}
                value={zoom}
                onChange={(e) => applyZoom(parseFloat(e.target.value))}
                className="flex-1 h-1.5 accent-cyan-500 cursor-pointer"
                title="Zoom"
              />
              <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{zoom.toFixed(1)}×</span>
            </div>
          )}
          {torchSupported && (
            <button
              onClick={toggleTorch}
              className={cx(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-colors border",
                torchOn
                  ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700",
              )}
              title="Toggle torch / flash"
            >
              <Sun size={13} />
              Torch
            </button>
          )}
        </div>
      )}

      {/* Controls */}
      {!canCamera && !isStreaming ? (
        <Card>
          <p className="text-[11px] text-slate-500">
            You don't have camera control. Ask the operator to grant it in Settings → Remote Control.
          </p>
        </Card>
      ) : (
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
      )}

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