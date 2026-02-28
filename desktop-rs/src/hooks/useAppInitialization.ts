import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import type { 
  MediaItem, PresentationFile, Song, LowerThirdTemplate, 
  PresentationSettings, PropItem, SceneData, ServiceMeta, 
  DisplayItem 
} from "../types";

export function useAppInitialization() {
  const {
    setLabel, setMedia, setPresentations, setStudioList, setStudioSlides,
    setScheduleEntries, setSongs, setLtSavedTemplates, 
    setLtTemplate, setSettings, setRemoteUrl, setRemotePin, 
    setTailscaleUrl, setAvailableVersions, setBibleVersion, 
    setPropItems, setSavedScenes, setServices, setLiveItem,
    setTranscript, setSuggestedItem, setSuggestedConfidence,
    setStagedItem, setMicLevel, setSessionState, setAudioError,
    bibleVersion, transcriptionWindowSec,
  } = useAppStore();

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") return;

    const loadAll = async () => {
      // Probe backend readiness first — retry until get_bible_versions succeeds.
      // During tauri dev backend restarts the state may not be managed yet, so
      // we wait rather than letting the cascade see an unmanaged-state error.
      let versionsRes: string[] = [];
      for (let attempt = 0; attempt < 10 && versionsRes.length === 0; attempt++) {
        versionsRes = await invoke<string[]>("get_bible_versions").catch(() => []);
        if (versionsRes.length === 0) await new Promise(r => setTimeout(r, 600));
      }
      if (versionsRes.length === 0) return; // backend never became ready

      const [
        mediaRes, presRes, studioRes, scheduleRes, songsRes,
        ltRes, settingsRes, remoteRes, propsRes,
        scenesRes, servicesRes
      ] = await Promise.all([
        invoke<MediaItem[]>("list_media").catch(() => []),
        invoke<PresentationFile[]>("list_presentations").catch(() => []),
        invoke<any[]>("list_studio_presentations").catch(() => []),
        invoke<any>("load_schedule").catch(() => ({ items: [] })),
        invoke<Song[]>("list_songs").catch(() => []),
        invoke<LowerThirdTemplate[]>("load_lt_templates").catch(() => []),
        invoke<PresentationSettings>("get_settings").catch(() => null),
        invoke<any>("get_remote_info").catch(() => null),
        invoke<PropItem[]>("get_props").catch(() => []),
        invoke<SceneData[]>("list_scenes").catch(() => []),
        invoke<ServiceMeta[]>("list_services").catch(() => []),
      ]);

      setMedia(mediaRes);
      setPresentations(presRes);
      setStudioList(studioRes);
      setScheduleEntries(scheduleRes.items.map((e: any) => ({ id: e.id || stableId(), item: e.item ?? e })));
      setSongs(songsRes);

      if (ltRes.length) {
        setLtSavedTemplates(ltRes);
        setLtTemplate(ltRes.find(t => t.id === localStorage.getItem("activeLtTemplateId")) || ltRes[0]);
      }

      if (settingsRes) setSettings(settingsRes);

      if (remoteRes) {
        setRemoteUrl(remoteRes.url);
        setRemotePin(remoteRes.pin);
        setTailscaleUrl(remoteRes.tailscale_url);
      }

      // Setting availableVersions is what unblocks useBibleCascade — do it last.
      setAvailableVersions(versionsRes);
      setBibleVersion(localStorage.getItem("pref_bibleVersion") || versionsRes[0]);

      setPropItems(propsRes);
      setSavedScenes(scenesRes);
      setServices(servicesRes.length ? servicesRes : [{ id: "default", name: "Sunday Service", item_count: 0, updated_at: Date.now() }]);

      invoke("get_current_item").then((v: any) => { if (v) setLiveItem(v); }).catch(() => {});

      invoke("set_transcription_window", { samples: Math.round(transcriptionWindowSec * 16000) }).catch(() => {});
    };

    loadAll();

    // Listeners
    const unlistenTrans = listen("transcription-update", (ev: any) => {
      const { text, detected_item, confidence, source } = ev.payload;
      setTranscript(text);
      if (source === "manual") {
        setLiveItem(detected_item ?? null);
      } else if (detected_item) {
        setSuggestedItem(detected_item);
        setSuggestedConfidence(confidence ?? 0);
      }
    });
    
    const unlistenStaged = listen("item-staged", (ev: any) => setStagedItem(ev.payload as DisplayItem));
    const unlistenLevel = listen("audio-level", (ev: any) => setMicLevel(Math.min(1, Math.sqrt(ev.payload as number) / 0.35)));
    const unlistenSettings = listen("settings-changed", (ev: any) => setSettings(ev.payload as PresentationSettings));
    const unlistenStatus = listen("session-status", (ev: any) => {
      const { status } = ev.payload as { status: string };
      if (status === "running") setSessionState("running");
      else if (status === "loading") setSessionState("loading");
      else setSessionState("idle");
    });
    const unlistenAudioErr = listen("audio-error", (ev: any) => setAudioError(ev.payload as string));
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

    const decayInterval = setInterval(() => setMicLevel((prev) => (prev > 0.01 ? prev * 0.85 : 0)), 50);

    return () => {
      unlistenTrans.then(f => f()); 
      unlistenStaged.then(f => f()); 
      unlistenLevel.then(f => f()); 
      unlistenSettings.then(f => f());
      unlistenStatus.then(f => f());
      unlistenAudioErr.then(f => f());
      unlistenLtSync.then(f => f());
      unlistenScenesSync.then(f => f());
      unlistenSongsSync.then(f => f());
      unlistenStudioSync.then(f => f());
      unlistenStudioSlidesSync.then(f => f());
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
