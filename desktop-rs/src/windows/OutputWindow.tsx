import React, { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayItem, PropItem, PresentationSettings, LowerThirdData, LowerThirdTemplate } from "../types";
import { THEMES } from "../types";
import {
  getEffectiveBackground,
  getCameraBackgroundDeviceId,
  getVideoBackground,
  getTransitionVariants,
  displayItemLabel
} from "../utils";
import {
  SlideRenderer,
  CustomSlideRenderer,
  SceneRenderer,
  CameraFeedRenderer,
  TimerRenderer,
  SongSlideRenderer,
  LowerThirdOverlay,
  PropsRenderer,
  type SceneLiveContext
} from "../components/shared/Renderers";
import { loadPptxZip, parseSingleSlide } from "../pptxParser";
import type { ParsedSlide } from "../pptxParser";
import { AnimatePresence, motion } from "framer-motion";

const OUTPUT_STUN: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [lowerThird, setLowerThird] = useState<{ data: LowerThirdData; template: LowerThirdTemplate } | null>(null);
  const [propItems, setPropItems] = useState<PropItem[]>([]);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
  });
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState<ParsedSlide | null>(null);
  const outputZipsRef = useRef<Record<string, any>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraMuted, setCameraMuted] = useState(false);

  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const programVideoRef = useRef<HTMLVideoElement>(null);
  const [hubRelayStreamA, setHubRelayStreamA] = useState<MediaStream | null>(null);
  const [hubRelayStreamB, setHubRelayStreamB] = useState<MediaStream | null>(null);
  const programPcsRef = useRef<Record<string, RTCPeerConnection | null>>({ A: null, B: null });
  const programDeviceId = useRef<string | null>(null);
  const outputWsRef = useRef<WebSocket | null>(null);
  const sceneCameraHandlersRef = useRef<Map<string, (msg: any) => void>>(new Map());
  const [windowScale, setWindowScale] = useState(1);

  // Calculate font scale based on current window height relative to 1080p reference
  useEffect(() => {
    const updateScale = () => {
      setWindowScale(window.innerHeight / 1080);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  function sendOutputWs(obj: object) {
    if (outputWsRef.current?.readyState === WebSocket.OPEN) {
      outputWsRef.current.send(JSON.stringify(obj));
    }
  }

  function closeProgramPc() {
    if (programDeviceId.current) {
      sendOutputWs({ cmd: "camera_disconnect_program", device_id: programDeviceId.current });
    }
    programDeviceId.current = null;
  }

  async function handleProgramOffer(msg: { device_id: string; sdp: string }) {
    const { device_id, sdp } = msg;
    const slot = device_id === "hub_relay_b" ? 'B' : 'A';
    
    if (programPcsRef.current[slot]) {
        programPcsRef.current[slot]!.close();
    }

    const pc = new RTCPeerConnection(OUTPUT_STUN);
    programPcsRef.current[slot] = pc;

    pc.ontrack = (ev: RTCTrackEvent) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (slot === 'A') {
        if (programVideoRef.current) programVideoRef.current.srcObject = stream;
        setHubRelayStreamA(stream);
      } else {
        setHubRelayStreamB(stream);
      }
    };

    const target = device_id.startsWith("hub_relay_") ? "window:main" : `mobile:${device_id}`;

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        sendOutputWs({ cmd: "camera_ice", device_id, target, candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        if (slot === 'A') {
          if (programVideoRef.current) programVideoRef.current.srcObject = null;
          setHubRelayStreamA(null);
        } else {
          setHubRelayStreamB(null);
        }
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendOutputWs({ cmd: "camera_answer", device_id, target, sdp: answer.sdp });
  }

  function connectOutputWs(pin: string) {
    const ws = new WebSocket("ws://127.0.0.1:7420/ws");
    outputWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: "auth", pin, client_type: "window:output" }));
      // Notify the Hub that a new output window is ready for a Relay offer
      ws.send(JSON.stringify({ cmd: "output_ready", target: "operator" }));
    };

    ws.onmessage = async (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "auth_ok") return;

      if (msg.cmd === "camera_offer" && (msg.target === "output" || msg.target === "window:output")) {
        const sceneHandler = sceneCameraHandlersRef.current.get(msg.device_id);
        if (sceneHandler) { sceneHandler(msg); return; }
        await handleProgramOffer(msg);
        return;
      }
      if (msg.cmd === "camera_ice" && (msg.target === "output" || msg.target === "window:output")) {
        const sceneHandler = sceneCameraHandlersRef.current.get(msg.device_id);
        if (sceneHandler) { sceneHandler(msg); return; }
        
        const slot = msg.device_id === "hub_relay_b" ? 'B' : 'A';
        const pc = programPcsRef.current[slot];
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        }
        return;
      }
    };

    ws.onclose = () => {
      setTimeout(() => { if (outputWsRef.current?.readyState === WebSocket.CLOSED) connectOutputWs(pin); }, 5000);
    };
  }

  useEffect(() => {
    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    invoke("get_current_lower_third")
      .then((lt: any) => { if (lt) setLowerThird(lt); })
      .catch(() => {});

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    invoke("get_remote_info")
      .then((info: any) => { if (info?.pin) connectOutputWs(info.pin); })
      .catch(() => {});

    invoke<string>("get_app_data_dir")
      .then(setAppDataDir)
      .catch(() => {});

    const unlistenTrans = listen("transcription-update", (event: any) => {
      const { detected_item, source } = event.payload;
      if (source === "manual") {
        setLiveItem(detected_item ?? null);
        if (detected_item) setCameraMuted(false);
      }
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    const unlistenLt = listen("lower-third-update", (event: any) => {
      if (event.payload) {
        setLowerThird({ data: event.payload.data as LowerThirdData, template: event.payload.template as LowerThirdTemplate });
      } else {
        setLowerThird(null);
      }
    });

    const unlistenMedia = listen("media-control", (event: any) => {
      const { action } = event.payload as { action: string };
      console.log("OutputWindow: received media-control", action);

      if (action === "video-play-pause") {
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play();
          else videoRef.current.pause();
        }
      } else if (action === "video-restart") {
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play();
        }
      } else if (action === "video-mute-toggle") {
        if (videoRef.current) {
          videoRef.current.muted = !videoRef.current.muted;
        }
      } else if (action === "camera-mute-toggle") {
        setCameraMuted((m) => !m);
      }
    });

    const unlistenProps = listen("props-update", (event: any) => {
      setPropItems((event.payload as PropItem[]) ?? []);
    });

    invoke<PropItem[]>("get_props").then(setPropItems).catch(() => {});

    return () => {
      unlistenTrans.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenLt.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenProps.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (liveItem?.type !== "PresentationSlide") {
      setCurrentSlide(null);
      return;
    }
    const { presentation_id, presentation_path, slide_index } = liveItem.data;
    (async () => {
      try {
        let zip = outputZipsRef.current[presentation_id];
        if (!zip) {
          zip = await loadPptxZip(presentation_path);
          outputZipsRef.current[presentation_id] = zip;
        }
        const slide = await parseSingleSlide(zip, slide_index);
        setCurrentSlide(slide);
      } catch (err) {
        console.error("OutputWindow: failed to render slide", err);
        setCurrentSlide(null);
      }
    })();
  }, [liveItem]);

  useEffect(() => {
    const isLanCamera = liveItem?.type === "CameraFeed" && liveItem.data.lan;

    if (isLanCamera) {
      const newDeviceId = liveItem!.data.device_id;
      if (programDeviceId.current === newDeviceId) return;

      if (programDeviceId.current) {
        sendOutputWs({ cmd: "camera_disconnect_program", device_id: programDeviceId.current });
      }

      programDeviceId.current = newDeviceId;
      sendOutputWs({ cmd: "camera_connect_program", device_id: newDeviceId });
    } else if (programDeviceId.current) {
      closeProgramPc();
    }
  }, [liveItem]);

  const videoBg = getVideoBackground(settings, liveItem);

  // Sync playback rate when it changes without unmounting the video element
  useEffect(() => {
    if (bgVideoRef.current && videoBg) {
      bgVideoRef.current.playbackRate = videoBg.playbackRate;
    }
  }, [videoBg?.playbackRate]);

  // Reload video when source path changes
  useEffect(() => {
    if (bgVideoRef.current) {
      bgVideoRef.current.load();
      if (videoBg?.path) bgVideoRef.current.play().catch(() => {});
    }
  }, [videoBg?.path]);

  if (settings.is_blanked) {
    return <div className="h-screen w-screen bg-black" />;
  }

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, liveItem, colors);
  const cameraBgId = getCameraBackgroundDeviceId(settings, liveItem);

  const refColor = settings.reference_color && settings.reference_color !== ""
    ? settings.reference_color
    : colors.referenceText;
  const refFontSize = settings.reference_font_size ?? 36;
  const refFontFamily = settings.reference_font_family ?? "Arial, sans-serif";

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="uppercase tracking-widest font-bold shrink-0"
      style={{ color: refColor, fontSize: `${refFontSize * windowScale}pt`, fontFamily: refFontFamily }}
    >
      {liveItem.data.book} {liveItem.data.chapter}:{liveItem.data.verse}
      {liveItem.data.version && (
        <span className="font-normal opacity-60 ml-2" style={{ fontSize: `${Math.round(refFontSize * 0.65 * windowScale)}pt` }}>
          ({liveItem.data.version})
        </span>
      )}
    </p>
  ) : null;

  const isLanCameraLive = liveItem?.type === "CameraFeed" && !!liveItem.data.lan;

  return (
    <div
      className="h-screen w-screen overflow-hidden relative cursor-none"
      style={
        cameraBgId || isLanCameraLive || videoBg
          ? { color: colors.verseText }
          : { ...bgStyle, color: colors.verseText }
      }
    >
      {/* Background logo overlay - topmost level below props */}
      {settings.show_background_logo && settings.background_logo_path && (
        <div className="absolute inset-0 z-50 bg-black">
          {settings.background_logo_path.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
            <video
              src={convertFileSrc(settings.background_logo_path)}
              className="w-full h-full object-cover"
              autoPlay
              loop
              muted
            />
          ) : (
            <img
              src={convertFileSrc(settings.background_logo_path)}
              className="w-full h-full object-cover"
              alt="Background Logo"
            />
          )}
        </div>
      )}

      {/* Background video element — rendered at z-0, below all content */}
      <video
        ref={bgVideoRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          zIndex: 0,
          objectFit: videoBg?.objectFit ?? "cover",
          opacity: videoBg?.opacity ?? 1,
          visibility: videoBg?.path ? "visible" : "hidden",
        }}
        src={videoBg?.path ? convertFileSrc(videoBg.path) : undefined}
        autoPlay
        loop={videoBg?.loopVideo ?? true}
        muted={videoBg?.muted ?? true}
        playsInline
      />

      <video
        ref={programVideoRef}
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0, visibility: (isLanCameraLive && !cameraMuted) ? "visible" : "hidden" }}
        autoPlay
        playsInline
      />

      {isLanCameraLive && (
        <div className="absolute inset-0 bg-black/25 pointer-events-none" style={{ zIndex: 9 }} />
      )}

      {cameraBgId && (
        <div className="absolute inset-0 z-0">
          <CameraFeedRenderer deviceId={cameraBgId} />
        </div>
      )}
      {settings.logo_path && (
        <img
          src={convertFileSrc(settings.logo_path)}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          alt="Logo"
        />
      )}

      <AnimatePresence mode="wait">
        {liveItem ? (
          <motion.div
            key={displayItemLabel(liveItem)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            {liveItem.type === "Verse" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-16 text-center">
                <motion.div
                  className="w-full flex flex-col items-center gap-8"
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  {isTop && ReferenceTag}
                  <h1
                    className="leading-tight drop-shadow-2xl"
                    style={{
                      color: colors.verseText,
                      fontSize: `${settings.font_size * windowScale}pt`,
                      fontFamily: settings.verse_font_family ?? "Georgia, serif",
                    }}
                  >
                    {liveItem.data.text}
                  </h1>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : liveItem.type === "PresentationSlide" ? (
              <div className="absolute inset-0">
                {currentSlide ? (
                  <SlideRenderer slide={currentSlide} scale={windowScale} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="font-serif text-2xl italic" style={{ color: colors.waitingText }}>
                      Loading slide...
                    </span>
                  </div>
                )}
              </div>
            ) : liveItem.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={liveItem.data} scale={windowScale} appDataDir={appDataDir} />
              </div>
            ) : liveItem.type === "CameraFeed" ? (
              liveItem.data.lan ? (
                <div className="absolute inset-0" />
              ) : (
                <div className="absolute inset-0" style={{ visibility: cameraMuted ? "hidden" : "visible" }}>
                  <CameraFeedRenderer deviceId={liveItem.data.device_id} />
                </div>
              )
            ) : liveItem.type === "Media" ? (
              <div className="absolute inset-0">
                {liveItem.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(liveItem.data.path)}
                    className={`w-full h-full ${
                      liveItem.data.fit_mode === "cover" ? "object-cover"
                      : liveItem.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    alt={liveItem.data.name}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    src={convertFileSrc(liveItem.data.path)}
                    className={`w-full h-full ${
                      liveItem.data.fit_mode === "cover" ? "object-cover"
                      : liveItem.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    autoPlay
                    loop
                  />
                )}
              </div>
            ) : liveItem.type === "Scene" ? (
              <div className="absolute inset-0">
                <SceneRenderer
                  scene={liveItem.data}
                  scale={windowScale}
                  outputMode={true}
                  appDataDir={appDataDir}
                  liveContext={{
                    liveItem,
                    lowerThird,
                    outputWsRef: outputWsRef as React.RefObject<WebSocket | null>,
                    sceneCameraHandlers: sceneCameraHandlersRef,
                    hubRelayStreamA,
                    hubRelayStreamB,
                  } as any}
                />
              </div>
            ) : liveItem.type === "Timer" ? (
              <TimerRenderer data={liveItem.data} />
            ) : liveItem.type === "Song" ? (
              <SongSlideRenderer 
                data={liveItem.data} 
                scale={windowScale} 
                fontSize={settings.font_size}
                fontFamily={settings.verse_font_family}
                color={colors.verseText}
              />
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="waiting"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <span className="font-serif text-2xl italic select-none" style={{ color: colors.waitingText }}>
              Waiting for projection...
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <PropsRenderer items={propItems} appDataDir={appDataDir} />

      <AnimatePresence>
        {lowerThird && (
          <LowerThirdOverlay key="lower-third" data={lowerThird.data} template={lowerThird.template} />
        )}
      </AnimatePresence>
    </div>
  );
}
