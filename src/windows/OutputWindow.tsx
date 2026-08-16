import React, { useEffect, useState, useRef, useCallback, useLayoutEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayItem, PropItem, PresentationSettings, LowerThirdData, LowerThirdTemplate } from "../types";
import { THEMES } from "../types";
import {
  getEffectiveBackground,
  getVideoBackground,
  getCameraBackground,
  getAudioBackground,
  getImageBackground,
  getTransitionVariants,
  getItemUid,
  resolvePath,
} from "../utils";
import {
  CustomSlideRenderer,
  TimerRenderer,
  SongSlideRenderer,
  LowerThirdOverlay,
  PropsRenderer,
} from "../components/shared/Renderers";
import { CompositionRenderer } from "../components/shared/CompositionRenderer";
import { AnimatePresence, motion } from "framer-motion";
import { Music } from "lucide-react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { signalOperatorWarning } from "../hooks/useAppInitialization";
import { useFonts } from "../hooks/useFonts";
import PhoneCameraVideo, { usePhoneCameraOrientation, usePhoneCameraLook, useCameraChroma } from "../components/shared/PhoneCameraVideo";

function ProjectionErrorFallback() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-center px-8">
      <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
        <span className="text-red-400 text-3xl font-black">!</span>
      </div>
      <p className="text-red-300 text-2xl font-bold mb-1">Projection Error</p>
      <p className="text-slate-400 text-sm">See operator console. Output will recover on the next slide.</p>
    </div>
  );
}

export function OutputWindow() {
  useFonts(); // P2.5: inject @font-face for user-installed fonts.
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const liveItemRef = useRef<DisplayItem | null>(null);
  liveItemRef.current = liveItem;  const [lowerThird, setLowerThird] = useState<{ data: LowerThirdData; template: LowerThirdTemplate } | null>(null);
  const [propItems, setPropItems] = useState<PropItem[]>([]);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
    disabled_bible_versions: [],
    auto_split_verses: true,
    verse_split_threshold: 200,
  });
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const [monitorTest, setMonitorTest] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const bgAudioRef = useRef<HTMLAudioElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const mainCameraRef = useRef<HTMLVideoElement>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [mainCameraStream, setMainCameraStream] = useState<MediaStream | null>(null);
  const liveCameraDeviceId = liveItem?.type === "Camera" ? (liveItem.data.deviceId ?? null) : null;
  const livePhoneOrientation = usePhoneCameraOrientation(
    liveCameraDeviceId?.startsWith("phone-camera-") ? liveCameraDeviceId : null
  );
  const liveCameraLook = usePhoneCameraLook(liveCameraDeviceId);
  const liveCameraChroma = useCameraChroma(liveCameraDeviceId);
  // Locally-opened background camera stream (owned by this effect, unlike the
  // relayed phone streams which belong to the phone's peer connections).
  const localBgCameraRef = useRef<MediaStream | null>(null);

  // Phone WebRTC relay. The operator window hosts the *answering* peer for each
  // phone camera; the backend relays offer/ICE from the phone here and carries
  // our answer/ICE back to the phone over the remote hub. Media flows directly
  // phone <-> this window over the LAN, so no frames pass through Rust.
  const phonePCsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [phoneStreams, setPhoneStreams] = useState<Record<string, MediaStream>>({});

  const [windowScale, setWindowScale] = useState(1);
  const isMounted = useRef(true);

  // Auto-fit font size when verse splitting is disabled
  const verseContainerRef = useRef<HTMLDivElement>(null);
  const [fittedFontPt, setFittedFontPt] = useState<number | null>(null);

  // Calculate font scale based on current window height relative to the
  // configured output reference height (1080p by default), so slides/songs
  // authored for the reference resolution project proportionally even when
  // the projector window is 720p, 1440p, or DPI-scaled.
  useEffect(() => {
    const refHeight = settings.reference_output_height ?? 1080;
    const updateScale = () => {
      setWindowScale(window.innerHeight / refHeight);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, [settings.reference_output_height]);

  // Auto-fit: binary-search the largest font size that fits without overflow
  // Only active when verse splitting is disabled
  useLayoutEffect(() => {
    const isVerse = liveItem?.type === "Verse";
    if (settings.auto_split_verses || !isVerse || !verseContainerRef.current) {
      setFittedFontPt(null);
      return;
    }

    const text = (liveItem as any).data.text as string;
    const maxPt = settings.font_size * windowScale;
    const fontFamily = settings.verse_font_family ?? "Georgia, serif";
    const container = verseContainerRef.current;

    // Reserve ~15% of height for reference tag + gaps
    const availH = container.clientHeight * 0.80;
    const availW = container.clientWidth - 128; // p-16 = 64px each side

    if (availH <= 0 || availW <= 0) return;

    const probe = document.createElement("p");
    probe.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "pointer-events:none",
      `width:${availW}px`,
      `font-family:${fontFamily}`,
      "text-align:center",
      "word-break:break-word",
      "line-height:1.25",
      "white-space:normal",
    ].join(";");
    container.appendChild(probe);

    let lo = 10, hi = maxPt, best = 10;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      probe.style.fontSize = `${mid}pt`;
      probe.textContent = text;
      if (probe.scrollHeight <= availH) {
        best = mid;
        lo = mid + 0.25;
      } else {
        hi = mid - 0.25;
      }
    }

    container.removeChild(probe);
    setFittedFontPt(best < maxPt ? Math.floor(best) : null);
  }, [
    liveItem,
    settings.auto_split_verses,
    settings.font_size,
    settings.verse_font_family,
    windowScale,
  ]);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const unlistenTrans = listen("live-item-update", (event: any) => {
      const { detected_item } = event.payload;
      setLiveItem(detected_item ?? null);
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    const unlistenStaged = listen("item-staged", (event: any) => {
      setStagedItem(event.payload as DisplayItem | null);
    });

    const unlistenLt = listen("lower-third-update", (event: any) => {
      if (event.payload) {
        setLowerThird({ data: event.payload.data as LowerThirdData, template: event.payload.template as LowerThirdTemplate });
      } else {
        setLowerThird(null);
      }
    });

    const unlistenMedia = listen("media-control", (event: any) => {
      const { action, volume, currentTime, rate } = event.payload as { action: string; volume?: number; currentTime?: number; rate?: number };
      const liveAudio = (window as any).__liveAudio as HTMLAudioElement | undefined;
      if (action === "video-play-pause") {
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play();
          else videoRef.current.pause();
        } else if (liveAudio) {
          if (liveAudio.paused) liveAudio.play();
          else liveAudio.pause();
        }
      } else if (action === "video-restart") {
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play();
        } else if (liveAudio) {
          liveAudio.currentTime = 0;
          liveAudio.play();
        }
      } else if (action === "video-seek") {
        if (videoRef.current && currentTime !== undefined) {
          videoRef.current.currentTime = currentTime;
        } else if (liveAudio && currentTime !== undefined) {
          liveAudio.currentTime = currentTime;
        }
      } else if (action === "video-mute-toggle") {
        if (videoRef.current) {
          videoRef.current.muted = !videoRef.current.muted;
        } else if (liveAudio) {
          liveAudio.muted = !liveAudio.muted;
        }
      } else if (action === "video-volume") {
        if (videoRef.current && volume !== undefined) {
          videoRef.current.volume = volume;
        } else if (liveAudio && volume !== undefined) {
          liveAudio.volume = volume;
        }
      } else if (action === "video-rate") {
        if (videoRef.current && rate !== undefined) {
          videoRef.current.playbackRate = rate;
        }
      }
    });

    // Stateful transport feedback: broadcast live playback state to the
    // operator console so the compact live transport reflects real state
    // instead of a fire-and-forget guess.
    let mediaStateTimer: ReturnType<typeof setInterval> | null = null;
    const broadcastMediaState = () => {
      const live = liveItemRef.current;
      const target = (videoRef.current ?? (window as any).__liveAudio) as HTMLMediaElement | undefined;
      const el = target;
      if (!el || !(live?.type === "Media") || !["Video", "Audio"].includes(live.data.media_type)) {
        return;
      }
      emit("media-state", {
        playing: !el.paused,
        currentTime: el.currentTime,
        duration: isFinite(el.duration) ? el.duration : 0,
        volume: el.volume,
        muted: el.muted,
        rate: el.playbackRate,
      });
    };
    mediaStateTimer = setInterval(broadcastMediaState, 500);
    emit("media-state", null);

    const unlistenProps = listen("props-update", (event: any) => {
      setPropItems((event.payload as PropItem[]) ?? []);
    });

    const unlistenMonitorTest = listen("monitor-test", (event: any) => {
      setMonitorTest(!!event.payload?.active);
    });

    Promise.all([
      invoke("get_current_item").then((v: any) => { if (v) setLiveItem(v); }).catch((e: any) => signalOperatorWarning(`Output hydrate (live): ${e?.message ?? e}`)),
      invoke("get_current_lower_third").then((lt: any) => { if (lt) setLowerThird(lt); }).catch((e: any) => signalOperatorWarning(`Output hydrate (LT): ${e?.message ?? e}`)),
      invoke("get_settings").then((s: any) => { if (s) setSettings(s); }).catch((e: any) => signalOperatorWarning(`Output hydrate (settings): ${e?.message ?? e}`)),
      invoke<string>("get_app_data_dir").then(setAppDataDir).catch((e: any) => signalOperatorWarning(`Output hydrate (appdir): ${e?.message ?? e}`)),
      invoke<PropItem[]>("get_props").then(setPropItems).catch((e: any) => signalOperatorWarning(`Output hydrate (props): ${e?.message ?? e}`)),
    ]);

    return () => {
      if (mediaStateTimer) clearInterval(mediaStateTimer);
      unlistenTrans.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenLt.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenProps.then((f) => f());
      unlistenMonitorTest.then((f) => f());
    };
  }, []);

  // Lower Third Auto-Hide Logic
  const remainingScrolls = useRef<number>(0);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }

    if (!lowerThird) {
      remainingScrolls.current = 0;
      return;
    }

    const t = lowerThird.template;
    
    if (t.scrollEnabled && t.scrollCount > 0) {
      remainingScrolls.current = t.scrollCount;
    } else {
      remainingScrolls.current = 0;
    }

    if (t.autoHideSeconds > 0 && !(t.scrollEnabled && t.scrollCount === 0)) {
      autoHideTimer.current = setTimeout(() => {
        if (isMounted.current) {
          invoke("hide_lower_third").catch(console.error);
        }
      }, t.autoHideSeconds * 1000);
    }

    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    };
  }, [lowerThird]);

  const handleLtCycleComplete = useCallback(() => {
    if (remainingScrolls.current > 0) {
      remainingScrolls.current -= 1;
      if (remainingScrolls.current === 0) {
        invoke("hide_lower_third").catch(console.error);
      }
    }
  }, []);

  const videoBg = getVideoBackground(settings, liveItem);
  const cameraBg = getCameraBackground(settings, liveItem);
  const audioBg = getAudioBackground(settings, liveItem);
  const bgImage = getImageBackground(settings, liveItem);

  const bgCameraLook = usePhoneCameraLook(cameraBg?.deviceId ?? null);
  const bgCameraChroma = useCameraChroma(cameraBg?.deviceId ?? null);
  const bgPhoneOrientation = usePhoneCameraOrientation(
    cameraBg?.deviceId?.startsWith("phone-camera-") ? cameraBg.deviceId : null
  );

  // Browser-only camera stream lifecycle. Phone cameras stream over the WebRTC
  // relay hosted by this window's "output" peer (their ids are synthetic and
  // can never be opened with getUserMedia here).
  useEffect(() => {
    const deviceId = cameraBg?.deviceId;

    const stopLocal = () => {
      if (localBgCameraRef.current) {
        localBgCameraRef.current.getTracks().forEach(track => track.stop());
        localBgCameraRef.current = null;
      }
    };

    if (deviceId?.startsWith("phone-camera-")) {
      stopLocal();
      setCameraStream(phoneStreams[deviceId] ?? null);
      return;
    }

    if (deviceId && !deviceId.startsWith("native:") && !deviceId.startsWith("ndi:")) {
      stopLocal();
      navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } })
        .then(stream => {
          localBgCameraRef.current = stream;
          setCameraStream(stream);
        })
        .catch(err => console.error("Failed to get camera stream:", err));
      return;
    }

    stopLocal();
    setCameraStream(null);
  }, [cameraBg?.deviceId, phoneStreams]);

  useEffect(() => () => {
    if (localBgCameraRef.current) {
      localBgCameraRef.current.getTracks().forEach(track => track.stop());
      localBgCameraRef.current = null;
    }
  }, []);

  // Main camera stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    
    const startBrowserCamera = async (deviceId: string) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { deviceId: { exact: deviceId } } 
        });
        activeStream = stream;
        setMainCameraStream(stream);
      } catch (err) {
        console.error("Failed to get main camera stream:", err);
      }
    };

    // Phone cameras are handled by the WebRTC relay effect; skip them here so
    // this effect never opens a bogus getUserMedia or clears the relayed stream.
    const isPhoneCamera = liveItem?.type === "Camera" && liveItem?.data?.deviceId?.startsWith("phone-camera-");
    if (isPhoneCamera) return () => {};
    if (liveItem?.type === "Camera" && liveItem.data.deviceId && !liveItem.data.deviceId.startsWith("native:") && !liveItem.data.deviceId.startsWith("ndi:")) {
      startBrowserCamera(liveItem.data.deviceId);
    } else {
      if (mainCameraStream) {
        mainCameraStream.getTracks().forEach(track => track.stop());
        setMainCameraStream(null);
      }
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [liveItem?.type === "Camera" ? liveItem.data.deviceId : null]);

  // Phone camera WebRTC relay: host the answering peer for each phone.
  useEffect(() => {
    let unlistenOffer: (() => void) | null = null;
    let unlistenIce: (() => void) | null = null;
    let unlistenStop: (() => void) | null = null;

    const teardown = (deviceId: string) => {
      const pc = phonePCsRef.current.get(deviceId);
      if (pc) {
        pc.close();
        phonePCsRef.current.delete(deviceId);
      }
      setPhoneStreams((prev) => {
        if (!(deviceId in prev)) return prev;
        const next = { ...prev };
        const stream = next[deviceId];
        delete next[deviceId];
        stream?.getTracks().forEach((t) => t.stop());
        return next;
      });
    };

    const handleOffer = async (deviceId: string, sdp: string, pcKey: string) => {
      // Tear down any previous attempt for this camera before answering anew.
      teardown(deviceId);
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        phonePCsRef.current.set(deviceId, pc);

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            invoke("phone_camera_ice", {
              deviceId: pcKey,
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid ?? "",
              sdpMLineIndex: ev.candidate.sdpMLineIndex ?? 0,
              target: "output",
            }).catch((e) => console.error("phone_camera_ice failed:", e));
          }
        };

        pc.ontrack = (ev) => {
          const stream = new MediaStream();
          ev.streams[0]?.getTracks().forEach((t) => stream.addTrack(t));
          ev.track && stream.addTrack(ev.track);
          setPhoneStreams((prev) => ({ ...prev, [deviceId]: stream }));
        };

        await pc.setRemoteDescription({ type: "offer", sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await invoke("phone_camera_answer", { deviceId: pcKey, sdp: answer.sdp ?? "", target: "output" });
      } catch (err) {
        console.error("Phone camera answer setup failed:", err);
        teardown(deviceId);
      }
    };

    (async () => {
      unlistenOffer = await listen("phone-camera-offer", (e) => {
        const p = e.payload as { device_id: string; device_name: string; sdp: string; target?: string };
        // The main operator window hosts the "operator" peer (preview). This
        // projection window only answers the "output" peer.
        if (p.target === "operator") return;
        handleOffer(p.device_id, p.sdp, p.device_id);
      });
      unlistenIce = await listen("phone-camera-ice", (e) => {
        const p = e.payload as { device_id: string; candidate: string; sdp_mid: string; sdp_m_line_index: number; target?: string };
        if (p.target === "operator") return;
        const pc = phonePCsRef.current.get(p.device_id);
        if (pc && p.candidate) {
          pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdp_mid, sdpMLineIndex: p.sdp_m_line_index }).catch(
            (err) => console.error("phone ICE failed:", err)
          );
        }
      });
      unlistenStop = await listen("phone-camera-stop", (e) => {
        const deviceId = (e.payload as { device_id: string }).device_id;
        teardown(deviceId);
      });
    })();

    return () => {
      unlistenOffer?.();
      unlistenIce?.();
      unlistenStop?.();
      phonePCsRef.current.forEach((pc) => pc.close());
      phonePCsRef.current.clear();
    };
  }, []);

  // When the live item is a phone camera, present the relayed stream instead of
  // a local getUserMedia feed (which cannot open a "phone-camera-*" device id).
  useEffect(() => {
    const deviceId = liveItem?.type === "Camera" ? liveItem.data.deviceId : null;
    const phoneStream = deviceId && deviceId.startsWith("phone-camera-") ? phoneStreams[deviceId] : undefined;
    if (phoneStream) {
      setMainCameraStream(phoneStream);
    } else {
      setMainCameraStream(null);
    }
  }, [liveItem?.type === "Camera" ? liveItem.data.deviceId : null, phoneStreams]);

  useEffect(() => {
    if (bgVideoRef.current && videoBg) {
      bgVideoRef.current.playbackRate = videoBg.playbackRate;
    }
  }, [videoBg?.playbackRate]);

  useEffect(() => {
    if (bgVideoRef.current) {
      bgVideoRef.current.load();
      if (videoBg?.path) bgVideoRef.current.play().catch(() => {});
    }
  }, [videoBg?.path]);

  // Background audio: play the settings audio background under verses/media.
  // Auto-pause when the live item is itself an Audio media item (its own
  // playback takes over via __liveAudio).
  useEffect(() => {
    const bgAudio = bgAudioRef.current;
    if (!bgAudio) return;
    const isLiveAudio = liveItem?.type === "Media" && liveItem.data.media_type === "Audio";
    if (audioBg?.path && !isLiveAudio) {
      const src = convertFileSrc(resolvePath(audioBg.path, appDataDir));
      if (bgAudio.getAttribute("src") !== src) {
        bgAudio.src = src;
        bgAudio.volume = audioBg.volume ?? 1;
        bgAudio.loop = audioBg.loopAudio ?? true;
        bgAudio.play().catch(() => {});
      } else if (bgAudio.paused) {
        bgAudio.play().catch(() => {});
      }
    } else {
      bgAudio.pause();
    }
  }, [audioBg?.path, audioBg?.volume, audioBg?.loopAudio, liveItem?.type, appDataDir]);

  if (settings.is_blanked) {
    return <div className="fixed inset-0 bg-black cursor-none pointer-events-none select-none" />;
  }

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, liveItem, colors, appDataDir);

  const refColor = settings.reference_color && settings.reference_color !== ""
    ? settings.reference_color
    : colors.referenceText;
  const refFontSize = settings.reference_font_size ?? 36;
  const refFontFamily = settings.reference_font_family ?? "Arial, sans-serif";

  const cvFontSize = (settings.chapter_verse_font_size ?? refFontSize) * windowScale;
  const cvFontFamily = settings.chapter_verse_font_family ?? refFontFamily;
  const cvColor = settings.chapter_verse_color && settings.chapter_verse_color !== ""
    ? settings.chapter_verse_color
    : refColor;

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="uppercase tracking-widest font-bold shrink-0"
      style={{ color: refColor, fontSize: `${refFontSize * windowScale}pt`, fontFamily: refFontFamily }}
    >
      {liveItem.data.book}{" "}
      <span style={{ fontSize: `${cvFontSize}pt`, fontFamily: cvFontFamily, color: cvColor }}>
        {liveItem.data.chapter}:{liveItem.data.verse}
      </span>
      {liveItem.data.version && (
        <span 
          className="font-normal ml-2" 
          style={{ 
            fontSize: `${(settings.version_font_size ?? Math.round(refFontSize * 0.65)) * windowScale}pt`,
            fontFamily: settings.version_font_family ?? refFontFamily,
            color: (settings.version_color && settings.version_color !== "") ? settings.version_color : undefined,
            opacity: (settings.version_color && settings.version_color !== "") ? 1 : 0.6,
          }}
        >
          ({liveItem.data.version})
        </span>
      )}
    </p>
  ) : null;

  return (
    <div
      className="fixed inset-0 overflow-hidden cursor-none pointer-events-none select-none"
      style={
        (videoBg || cameraBg || bgImage)
          ? { color: colors.verseText }
          : { ...bgStyle, color: colors.verseText }
      }
    >
      {monitorTest && (
        <div className="absolute inset-0 z-[70] bg-black flex flex-col items-center justify-center gap-6">
          <div className="grid grid-cols-4 w-4/5 h-1/2 rounded overflow-hidden border border-white/20">
            {["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#000000"].map((c) => (
              <div key={c} className="flex items-center justify-center" style={{ backgroundColor: c }}>
                <span className="text-[10px] font-black uppercase text-black/60 mix-blend-difference">{c}</span>
              </div>
            ))}
          </div>
          <p className="text-white text-2xl font-black uppercase tracking-widest">Monitor Test Pattern</p>
          <p className="text-white/50 text-sm">{window.innerWidth}×{window.innerHeight}</p>
        </div>
      )}

      {settings.show_background_logo && (settings.background_logo_path || settings.background_logo_text) && (
        <div className="absolute inset-0 z-50 bg-black">
          {settings.background_logo_text ? (
            <div className="w-full h-full flex items-center justify-center px-16 text-center">
              <p
                className="font-black leading-tight drop-shadow-2xl"
                style={{ color: settings.background_logo_text_color ?? "#ffffff", fontSize: "4.5rem" }}
              >
                {settings.background_logo_text}
              </p>
            </div>
          ) : settings.background_logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
            <video
              src={convertFileSrc(resolvePath(settings.background_logo_path, appDataDir))}
              className="w-full h-full"
              style={{ objectFit: settings.background_logo_fit ?? "cover" }}
              autoPlay
              loop
              muted
            />
          ) : settings.background_logo_path ? (
            <img
              src={convertFileSrc(resolvePath(settings.background_logo_path, appDataDir))}
              className="w-full h-full"
              style={{ objectFit: settings.background_logo_fit ?? "cover" }}
              alt="Background Logo"
            />
          ) : null}
        </div>
      )}

      {/* Per-camera backdrop painted behind the background camera feed */}
      {cameraBg?.backdropColor ? (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{ background: cameraBg.backdropColor }}
        />
      ) : null}

      {/* Background camera element */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 0, visibility: cameraBg?.deviceId ? "visible" : "hidden" }}
      >
        <PhoneCameraVideo
          stream={cameraStream}
          orientation={cameraBg?.deviceId?.startsWith("phone-camera-") ? bgPhoneOrientation : null}
          look={bgCameraLook}
          mirrored={cameraBg?.mirrored}
          objectFit={(cameraBg?.objectFit as any) ?? "cover"}
          style={{ opacity: cameraBg?.opacity ?? 1 }}
          chromaKey={bgCameraChroma}
          videoRef={(el) => { cameraRef.current = el; }}
        />
      </div>

      <video
        ref={bgVideoRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          zIndex: 0,
          objectFit: videoBg?.objectFit ?? "cover",
          opacity: videoBg?.opacity ?? 1,
          visibility: videoBg?.path ? "visible" : "hidden",
        }}
        src={videoBg?.path ? convertFileSrc(resolvePath(videoBg.path, appDataDir)) : undefined}
        autoPlay
        loop={videoBg?.loopVideo ?? true}
        muted={videoBg?.muted ?? true}
        playsInline
      />

      {/* Background audio (settings audio background, e.g. ambient bed under
          verses). Playback is driven by the effect above. */}
      <audio ref={bgAudioRef} className="hidden" />

      {/* Background image layer (settings image background). Rendered as its
          own element so fit + opacity apply to the image alone without
          affecting the verse/reference text on top. */}
      {bgImage && (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{
            backgroundImage: `url(${convertFileSrc(resolvePath(bgImage.path, appDataDir))})`,
            backgroundSize: bgImage.objectFit === "contain" ? "contain" : bgImage.objectFit === "fill" ? "100% 100%" : "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            opacity: bgImage.opacity ?? 1,
          }}
        />
      )}

      {settings.logo_text ? (
        <p
          className="absolute bottom-8 right-8 z-60 font-black leading-tight opacity-60 text-right"
          style={{ color: settings.logo_text_color ?? "#ffffff", fontSize: "1.5rem" }}
        >
          {settings.logo_text}
        </p>
      ) : settings.logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
        <video
          src={convertFileSrc(resolvePath(settings.logo_path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          autoPlay
          loop
          muted
        />
      ) : settings.logo_path ? (
        <img
          src={convertFileSrc(resolvePath(settings.logo_path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          alt="Logo"
        />
      ) : null}

      <AnimatePresence mode="wait">
        {liveItem ? (
          <motion.div
            key={getItemUid(liveItem)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            <ErrorBoundary fallback={<ProjectionErrorFallback />}>
            {liveItem.type === "Verse" ? (
              <div ref={verseContainerRef} className="absolute inset-0 flex flex-col items-center justify-center p-16 text-center">
                <motion.div
                  className="w-full flex flex-col items-center gap-8"
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  {isTop && ReferenceTag}
                  <div className="relative w-full flex flex-col items-center">
                    <h1
                      className="leading-tight drop-shadow-2xl"
                      style={{
                        color: colors.verseText,
                        fontSize: `${(fittedFontPt ?? (settings.font_size * windowScale))}pt`,
                        fontFamily: settings.verse_font_family ?? "Georgia, serif",
                      }}
                    >
                      {liveItem.data.text}
                    </h1>
                    {liveItem.data.split_index !== undefined && liveItem.data.total_splits !== undefined && (
                      <p 
                        className="absolute -bottom-10 right-0 font-black opacity-30 text-xs tracking-widest"
                        style={{ color: colors.verseText, fontSize: `${12 * windowScale}pt` }}
                      >
                        PART {liveItem.data.split_index + 1} / {liveItem.data.total_splits}
                      </p>
                    )}
                  </div>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : liveItem.type === "Camera" ? (
              <div className="absolute inset-0">
                {liveItem.data.backdropColor ? (
                  <div
                    className="absolute inset-0"
                    style={{ background: liveItem.data.backdropColor }}
                  />
                ) : null}
                <PhoneCameraVideo
                  stream={mainCameraStream}
                  orientation={livePhoneOrientation}
                  look={liveCameraLook}
                  mirrored={liveItem.data.mirrored}
                  objectFit={(liveItem.data.objectFit as any) ?? "cover"}
                  style={{ opacity: liveItem.data.opacity ?? 1 }}
                  chromaKey={liveCameraChroma}
                  videoRef={(el) => { mainCameraRef.current = el; }}
                />
              </div>
            ) : liveItem.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={liveItem.data} scale={windowScale} appDataDir={appDataDir} theme={liveItem.data.theme} entranceEnabled />
              </div>
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
                ) : liveItem.data.media_type === "Audio" ? (
                  // Audio items have no visible frame — show a tasteful full-
                  // screen audio card and play the file through the hidden
                  // audio element below. Transparent background so the
                  // effective media background shows through.
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-6"
                  >
                    <div
                      className="w-32 h-32 rounded-full flex items-center justify-center"
                      style={{
                        backgroundColor: colors.background + "66",
                        border: `1px solid ${colors.referenceText}66`,
                        boxShadow: `0 0 80px ${colors.referenceText}33`,
                      }}
                    >
                      <Music size={48} style={{ color: colors.referenceText }} className="animate-pulse" />
                    </div>
                    <p className="text-3xl font-bold drop-shadow-lg" style={{ color: colors.verseText }}>{liveItem.data.name}</p>
                    <p className="text-sm uppercase tracking-widest" style={{ color: colors.referenceText }}>
                      Now Playing
                    </p>
                  </div>
                ) : (
                  <video
                    ref={(el) => {
                      videoRef.current = el;
                      if (el) {
                        el.playbackRate = liveItem.data.playback_rate ?? 1;
                        el.volume = liveItem.data.volume ?? 1;
                      }
                    }}
                    src={convertFileSrc(liveItem.data.path)}
                    className={`w-full h-full ${
                      liveItem.data.fit_mode === "cover" ? "object-cover"
                      : liveItem.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    autoPlay
                    loop={liveItem.data.loop_playback ?? true}
                  />
                )}
                {liveItem.data.media_type === "Audio" && (
                  <audio
                    src={convertFileSrc(liveItem.data.path)}
                    ref={(el) => { (window as any).__liveAudio = el; if (el) el.volume = liveItem.data.volume ?? 1; }}
                    autoPlay
                    loop={liveItem.data.loop_playback ?? true}
                  />
                )}
              </div>
            ) : liveItem.type === "Timer" ? (
              <TimerRenderer data={liveItem.data} />
            ) : liveItem.type === "Song" ? (
              liveItem.data.style === "FullSlide" ? (
                <SongSlideRenderer 
                  data={liveItem.data} 
                  scale={windowScale} 
                  fontSize={settings.font_size}
                  fontFamily={settings.verse_font_family}
                  color={colors.verseText}
                  showSectionLabel={!!settings.show_song_section_labels}
                />
              ) : null
            ) : liveItem.type === "SceneComposition" ? (
              <CompositionRenderer
                data={liveItem.data}
                settings={settings}
                appDataDir={appDataDir}
                windowScale={windowScale}
                phoneStreams={phoneStreams}
              />
            ) : null}
            </ErrorBoundary>
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
          <LowerThirdOverlay
            key={lowerThird.data.kind === "Lyrics" ? `lt-${JSON.stringify(lowerThird.data)}` : "lt-static"}
            data={lowerThird.data}
            template={lowerThird.template}
            onCycleComplete={handleLtCycleComplete}
            scale={windowScale}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
