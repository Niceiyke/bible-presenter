import React, { useEffect, useState, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayItem, PropItem, PresentationSettings, LowerThirdData, LowerThirdTemplate, OutputConfig } from "../types";
import type { PresentationSnapshot } from "../types";
import { getVideoBackground, getCameraBackground, getAudioBackground, getImageBackground, resolvePath } from "../utils";
import { signalOperatorWarning } from "../hooks/useAppInitialization";
import { useFonts } from "../hooks/useFonts";
import { useCaptureActive } from "../hooks/useCaptureActive";
import type { LicenseInfo } from "../types/license";
import { resolveOutputFrame } from "../outputs/resolveOutputFrame";
import { ProgramSurface } from "../components/outputs/ProgramSurface";

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
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [mainCameraStream, setMainCameraStream] = useState<MediaStream | null>(null);
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
  const [license, setLicense] = useState<LicenseInfo | null>(null);

  // Calculate font scale based on current window height relative to the
  // configured output reference height (1080p by default), so slides/songs
  // authored for the reference resolution project proportionally even when
  // the projector window is 720p, 1440p, or DPI-scaled. Uses the *effective*
  // height after this output's presentation override is applied.
  const effectiveRefHeight =
    outputConfig?.presentation?.reference_output_height ??
    settings.reference_output_height ??
    1080;
  useEffect(() => {
    const updateScale = () => {
      setWindowScale(window.innerHeight / effectiveRefHeight);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, [effectiveRefHeight]);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Hydration gate (audit #7): presentation events arriving while this
    // window boots are buffered and replayed after `presentation_snapshot`,
    // so a racing backend change is never lost or overwritten by stale data.
    let presentationOpen = false;
    let presentationBuffer: Array<() => void> = [];
    const applyOrBuffer = (fn: () => void) => {
      if (presentationOpen) fn();
      else presentationBuffer.push(fn);
    };
    const drainPresentation = () => {
      for (const fn of presentationBuffer) fn();
      presentationBuffer = [];
      presentationOpen = true;
    };

    const unlistenTrans = listen("live-item-update", (event: any) => {
      const { detected_item } = event.payload;
      applyOrBuffer(() => setLiveItem(detected_item ?? null));
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      applyOrBuffer(() => setSettings(event.payload as PresentationSettings));
    });

    const unlistenStaged = listen("item-staged", (event: any) => {
      applyOrBuffer(() => setStagedItem(event.payload as DisplayItem | null));
    });

    const unlistenOutputConfig = listen("output-config-changed", (event: any) => {
      const configs = event.payload as OutputConfig[];
      setOutputConfig(configs.find((c) => c.window_label === "output") ?? null);
    });

    const unlistenLt = listen("lower-third-update", (event: any) => {
      applyOrBuffer(() => {
        if (event.payload) {
          setLowerThird({ data: event.payload.data as LowerThirdData, template: event.payload.template as LowerThirdTemplate });
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

    const unlistenProps = listen("props-update", (event: any) => {
      applyOrBuffer(() => setPropItems((event.payload as PropItem[]) ?? []));
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
            setLiveItem(snap.live ?? null);
            setStagedItem(snap.staged ?? null);
            setSettings(snap.settings);
            setPropItems(snap.props ?? []);
            setLowerThird((snap.lower_third as any) ?? null);
          }
          // Replay anything buffered while the snapshot was in flight, then let
          // new events apply directly.
          drainPresentation();
        })
        .catch((e: any) => {
          signalOperatorWarning(`Output hydrate (snapshot): ${e?.message ?? e}`);
          drainPresentation();
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

  const videoBg = getVideoBackground(settings, liveItem);
  const cameraBg = getCameraBackground(settings, liveItem);
  const audioBg = getAudioBackground(settings, liveItem);
  const bgImage = getImageBackground(settings, liveItem);

  // Camera decode gating (per window). The audience "output" window only
  // decodes camera feeds while it is visible (its OutputConfig carries the
  // authoritative `visible` flag). The off-screen "capture" window — the WGC
  // source for recording/streaming — only decodes while a session is actively
  // capturing it. When the gate is off, local getUserMedia opens are skipped
  // and hosted phone peers are torn down, so a hidden projector or an idle
  // capture window costs no camera encode or WebRTC decode.
  const captureActive = useCaptureActive();
  const windowLabel = getCurrentWindow().label;
  const isOutputWindow = windowLabel === "output";
  const isCaptureWindow = windowLabel === "capture";
  // Which phone WebRTC "target" this window answers: the audience "output"
  // window hosts the "output" peer; the off-screen "capture" window hosts the
  // "capture" peer; anything else hosts neither (the operation-preview
  // "operator" peer belongs to the main window).
  const phonePeerTarget = isOutputWindow ? "output" : isCaptureWindow ? "capture" : null;
  const [bootOutputVisible, setBootOutputVisible] = useState(false);
  useEffect(() => {
    getCurrentWindow().isVisible().then((v) => setBootOutputVisible(v)).catch(() => {});
  }, []);
  const outputVisible = isOutputWindow ? (outputConfig?.visible ?? bootOutputVisible) : false;
  // The `capture` window is the WGC source only while the projector is OFF —
  // when the output window is on screen a live session captures the real window
  // instead, so the fallback window must not decode/answer/relay anything
  // (avoiding a second full render of a feed the audience window already shows).
  const captureSourceLive = isCaptureWindow && captureActive && !(outputConfig?.visible ?? false);
  const gateCameras = isOutputWindow ? outputVisible : captureSourceLive;

  // Browser-only camera stream lifecycle. Phone cameras stream over the WebRTC
  // relay hosted by this window's answering peer (their ids are synthetic and
  // can never be opened with getUserMedia here).
  useEffect(() => {
    const deviceId = cameraBg?.deviceId;

    const stopLocal = () => {
      if (localBgCameraRef.current) {
        localBgCameraRef.current.getTracks().forEach(track => track.stop());
        localBgCameraRef.current = null;
      }
    };

    if (!gateCameras) {
      stopLocal();
      setCameraStream(null);
      return;
    }

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
  }, [cameraBg?.deviceId, phoneStreams, gateCameras]);

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

    if (!gateCameras) {
      if (mainCameraStream) {
        mainCameraStream.getTracks().forEach(track => track.stop());
        setMainCameraStream(null);
      }
      return () => {};
    }

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
  }, [liveItem?.type === "Camera" ? liveItem.data.deviceId : null, gateCameras]);

  // Phone camera WebRTC relay: host the answering peer for this window's
  // target. The audience `output` window answers "output" peers; the off-screen
  // `capture` window (the WGC source for recording/streaming) answers "capture"
  // peers; the main operator window hosts the "operator" preview peer itself.
  const gateRef = useRef(gateCameras);
  gateRef.current = gateCameras;
  useEffect(() => {
    if (!phonePeerTarget) return;
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
              target: phonePeerTarget,
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
        await invoke("phone_camera_answer", { deviceId: pcKey, sdp: answer.sdp ?? "", target: phonePeerTarget });
      } catch (err) {
        console.error("Phone camera answer setup failed:", err);
        teardown(deviceId);
      }
    };

    (async () => {
      unlistenOffer = await listen("phone-camera-offer", (e) => {
        const p = e.payload as { device_id: string; device_name: string; sdp: string; target?: string };
        // Only answer the target this window hosts (see phonePeerTarget). ICE
        // relays for other targets flow to a different window.
        if (!gateRef.current || p.target !== phonePeerTarget) return;
        handleOffer(p.device_id, p.sdp, p.device_id);
      });
      unlistenIce = await listen("phone-camera-ice", (e) => {
        const p = e.payload as { device_id: string; candidate: string; sdp_mid: string; sdp_m_line_index: number; target?: string };
        if (!gateRef.current || p.target !== phonePeerTarget) return;
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
  }, [phonePeerTarget]);

  // When the camera gate turns off, tear down this window's hosted answering
  // peers and stop the relayed tracks immediately — decoding must stop now, not
  // whenever the phone next notices via snapshot events.
  useEffect(() => {
    if (gateCameras) return;
    phonePCsRef.current.forEach((pc) => pc.close());
    phonePCsRef.current.clear();
    setPhoneStreams((prev) => {
      Object.values(prev).forEach((s) => s?.getTracks().forEach((t) => t.stop()));
      return {};
    });
  }, [gateCameras]);

  // When the live item is a phone camera, present the relayed stream instead of
  // a local getUserMedia feed (which cannot open a "phone-camera-*" device id).
  useEffect(() => {
    const deviceId = liveItem?.type === "Camera" ? liveItem.data.deviceId : null;
    const phoneStream = deviceId && deviceId.startsWith("phone-camera-") ? phoneStreams[deviceId] : undefined;
    if (phoneStream && gateCameras) {
      setMainCameraStream(phoneStream);
    } else {
      setMainCameraStream(null);
    }
  }, [liveItem?.type === "Camera" ? liveItem.data.deviceId : null, phoneStreams, gateCameras]);

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

  const lowerThirdState = lowerThird ? { data: lowerThird.data, template: lowerThird.template } : null;

  const frame = resolveOutputFrame({
    live: liveItem,
    staged: stagedItem,
    settings,
    lowerThird: lowerThirdState,
    propItems,
    config: outputConfig,
    license,
  });

  return (
    <ProgramSurface
      mode="output"
      frame={frame}
      runtime={{
        windowScale,
        appDataDir,
        monitorTest,
        videoRef,
        bgVideoRef,
        bgAudioRef,
        cameraStream,
        mainCameraStream,
        phoneStreams,
        onLowerThirdCycleComplete: handleLtCycleComplete,
      }}
    />
  );
}
