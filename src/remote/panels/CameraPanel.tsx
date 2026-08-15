import React, { useCallback, useEffect, useRef, useState } from "react";
import { Video, VideoOff, Camera, RotateCcw, Settings, AlertTriangle, Maximize2, Minimize2, Sun, ZoomIn } from "lucide-react";
import { useRemote } from "../wsClient";
import { Card, Btn, cx } from "../ui";

type FacingMode = "user" | "environment";

/** Physical phone orientation: portrait when the device is held upright,
 *  landscape when rotated a quarter turn. Falls back to the viewport aspect
 *  ratio when the ScreenOrientation API is unavailable. */
function readPhoneOrientation(): "portrait" | "landscape" {
  try {
    const so = screen.orientation as ScreenOrientation | undefined;
    if (so && typeof so.type === "string") {
      return so.type.startsWith("portrait") ? "portrait" : "landscape";
    }
  } catch {
    /* fall through */
  }
  return window.innerHeight >= window.innerWidth ? "portrait" : "landscape";
}

// Capture at 720p30 by default: half the encode work of 1080p (and roughly half
// the Wi-Fi load), which is the single biggest lever for phone camera latency.
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const MAX_BITRATE = 2_500_000; // bps cap keeps frames from bursting/buffering
const MAX_FRAMERATE = 30;

/** Prefer H.264 Constrained Baseline so the phone can use its hardware media
 *  encoder (VP8/VP9 are software-encoded and measurably slower on phones).
 *  Runs after the transceiver is created but before the offer, so the m-line
 *  negotiation carries the preference. */
function preferH264(pc: RTCPeerConnection) {
  try {
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (!caps) return;
    const baseline = caps.codecs.filter(
      (c) => /^H264/.test(c.mimeType) && c.sdpFmtpLine?.includes("profile-level-id=42e01f")
    );
    const otherH264 = caps.codecs.filter(
      (c) => /^H264/.test(c.mimeType) && !c.sdpFmtpLine?.includes("profile-level-id=42e01f")
    );
    const others = caps.codecs.filter((c) => !/^H264/.test(c.mimeType));
    const ordered = [...baseline, ...otherH264, ...others];
    pc.getTransceivers().forEach((t) => {
      if (t.sender?.track?.kind === "video") {
        try {
          t.setCodecPreferences(ordered);
        } catch {
          /* not supported — keep browser default */
        }
      }
    });
  } catch {
    /* ignore */
  }
}

/** Cap bitrate and hold the frame rate after the peer connects, instead of
 *  letting WebRTC congestion control burst frames ahead (which reads as lag). */
async function tuneSender(pc: RTCPeerConnection) {
  try {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{ maxBitrate: MAX_BITRATE, maxFramerate: MAX_FRAMERATE }];
    } else {
      params.encodings[0] = { ...params.encodings[0], maxBitrate: MAX_BITRATE, maxFramerate: MAX_FRAMERATE };
    }
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params);
  } catch {
    /* setParameters may be restricted on some engines — keep default tuning */
  }
}

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
  const streamRef = useRef<MediaStream | null>(null);
  const reconnectPeerRef = useRef<(target: "operator" | "output") => void>(() => {});
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
    streamRef.current = null;
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

  const makeOffer = useCallback(async (pc: RTCPeerConnection, target: "operator" | "output") => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await client.command("camera.offer", {
      sdp: offer.sdp!,
      device_id: deviceId,
      target,
    });
  }, [client, deviceId]);

  const setupPeer = useCallback((pc: RTCPeerConnection, target: "operator" | "output") => {
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
  }, [client, deviceId]);

  // Keep re-offering a peer that never connected while the camera is
  // streaming. The operator main window hosts the "operator" answering peer
  // from app startup, but a projection ("output") window that is opened — or a
  // window that reloaded — *after* the phone started would otherwise never pick
  // up the offer. Stops when the peer connects, the camera stops, or the peer
  // object is replaced by a restart.
  const keepReOffering = useCallback(async (pc: RTCPeerConnection, target: "operator" | "output") => {
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
  }, [makeOffer]);

  // Peer state transitions: connected → toast; failed/disconnected → rebuild
  // the peer and re-offer so an operator/projector window reload recovers
  // automatically instead of killing the camera.
  const wirePeerState = useCallback((pc: RTCPeerConnection, target: "operator" | "output") => {
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        pushToast(target === "operator" ? "Camera streaming to operator" : "Camera ready on projector", "info");
        tuneSender(pc);
      } else if (st === "failed" || st === "disconnected") {
        setTimeout(() => {
          if (pcsRef.current[target] === pc) reconnectPeerRef.current(target);
        }, 1500);
      }
    };
  }, [pushToast]);

  // Build one peer: create the connection, add the local video, prefer the
  // hardware H.264 encoder, wire ICE + state, offer, and keep re-offering
  // while it has not connected. Both the "operator" (preview) and "output"
  // (projection) peers are created through here.
  const createPeer = useCallback((target: "operator" | "output") => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcsRef.current = { ...pcsRef.current, [target]: pc };
    setupPeer(pc, target);
    streamRef.current?.getVideoTracks().forEach((t) => pc.addTrack(t, streamRef.current!));
    preferH264(pc);
    wirePeerState(pc, target);
    makeOffer(pc, target).catch(() => {});
    keepReOffering(pc, target);
  }, [setupPeer, makeOffer, keepReOffering, wirePeerState]);

  // Rebuild one peer from scratch when the operator-side window hosting it
  // reloads or drops: the camera keeps running and a fresh offer is answered
  // as soon as the window is back. Used instead of tearing the camera down.
  const reconnectPeer = useCallback((target: "operator" | "output") => {
    const old = pcsRef.current[target];
    if (old) {
      old.onconnectionstatechange = null;
      old.close();
    }
    if (!isStreamingRef.current || !streamRef.current) return;
    createPeer(target);
  }, [createPeer]);
  reconnectPeerRef.current = reconnectPeer;

  // The "output" (projection) peer exists only while this phone's camera is
  // actually live on a visible projection window — the only time its frames
  // are being encoded toward the projector. While the feed is merely
  // previewed or staged, the operator peer alone is enough, so the phone
  // avoids double-encoding for the whole streamed session.
  const myDeviceId = `phone-camera-${deviceId}`;
  const liveItemData = client.snapshot?.live_item;
  const outputNeeded =
    (client.snapshot?.output_visible ?? false) &&
    liveItemData?.type === "Camera" &&
    liveItemData.data.deviceId === myDeviceId;
  const outputNeededRef = useRef(outputNeeded);
  outputNeededRef.current = outputNeeded;

  useEffect(() => {
    if (!isStreamingRef.current) return;
    if (outputNeeded) {
      if (!pcsRef.current.output) createPeer("output");
    } else if (pcsRef.current.output) {
      const pc = pcsRef.current.output;
      pcsRef.current.output = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
  }, [outputNeeded, createPeer]);

  // Keep the reported physical orientation current: if the phone is rotated
  // while streaming, re-register the camera (register-only and idempotent on
  // the backend) so the operator's camera list and `reportedCameraOrientations`
  // map update and the preview/output windows re-orient live.
  const orientationRef = useRef<"portrait" | "landscape">(readPhoneOrientation());
  useEffect(() => {
    const sync = () => {
      if (!isStreamingRef.current) return;
      const next = readPhoneOrientation();
      if (next === orientationRef.current) return;
      orientationRef.current = next;
      client
        .command("camera.start", {
          device_id: deviceId,
          device_name: deviceName,
          facing_mode: facingMode,
          orientation: next,
        })
        .catch(() => {
          // Transient failure — the operator keeps the last known orientation.
        });
    };
    window.addEventListener("orientationchange", sync);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("orientationchange", sync);
      window.removeEventListener("resize", sync);
    };
  }, [client, deviceId, deviceName, facingMode]);

  const startStreaming = useCallback(async () => {
    setError(null);
    setIsStreaming(true);
    isStreamingRef.current = true;

    try {
      // Get camera stream at 720p30 (see CAPTURE_* constants).
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
          frameRate: { ideal: MAX_FRAMERATE },
        },
        audio: false,
      });

      setStream(mediaStream);
      streamRef.current = mediaStream;
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

      // Create the "operator" peer (preview) immediately — the main window
      // hosts its answering peer from startup. The "output" (projection) peer
      // is created lazily only when this camera is actually live on an open
      // projection window (see the outputNeeded effect below), so the phone
      // never double-encodes while nothing is being projected.
      createPeer("operator");
      if (outputNeededRef.current) createPeer("output");

      // Send start command (the operator preview connects even if the
      // projection window never answers).
      await client.command("camera.start", {
        device_id: deviceId,
        device_name: deviceName,
        facing_mode: facingMode,
        orientation: readPhoneOrientation(),
      });

      pushToast("Camera streaming started", "info");
    } catch (err) {
      console.error("Camera start failed:", err);
      const msg = err instanceof Error ? err.message : "Failed to start camera";
      setError(msg);
      pushToast(msg, "error");
      cleanup();
    }
  }, [client, deviceId, deviceName, facingMode, pushToast, cleanup, createPeer]);

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
            <p className="text-[10px] opacity-70">Needs camera permission from the operator</p>
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
          {canCamera ? "Camera permission granted" : "No camera permission"}
        </span>
        <span className={cx("flex items-center gap-1", isStreaming ? "text-green-400" : "text-slate-500")}>
          <span className={cx("w-1.5 h-1.5 rounded-full", isStreaming ? "bg-green-400 animate-pulse" : "bg-slate-700")} />
          {isStreaming ? "Streaming" : "Idle"}
        </span>
      </div>
    </Card>
  );
}