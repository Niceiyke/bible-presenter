import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import {
  MediaItem, Song, LowerThirdTemplate,
  PresentationSettings, PropItem, SceneData, ServiceMeta,
  DisplayItem, StartupStatus
} from "../types";

export function useAppInitialization() {
  const {
    setLabel, setMedia, setStudioList, setStudioSlides,
    setScheduleEntries, setSongs, setHymnLibrary, setLtSavedTemplates,
    setLtTemplate, setSettings, setAvailableVersions, setBibleVersion,
    setPropItems, setSavedScenes, setServices, setLiveItem,
    setTranscript, setSuggestedItem, setSuggestedConfidence,
    setStagedItem, setOperatorMicLevel, setPreacherMicLevel,
    setOperatorRecordingActive, setPreacherRecordingActive,
    setSessionState, setAudioError, setLtVisible,
    appendTranscriptSegment, setVerseLockUntil, setManualOverrideUntil,
    setStartupIssues, setIsInitialized,
    setCurrentLowerThird,
    bibleVersion, transcriptionWindowSec,
  } = useAppStore();

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") {
      setIsInitialized(true);
      return;
    }

    const loadAll = async () => {
      // ... existing probe logic ...
      let ready = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          await invoke("get_startup_status");
          ready = true;
          break;
        } catch (e) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ready) return;

      const [
        versionsRes, mediaRes, studioRes, scheduleRes, songsRes, hymnLibraryRes,
        ltRes, settingsRes, propsRes,
        scenesRes, servicesRes, currentLtRes
      ] = await Promise.all([
        invoke<string[]>("get_bible_versions").catch(() => []),
        invoke<MediaItem[]>("list_media").catch(() => []),
        invoke<any[]>("list_studio_presentations").catch(() => []),
        invoke<any>("load_schedule").catch(() => ({ items: [] })),
        invoke<Song[]>("list_songs").catch(() => []),
        invoke<Song[]>("get_hymn_library").catch(() => []),
        invoke<LowerThirdTemplate[]>("load_lt_templates").catch(() => []),
        invoke<PresentationSettings>("get_settings").catch(() => null),
        invoke<PropItem[]>("get_props").catch(() => []),
        invoke<SceneData[]>("list_scenes").catch(() => []),
        invoke<ServiceMeta[]>("list_services").catch(() => []),
        invoke<any>("get_current_lower_third").catch(() => null),
      ]);

      setMedia(mediaRes);
      setStudioList(studioRes);
      const scheduleItems = Array.isArray(scheduleRes?.items) ? scheduleRes.items : [];
      setScheduleEntries(scheduleItems.map((e: any) => ({ id: e.id || stableId(), item: e.item ?? e })));
      setSongs(songsRes);
      setHymnLibrary(hymnLibraryRes);

      // Handle LT templates loading with fallback to default
      const savedTpls = ltRes.length ? ltRes : [useAppStore.getState().ltTemplate];
      setLtSavedTemplates(savedTpls);
      const activeId = localStorage.getItem("activeLtTemplateId");
      const active = savedTpls.find(t => t.id === activeId) || savedTpls[0];
      setLtTemplate(active);
      
      if (currentLtRes) setCurrentLowerThird(currentLtRes);

      if (settingsRes) setSettings(settingsRes);

      // Setting availableVersions is what unblocks useBibleCascade — do it last.
      setAvailableVersions(versionsRes);
      setBibleVersion(localStorage.getItem("pref_bibleVersion") || (versionsRes.length > 0 ? versionsRes[0] : ""));

      setPropItems(propsRes);
      setSavedScenes(scenesRes);
      setServices(servicesRes.length ? servicesRes : [{ id: "default", name: "Sunday Service", item_count: 0, updated_at: Date.now() }]);

      invoke("get_current_item").then((v: any) => { if (v) setLiveItem(v); }).catch(() => {});

      invoke("set_transcription_window", { samples: Math.round(transcriptionWindowSec * 16000) }).catch(() => {});
      
      const opDev = useAppStore.getState().operatorDevice;
      if (opDev) invoke("set_operator_device", { deviceName: opDev }).catch(() => {});
      const prDev = useAppStore.getState().preacherDevice;
      if (prDev) invoke("set_preacher_device", { deviceName: prDev }).catch(() => {});

      // Check startup status and surface any missing-file issues to the operator
      invoke<StartupStatus>("get_startup_status").then((status) => {
        if (status.issues.length > 0) {
          setStartupIssues(status.issues);
        }
      }).catch(() => {});

      setIsInitialized(true);
    };

    loadAll();

    // Listeners
    const unlistenTrans = listen("operator-transcription-update", (ev: any) => {
      // ── Ignore transcription updates until fully initialized ──────────────
      if (!useAppStore.getState().isInitialized) return;

      const { text, detected_item, confidence, source, is_partial } = ev.payload;

      // ── Manual source: operator-triggered go_live, always apply ──────────
      if (source === "manual") {
        setLiveItem(detected_item ?? null);
        return;
      }

      // Ignore partials — only act on final transcripts
      if (is_partial) return;

      // ── Final transcript: commit to log ────────────────────────────────────
      if (text) {
        appendTranscriptSegment({
          text,
          timestamp_ms: Date.now(),
          is_final: true,
          source: "operator",
        });
      }

      if (!detected_item) return;

      const cfg = useAppStore.getState().transcriptionConfig;
      const now = Date.now();
      const overrideUntil  = useAppStore.getState().manualOverrideUntil;
      const lockUntil      = useAppStore.getState().verseLockUntil;
      const withinOverride = overrideUntil != null && now < overrideUntil;
      const withinLock     = lockUntil != null && now < lockUntil;

      // Suppress entirely if operator recently made a manual selection
      if (withinOverride) return;

      // Always update the suggestion banner
      setSuggestedItem(detected_item);
      setSuggestedConfidence(confidence ?? 0);

      if (!cfg.auto_project) return;

      const isExplicit  = confidence === 1.0;
      const threshold   = cfg.confidence_threshold ?? 0.55;
      const highConfidence = (confidence ?? 0) >= 0.85;

      // Decide whether to project:
      // • Explicit reference  → always project (overrides lock)
      // • High confidence     → project even within lock window
      // • Normal confidence above threshold + outside lock window → project
      const shouldProject =
        isExplicit ||
        highConfidence ||
        (!withinLock && (confidence ?? 0) >= threshold);

      if (shouldProject) {
        setLiveItem(detected_item);
        setVerseLockUntil(now + cfg.verse_lock_secs * 1000);
      }
    });

    const unlistenPreacherTrans = listen("preacher-transcription-update", (ev: any) => {
      const { text, detected_item, confidence, is_partial, source } = ev.payload;

      // Manual operator actions broadcast to both channels — ignore on preacher side
      if (source === "manual") return;

      // Ignore partials entirely — only act on final transcripts
      if (is_partial) return;

      if (text) {
        appendTranscriptSegment({
          text,
          timestamp_ms: Date.now(),
          is_final: true,
          source: "preacher",
        });
      }

      // Verse detection from the streaming pipeline — same logic as operator finals
      if (detected_item) {
        const cfg = useAppStore.getState().transcriptionConfig;
        const now = Date.now();
        const overrideUntil = useAppStore.getState().manualOverrideUntil;
        const lockUntil     = useAppStore.getState().verseLockUntil;
        const withinOverride = overrideUntil != null && now < overrideUntil;
        const withinLock     = lockUntil != null && now < lockUntil;

        if (!withinOverride) {
          setSuggestedItem(detected_item);
          setSuggestedConfidence(confidence ?? 0);

          if (cfg.auto_project) {
            const isExplicit     = confidence === 1.0;
            const highConfidence = (confidence ?? 0) >= 0.85;
            const threshold      = cfg.confidence_threshold ?? 0.55;
            const shouldProject  = isExplicit || highConfidence || (!withinLock && (confidence ?? 0) >= threshold);
            if (shouldProject) {
              setLiveItem(detected_item);
              setVerseLockUntil(now + cfg.verse_lock_secs * 1000);
            }
          }
        }
      }
    });
    
    const unlistenStaged = listen("item-staged", (ev: any) => setStagedItem(ev.payload as DisplayItem));
    const unlistenOperatorLevel = listen("operator-audio-level", (ev: any) => setOperatorMicLevel(Math.min(1, Math.sqrt(ev.payload as number) / 0.35)));
    const unlistenPreacherLevel = listen("preacher-audio-level", (ev: any) => setPreacherMicLevel(Math.min(1, Math.sqrt(ev.payload as number) / 0.35)));
    const unlistenOperatorStatus = listen("operator-recording-status", (ev: any) => setOperatorRecordingActive((ev.payload as any).active));
    const unlistenPreacherStatus = listen("preacher-recording-status", (ev: any) => setPreacherRecordingActive((ev.payload as any).active));
    const unlistenSettings = listen("settings-changed", (ev: any) => setSettings(ev.payload as PresentationSettings));
    const unlistenStatus = listen("session-status", (ev: any) => {
      const { status, message } = ev.payload as { status: string; message: string };
      if (status === "running") { setSessionState("running"); setAudioError(null); }
      else if (status === "loading") setSessionState("loading");
      else if (status === "stopping") setSessionState("stopping");
      else {
        // "stopped" or "error"
        setSessionState("idle");
        setOperatorRecordingActive(false);
        setPreacherRecordingActive(false);
        if (status === "error" && message) setAudioError(message);
      }
    });
    const unlistenAudioErr = listen("audio-error", (ev: any) => setAudioError(ev.payload as string));
    const unlistenLtUpdate = listen("lower-third-update", (ev: any) => {
      const payload = ev.payload;
      if (payload) {
        setCurrentLowerThird(payload);
        setLtVisible(true);
      } else {
        setCurrentLowerThird(null);
        setLtVisible(false);
      }
    });
    const unlistenLtSync = listen<LowerThirdTemplate[]>("lower-third-template-sync", (ev) => {
      const incoming = ev.payload;
      if (incoming.length === 1) {
        const t = incoming[0];
        setLtSavedTemplates(useAppStore.getState().ltSavedTemplates.map(old => old.id === t.id ? t : old));
        if (useAppStore.getState().ltTemplate.id === t.id) setLtTemplate(t);
      } else {
        setLtSavedTemplates(incoming);
        const activeId = useAppStore.getState().ltTemplate.id;
        const active = incoming.find(t => t.id === activeId);
        if (active) setLtTemplate(active);
      }
    });
    const unlistenScenesSync = listen<SceneData[]>("scenes-sync", (ev) => {
      setSavedScenes(ev.payload);
    });
    const unlistenSongsSync = listen<Song[]>("songs-sync", (ev) => {
      setSongs(ev.payload);
    });
    const unlistenStudioSync = listen<any[]>("studio-sync", (ev) => {
      setStudioList(ev.payload);
    });
    const unlistenStudioSlidesSync = listen<{ id: string; slides: any[] }>("studio-slides-sync", (ev) => {
      const { id, slides } = ev.payload;
      setStudioSlides({ ...useAppStore.getState().studioSlides, [id]: slides });
    });
    const unlistenLog = listen<any>("system-log", (ev) => {
      useAppStore.getState().addLog(ev.payload);
    });

    const decayInterval = setInterval(() => {
      setOperatorMicLevel((prev) => (prev > 0.01 ? prev * 0.85 : 0));
      setPreacherMicLevel((prev) => (prev > 0.01 ? prev * 0.85 : 0));
    }, 50);

    return () => {
      unlistenTrans.then(f => f()); 
      unlistenPreacherTrans.then(f => f());
      unlistenStaged.then(f => f()); 
      unlistenOperatorLevel.then(f => f()); 
      unlistenPreacherLevel.then(f => f());
      unlistenOperatorStatus.then(f => f());
      unlistenPreacherStatus.then(f => f());
      unlistenSettings.then(f => f());
      unlistenStatus.then(f => f());
      unlistenAudioErr.then(f => f());
      unlistenLtUpdate.then(f => f());
      unlistenLtSync.then(f => f());
      unlistenScenesSync.then(f => f());
      unlistenSongsSync.then(f => f());
      unlistenStudioSync.then(f => f());
      unlistenStudioSlidesSync.then(f => f());
      unlistenLog.then(f => f());
      clearInterval(decayInterval);
    };
  }, []);

  // Sync Bible version
  useEffect(() => {
    const label = getCurrentWindow().label;
    if (label === "main") {
      invoke("set_bible_version", { version: bibleVersion }).catch(() => {});
    }
  }, [bibleVersion]);
}
