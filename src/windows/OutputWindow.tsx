import React, { useEffect, useState, useRef, useCallback, useLayoutEffect, useMemo } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayItem, PropItem, PresentationSettings, LowerThirdData, LowerThirdTemplate, LowerThirdPayload, OutputConfig } from "../types";
import { OUTPUT_SCHEMA_VERSION } from "../types";
import type { PresentationSnapshot } from "../types";
import {
  computeOutputBackground,
  getTransitionVariants,
  getItemUid,
  resolvePath,
} from "../utils";
import { resolveProgramFrame } from "../compositor/ProgramFrameResolver";
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
import type { LicenseInfo } from "../types/license";
import { tierCapabilities } from "../system/tiers";
import { PresentationSync } from "../system/presentationSync";
import PhoneCameraVideo, { usePhoneCameraOrientation, usePhoneCameraLook, useCameraChroma } from "../components/shared/PhoneCameraVideo";
import { useCameraSource } from "../hooks/useCameraSource";

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

  // Output-manager config for this window (window_label === "output"). Applied
  // as overrides on top of the broadcast settings; defaults are empty/full so
  // behavior is identical until the operator customizes an output.
  const [outputConfig, setOutputConfig] = useState<OutputConfig | null>(null);

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

  // The resolved program frame for this window. Built through the SAME pure
  // resolver the canvas compositor, recorder, and streamer use
  // (`resolveProgramFrame`), so projection, stage preview, recording preview,
  // and streaming preview resolve one consistent frame. Backgrounds, colors,
  // presentation overrides, blackout, and the overlay payloads here are all
  // already resolved + masked for this output — the DOM renderers below draw
  // from the frame instead of re-deriving them.
  const frame = useMemo(() => {
    const config: OutputConfig = outputConfig ?? {
      schema_version: OUTPUT_SCHEMA_VERSION,
      id: "output",
      kind: "window",
      label: "Output",
      enabled: true,
      visible: true,
      source: { type: "live" },
      geometry: { width: window.innerWidth, height: window.innerHeight },
      overlays: { props: true, lower_third: true, logo: true },
    };
    return resolveProgramFrame({
      config,
      snapshot: {
        live: liveItem,
        staged: stagedItem,
        settings,
        props: propItems,
        lower_third: lowerThird,
        revision: 0,
      },
    });
  }, [outputConfig, liveItem, stagedItem, settings, propItems, lowerThird]);

  // Phone WebRTC relay. The operator window hosts the *answering* peer for each
  // phone camera; the backend relays offer/ICE from the phone here and carries
  // our answer/ICE back to the phone over the remote hub. Media flows directly
  // phone <-> this window over the LAN, so no frames pass through Rust.
  const phonePCsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [phoneStreams, setPhoneStreams] = useState<Record<string, MediaStream>>({});

  const [windowScale, setWindowScale] = useState(1);
  const isMounted = useRef(true);
  const [license, setLicense] = useState<LicenseInfo | null>(null);

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
    // Hydration gate (audit #7): presentation events arriving while this
    // window boots are buffered and replayed after `presentation_snapshot`,
    // so a racing backend change is never lost or overwritten by stale data.
    // Every event is revision-tagged (Phase 2), so a stale rebroadcast or an
    // out-of-order delivery is dropped instead of overwriting newer state.
    const presentationSync = new PresentationSync();

    const unlistenTrans = listen<{ detected_item: DisplayItem | null; revision: number }>("live-item-update", (event) => {
      presentationSync.apply(event.payload.revision, () => setLiveItem(event.payload.detected_item ?? null));
    });

    const unlistenSettings = listen<{ settings: PresentationSettings; revision: number }>("settings-changed", (event) => {
      presentationSync.apply(event.payload.revision, () => setSettings(event.payload.settings));
    });

    const unlistenStaged = listen<{ item: DisplayItem | null; revision: number }>("item-staged", (event) => {
      presentationSync.apply(event.payload.revision, () => setStagedItem(event.payload.item ?? null));
    });

    const unlistenOutputConfig = listen("output-config-changed", (event: any) => {
      const configs = event.payload as OutputConfig[];
      setOutputConfig(configs.find((c) => c.window_label === "output") ?? null);
    });

    const unlistenLt = listen<{ lower_third: LowerThirdPayload | null; revision: number }>("lower-third-update", (event) => {
      const payload = event.payload.lower_third;
      presentationSync.apply(event.payload.revision, () => {
        if (payload) {
          setLowerThird({ data: payload.data, template: payload.template });
        } else {
          setLowerThird(null);
        }
      });
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

    const unlistenProps = listen<{ props: PropItem[]; revision: number }>("props-update", (event) => {
      presentationSync.apply(event.payload.revision, () => setPropItems(event.payload.props ?? []));
    });

    const unlistenMonitorTest = listen("monitor-test", (event: any) => {
      setMonitorTest(!!event.payload?.active);
    });

    const unlistenLicense = listen<LicenseInfo>("license-updated", (ev) => {
      setLicense(ev.payload);
    });

    // Hydrate from the authoritative presentation snapshot instead of racing
    // per-field invokes against the event stream (audit #7). All listeners are
    // registered (and awaited) BEFORE the snapshot request, so no event can
    // fire into the void between snapshot application and listener install
    // (audit #2: hydration listener-registration race).
    (async () => {
      await Promise.all([
        unlistenTrans, unlistenSettings, unlistenStaged, unlistenOutputConfig,
        unlistenLt, unlistenMedia, unlistenProps, unlistenMonitorTest, unlistenLicense,
      ]).catch(() => {});
      invoke<PresentationSnapshot | null>("presentation_snapshot")
        .then((snap) => {
          if (snap) {
            presentationSync.applySnapshot(snap.revision, () => {
              setLiveItem(snap.live ?? null);
              setStagedItem(snap.staged ?? null);
              setSettings(snap.settings);
              setPropItems(snap.props ?? []);
              setLowerThird((snap.lower_third as LowerThirdPayload | null) ?? null);
            });
          }
          // Replay anything buffered while the snapshot was in flight, then let
          // new events apply directly.
          presentationSync.open();
        })
        .catch((e: any) => {
          signalOperatorWarning(`Output hydrate (snapshot): ${e?.message ?? e}`);
          presentationSync.open();
        });
      Promise.all([
        invoke<string>("get_app_data_dir").then(setAppDataDir).catch((e: any) => signalOperatorWarning(`Output hydrate (appdir): ${e?.message ?? e}`)),
        invoke<OutputConfig[]>("outputs_list").then((configs) => {
          setOutputConfig(configs.find((c) => c.window_label === "output") ?? null);
        }).catch((e: any) => signalOperatorWarning(`Output hydrate (config): ${e?.message ?? e}`)),
        invoke<LicenseInfo>("license_status").then(setLicense).catch((e: any) => signalOperatorWarning(`Output hydrate (license): ${e?.message ?? e}`)),
      ]);
    })();

    return () => {
      if (mediaStateTimer) clearInterval(mediaStateTimer);
      unlistenTrans.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenLt.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenProps.then((f) => f());
      unlistenMonitorTest.then((f) => f());
      unlistenOutputConfig.then((f) => f());
      unlistenLicense.then((f) => f());
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

  const bgSetting = frame.background.setting;
  const videoBg = bgSetting.type === "Video" ? bgSetting.value : null;
  const cameraBg = bgSetting.type === "Camera" ? bgSetting.value : null;
  const audioBg = bgSetting.type === "Audio" ? bgSetting.value : null;
  const bgImage = bgSetting.type === "Image" ? bgSetting.value : null;

  const bgCameraLook = usePhoneCameraLook(cameraBg?.deviceId ?? null);
  const bgCameraChroma = useCameraChroma(cameraBg?.deviceId ?? null);
  const bgPhoneOrientation = usePhoneCameraOrientation(
    cameraBg?.deviceId?.startsWith("phone-camera-") ? cameraBg.deviceId : null
  );

  // Camera lifecycle (Phase 5 source registry). Local cameras are opened ONCE
  // per device via the ref-counted registry (never one getUserMedia per
  // consumer); phone cameras are relayed over WebRTC by this window's "output"
  // peer and their synthetic ids are never sent to getUserMedia.
  const bgLocalCam = useCameraSource(
    cameraBg?.deviceId && !cameraBg.deviceId.startsWith("phone-camera-") ? cameraBg.deviceId : null,
    "output-window-bg"
  );
  const bgPhoneStream =
    cameraBg?.deviceId?.startsWith("phone-camera-") ? (phoneStreams[cameraBg.deviceId] ?? null) : null;
  const effectiveBgStream = bgPhoneStream ?? bgLocalCam.stream;

  useEffect(() => {
    setCameraStream(effectiveBgStream);
  }, [effectiveBgStream]);

  // Main camera stream. Local cameras are opened ONCE per device via the shared
  // source registry (never one getUserMedia per consumer); phone cameras are
  // handled by the WebRTC relay effect below.
  const mainCamDeviceId =
    liveItem?.type === "Camera" && !liveItem.data.deviceId.startsWith("phone-camera-")
      ? liveItem.data.deviceId
      : null;
  const mainLocalCam = useCameraSource(mainCamDeviceId, "output-window-main");
  useEffect(() => {
    if (liveItem?.type !== "Camera") {
      setMainCameraStream(null);
      return;
    }
    if (liveItem.data.deviceId.startsWith("phone-camera-")) {
      // Phone stream is set by the WebRTC relay effect; do not touch it here.
      return;
    }
    setMainCameraStream(mainLocalCam.stream);
  }, [liveItem?.type, liveItem?.type === "Camera" ? liveItem.data.deviceId : null, mainLocalCam.stream]);

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

  // This output's resolved presentation state comes from the frame: the
  // broadcast settings plus the individually-resolved override fields — theme
  // colors, the effective background, the (masked) overlay payloads, and
  // blackout (config.presentation blanked / settings.is_blanked / blank source).
  const effSettings = frame.settings;
  const overlays = frame.overlays;

  if (frame.blackout) {
    return <div className="fixed inset-0 bg-black cursor-none pointer-events-none select-none" />;
  }

  const colors = frame.colors;
  const isTop = effSettings.reference_position === "top";
  const bgStyle = computeOutputBackground({ ...effSettings, background: bgSetting }, colors, appDataDir);

  // The content this output is subscribed to (the resolved source). With the
  // default live config this is exactly the broadcast live item; an output
  // configured to `staged`/`item`/`scene`/`blank` resolves those here too.
  // Camera/media element lifecycle below still keys on the broadcast live
  // item (Phase 4 wires per-source runtimes for non-live sources).
  const item = frame.source.kind === "blank" ? null : frame.source.item;

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

  const ReferenceTag = item?.type === "Verse" ? (
    <p
      className="uppercase tracking-widest font-bold shrink-0"
      style={{ color: refColor, fontSize: `${refFontSize * windowScale}pt`, fontFamily: refFontFamily }}
    >
      {item.data.book}{" "}
      <span style={{ fontSize: `${cvFontSize}pt`, fontFamily: cvFontFamily, color: cvColor }}>
        {item.data.chapter}:{item.data.verse}
      </span>
      {item.data.version && (
        <span 
          className="font-normal ml-2" 
          style={{ 
            fontSize: `${(settings.version_font_size ?? Math.round(refFontSize * 0.65)) * windowScale}pt`,
            fontFamily: settings.version_font_family ?? refFontFamily,
            color: (settings.version_color && settings.version_color !== "") ? settings.version_color : undefined,
            opacity: (settings.version_color && settings.version_color !== "") ? 1 : 0.6,
          }}
        >
          ({item.data.version})
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

      {overlays.logo && (overlays.logo.text ? (
        <p
          className="absolute bottom-8 right-8 z-60 font-black leading-tight opacity-60 text-right"
          style={{ color: overlays.logo.textColor ?? "#ffffff", fontSize: "1.5rem" }}
        >
          {overlays.logo.text}
        </p>
      ) : overlays.logo.path?.match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
        <video
          src={convertFileSrc(resolvePath(overlays.logo.path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          autoPlay
          loop
          muted
        />
      ) : overlays.logo.path ? (
        <img
          src={convertFileSrc(resolvePath(overlays.logo.path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          alt="Logo"
        />
      ) : null)}

      <AnimatePresence mode="wait">
        {item ? (
          <motion.div
            key={getItemUid(item)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            <ErrorBoundary fallback={<ProjectionErrorFallback />}>
            {item.type === "Verse" ? (
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
                      {item.data.text}
                    </h1>
                    {item.data.split_index !== undefined && item.data.total_splits !== undefined && (
                      <p 
                        className="absolute -bottom-10 right-0 font-black opacity-30 text-xs tracking-widest"
                        style={{ color: colors.verseText, fontSize: `${12 * windowScale}pt` }}
                      >
                        PART {item.data.split_index + 1} / {item.data.total_splits}
                      </p>
                    )}
                  </div>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : item.type === "Camera" ? (
              <div className="absolute inset-0">
                {item.data.backdropColor ? (
                  <div
                    className="absolute inset-0"
                    style={{ background: item.data.backdropColor }}
                  />
                ) : null}
                <PhoneCameraVideo
                  stream={mainCameraStream}
                  orientation={livePhoneOrientation}
                  look={liveCameraLook}
                  mirrored={item.data.mirrored}
                  objectFit={(item.data.objectFit as any) ?? "cover"}
                  style={{ opacity: item.data.opacity ?? 1 }}
                  chromaKey={liveCameraChroma}
                  videoRef={(el) => { mainCameraRef.current = el; }}
                />
              </div>
            ) : item.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={item.data} scale={windowScale} appDataDir={appDataDir} theme={item.data.theme} entranceEnabled />
              </div>
            ) : item.type === "Media" ? (
              <div className="absolute inset-0">
                {item.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(item.data.path)}
                    className={`w-full h-full ${
                      item.data.fit_mode === "cover" ? "object-cover"
                      : item.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    alt={item.data.name}
                  />
                ) : item.data.media_type === "Audio" ? (
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
                    <p className="text-3xl font-bold drop-shadow-lg" style={{ color: colors.verseText }}>{item.data.name}</p>
                    <p className="text-sm uppercase tracking-widest" style={{ color: colors.referenceText }}>
                      Now Playing
                    </p>
                  </div>
                ) : (
                  <video
                    ref={(el) => {
                      videoRef.current = el;
                      if (el) {
                        el.playbackRate = item.data.playback_rate ?? 1;
                        el.volume = item.data.volume ?? 1;
                      }
                    }}
                    src={convertFileSrc(item.data.path)}
                    className={`w-full h-full ${
                      item.data.fit_mode === "cover" ? "object-cover"
                      : item.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    autoPlay
                    loop={item.data.loop_playback ?? true}
                  />
                )}
                {item.data.media_type === "Audio" && (
                  <audio
                    src={convertFileSrc(item.data.path)}
                    ref={(el) => { (window as any).__liveAudio = el; if (el) el.volume = item.data.volume ?? 1; }}
                    autoPlay
                    loop={item.data.loop_playback ?? true}
                  />
                )}
              </div>
            ) : item.type === "Timer" ? (
              <TimerRenderer data={item.data} />
            ) : item.type === "Song" ? (
              item.data.style === "FullSlide" ? (
                <SongSlideRenderer 
                  data={item.data} 
                  scale={windowScale} 
                  fontSize={settings.font_size}
                  fontFamily={settings.verse_font_family}
                  color={colors.verseText}
                  showSectionLabel={!!settings.show_song_section_labels}
                />
              ) : null
            ) : item.type === "SceneComposition" ? (
              <CompositionRenderer
                data={item.data}
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

      {overlays.props.length > 0 && <PropsRenderer items={overlays.props} appDataDir={appDataDir} />}

      <AnimatePresence>
        {overlays.lower_third && (
          <LowerThirdOverlay
            key={overlays.lower_third.data.kind === "Lyrics" ? `lt-${JSON.stringify(overlays.lower_third.data)}` : "lt-static"}
            data={overlays.lower_third.data}
            template={overlays.lower_third.template}
            onCycleComplete={handleLtCycleComplete}
            scale={windowScale}
          />
        )}
      </AnimatePresence>

      {license?.status === "active" && tierCapabilities(license.tier).watermark && (
        <div className="absolute inset-0 z-[65] pointer-events-none flex items-end justify-center pb-3">
          <span
            className="text-[12px] font-black uppercase tracking-widest text-white/40"
            style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
          >
            Wordlyte Free
          </span>
        </div>
      )}
    </div>
  );
}
