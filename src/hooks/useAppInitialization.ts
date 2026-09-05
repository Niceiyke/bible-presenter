import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import { normalizeSong } from "../utils/song";
import {
  MediaItem, Song, LowerThirdTemplate,
  PresentationSettings, PropItem, ServiceMeta,
  DisplayItem, OutputConfig, OutputState,
  PresentationSnapshot,
} from "../types";
import type { LicenseInfo } from "../types/license";

/** Helper for windows that can't reach the operator store directly
 *  (e.g. the output window) to surface hydration/emit failures. */
export function signalOperatorWarning(message: string) {
  emit("operator-warning", { level: "warn", message, timestamp: Date.now() }).catch(() => {});
}

export function useAppInitialization() {
  const {
    setLabel, setMedia, upsertMediaItem, setStudioList, setStudioSlides,
    setScheduleEntries, setSongs, setHymnLibrary, setLtSavedTemplates,
    setLtTemplate, setSettings, setAvailableVersions, setBibleVersion,
    setPropItems, setServices, setLiveItem,
    setLtVisible, setCurrentLowerThird,
    setStagedItem, setStartupIssues, setIsInitialized,
    setAppDataDir, setRecentItems,
    setBackendError, addLog, setScenes,
    setBackendAvailable, setToast,
    setOutputs, setOutputState,
    setLicense, setBibleIndexing,
  } = useAppStore();

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output" || windowLabel === "capture") {
      setIsInitialized(true);
      return;
    }

    // ── Hydration gate ─────────────────────────────────────────────────────
    // Presentation-critical events that arrive between listener registration
    // and snapshot application are buffered and replayed on top of the
    // authoritative `presentation_snapshot`. This closes the hydration races
    // (audit #7): a backend live/staged/settings/lower-third/props change that
    // lands while this window boots can never be lost, and the snapshot can
    // never overwrite a newer update. Events carry full sub-state, so replay
    // after snapshot converges.
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

    const loadAll = async () => {
      // Wait for every presentation-critical listener to be REGISTERED before
      // any snapshot/hydration request. A `listen()` promise resolving late
      // must never leave a window where an event fires but no listener exists
      // (audit #2: hydration listener-registration race).
      await Promise.all([
        unlistenStaged, unlistenLive, unlistenSettings, unlistenProps,
        unlistenLtUpdate, unlistenLtSync, unlistenSongsSync, unlistenStudioSync,
        unlistenStudioSlidesSync, unlistenLog, unlistenOpWarn, unlistenRemoteDeviceEvent,
        unlistenMediaProbed, unlistenMediaUpdated, unlistenOutputConfig, unlistenOutputState,
        unlistenLicense, unlistenBibleIndex,
      ]).catch(() => {});
      let ready = false;
      let startupIssues: string[] = [];
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          const status = await invoke<any>("get_startup_status");
          // Surface storage/startup problems (e.g. data DB fell back to
          // in-memory) instead of hiding them behind an empty workspace.
          startupIssues = Array.isArray(status?.issues) ? status.issues : [];
          ready = true;
          break;
        } catch (e) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ready) {
        setBackendAvailable(false);
        setIsInitialized(true);
        return;
      }
      setBackendAvailable(true);
      setStartupIssues(startupIssues);

      const [
        versionsRes, mediaRes, studioRes, scheduleRes, songsRes, hymnLibraryRes,
        ltRes, settingsRes, propsRes,
        servicesRes, appDirRes, snapRes
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
        invoke<ServiceMeta[]>("list_services").catch(() => []),
        invoke<string>("get_app_data_dir").catch(() => null),
        invoke<PresentationSnapshot | null>("presentation_snapshot").catch(() => null),
      ]);

      setMedia(mediaRes);
      setStudioList(studioRes);
      if (appDirRes) setAppDataDir(appDirRes);
      const scheduleItems = Array.isArray(scheduleRes?.items) ? scheduleRes.items : [];
      setScheduleEntries(scheduleItems.map((e: any) => ({ id: e.id || stableId(), item: e.item ?? e })));
      setSongs(songsRes);
      // Hymns ship without section ids / arrangement_steps. Normalize so
      // every consumer (sequence, live nav, lower third) sees the full
      // arrangement order instead of falling back to natural section order.
      setHymnLibrary(hymnLibraryRes.map(normalizeSong));

      const savedTpls = ltRes.length ? ltRes : [useAppStore.getState().ltTemplate];
      setLtSavedTemplates(savedTpls);
      const activeId = localStorage.getItem("activeLtTemplateId");
      const active = savedTpls.find(t => t.id === activeId) || savedTpls[0];
      setLtTemplate(active);

      if (settingsRes) setSettings(settingsRes);

      setAvailableVersions(versionsRes);
      setBibleVersion(localStorage.getItem("pref_bibleVersion") || (versionsRes.length > 0 ? versionsRes[0] : ""));

      setPropItems(propsRes);
      setServices(servicesRes.length ? servicesRes : [{ id: "default", name: "Sunday Service", item_count: 0, updated_at: Date.now() }]);

      // Apply the authoritative presentation snapshot, then replay any events
      // buffered while we hydrated so the newest backend state wins.
      if (snapRes) {
        setLiveItem(snapRes.live ?? null);
        setStagedItem(snapRes.staged ?? null);
        if (snapRes.settings) setSettings(snapRes.settings);
        setPropItems(snapRes.props ?? []);
        setCurrentLowerThird((snapRes.lower_third as any) ?? null);
        // The lower-third visibility flag is authoritative on the backend and
        // derived from whether a payload is present (audit #8).
        setLtVisible(!!snapRes.lower_third);
      } else {
        // No snapshot (older backend) — fall back to the legacy per-field
        // hydration so a stale live item never lingers on a null payload.
        invoke<DisplayItem | null>("get_current_item")
          .then((v) => setLiveItem(v ?? null))
          .catch((e) => signalOperatorWarning(`Failed to hydrate live item: ${e}`));
      }
      drainPresentation();

      // P1.5 — Restore persisted recents and schedule undo/redo stacks.
      invoke<any>("load_workspace", { key: "recents" }).then((r) => {
        if (r) setRecentItems(r);
      }).catch((e) => signalOperatorWarning(`Failed to restore recents: ${e}`));
      invoke<any>("load_workspace", { key: "schedule_history" }).then((h) => {
        if (h && Array.isArray(h.past) && Array.isArray(h.future)) {
          useAppStore.setState({
            pastScheduleStates: h.past,
            futureScheduleStates: h.future,
          });
        }
      }).catch((e) => signalOperatorWarning(`Failed to restore schedule history: ${e}`));

      // P1.6 — Load scenes.
      invoke<any[]>("list_scenes").then(setScenes).catch((e) => signalOperatorWarning(`Failed to load scenes: ${e}`));

      // Output manager — load configs + runtime states.
      invoke<OutputConfig[]>("outputs_list").then(setOutputs).catch((e) => signalOperatorWarning(`Failed to load outputs: ${e}`));
      invoke<OutputState[]>("outputs_states").then((states) => {
        states.forEach((s) => setOutputState(s));
      }).catch((e) => signalOperatorWarning(`Failed to load output states: ${e}`));

      // License — hydrate before the operator shell is revealed so the first
      // frame is either the gated activation screen or an active license.
      invoke<LicenseInfo>("license_status").then(setLicense).catch((e) => signalOperatorWarning(`License status unavailable: ${e}`));

      // Bible FTS search index may still be building off-thread on a fresh
      // install; search degrades to LIKE until it reports ready.
      invoke<boolean>("bible_fts_status")
        .then((ready) => setBibleIndexing(!ready))
        .catch((e) => signalOperatorWarning(`Bible index status unavailable: ${e}`));

      setIsInitialized(true);
    };

    const unlistenStaged = listen("item-staged", (ev: any) => applyOrBuffer(() => setStagedItem(ev.payload as DisplayItem)));
    const unlistenLive = listen<{ detected_item: DisplayItem | null }>("live-item-update", (ev) => {
      // Propagate null clears too — ignoring null leaves stale live state
      // after a clear operation.
      applyOrBuffer(() => setLiveItem(ev.payload.detected_item ?? null));
    });
    const unlistenSettings = listen("settings-changed", (ev: any) => applyOrBuffer(() => setSettings(ev.payload as PresentationSettings)));
    const unlistenProps = listen<PropItem[]>("props-update", (ev) => {
      // The main window now mirrors the authoritative props layer like the
      // output/stage windows do, so a prop change made on the desktop is
      // reflected everywhere.
      applyOrBuffer(() => setPropItems(Array.isArray(ev.payload) ? ev.payload : []));
    });
    const unlistenLtUpdate = listen("lower-third-update", (ev: any) => {
      const payload = ev.payload;
      applyOrBuffer(() => {
        if (payload) {
          setCurrentLowerThird(payload);
          setLtVisible(true);
        } else {
          setCurrentLowerThird(null);
          setLtVisible(false);
        }
      });
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
    const unlistenSongsSync = listen<Song[]>("songs-sync", (ev) => { setSongs(ev.payload); });
    const unlistenStudioSync = listen<any[] | null>("studio-sync", (ev) => {
      if (!ev?.payload) return;
      setStudioList(ev.payload);
    });
    const unlistenStudioSlidesSync = listen<{ id: string; slides: any[] } | null>("studio-slides-sync", (ev) => {
      // P6: null/empty update events must not leave stale state or throw.
      if (!ev?.payload) return;
      const { id, slides } = ev.payload;
      if (!id) return;
      setStudioSlides({ ...useAppStore.getState().studioSlides, [id]: slides ?? [] });
    });
    const unlistenLog = listen<any>("system-log", (ev) => {
      const entry = ev.payload;
      addLog(entry);
      if (entry?.level === "warn" || entry?.level === "error") {
        setBackendError(entry.message ?? "Backend warning");
      }
    });
    // P0.3 — Warnings signalled from other windows (output/stage).
    const unlistenOpWarn = listen<{ message: string; level?: string }>("operator-warning", (ev) => {
      addLog({ level: ev.payload.level ?? "warn", message: ev.payload.message, timestamp: Date.now() });
      setBackendError(ev.payload.message);
    });
    // Remote device connect/disconnect/revoke notifications.
    const unlistenRemoteDeviceEvent = listen<{ event: string; device_name: string }>("remote-device-event", (ev) => {
      const { event, device_name } = ev.payload ?? {};
      if (!event || !device_name) return;
      const msg =
        event === "connected"
          ? `${device_name} connected to Remote Control`
          : event === "disconnected"
            ? `${device_name} disconnected`
            : event === "revoked"
              ? `${device_name} revoked`
              : event === "auto_revoked"
                ? `${device_name} auto-revoked (idle)`
                : "";
      if (msg) setToast(msg);
    });

    // P4.8 — Async media probes (thumbnail/duration) complete in the
    // background; merge the updated item so the library card refreshes live.
    const unlistenMediaProbed = listen<MediaItem>("media-probed", (ev) => { upsertMediaItem(ev.payload); });
    const unlistenMediaUpdated = listen<MediaItem>("media-updated", (ev) => { upsertMediaItem(ev.payload); });

    // Output manager — authoritative config list + per-output runtime state.
    const unlistenOutputConfig = listen<OutputConfig[]>("output-config-changed", (ev) => {
      setOutputs(ev.payload);
    });
    const unlistenOutputState = listen<OutputState>("output-state-changed", (ev) => {
      setOutputState(ev.payload);
    });

    // License — activation/refresh/deactivation broadcast the authoritative
    // snapshot so the gate and the Settings section stay in sync.
    const unlistenLicense = listen<LicenseInfo>("license-updated", (ev) => {
      setLicense(ev.payload);
    });

    // Bible FTS search index status (off-thread rebuild on fresh installs).
    const unlistenBibleIndex = listen<{ state: string }>("search-index-status", (ev) => {
      setBibleIndexing(ev.payload?.state === "indexing");
    });

    // All listeners are registered above; kick off hydration only now that the
    // event stream is fully covered (audit #2).
    loadAll();

    return () => {
      unlistenStaged.then(f => f());
      unlistenLive.then(f => f());
      unlistenSettings.then(f => f());
      unlistenProps.then(f => f());
      unlistenLtUpdate.then(f => f());
      unlistenLtSync.then(f => f());
      unlistenSongsSync.then(f => f());
      unlistenStudioSync.then(f => f());
      unlistenStudioSlidesSync.then(f => f());
      unlistenLog.then(f => f());
      unlistenOpWarn.then(f => f());
      unlistenRemoteDeviceEvent.then(f => f());
      unlistenMediaProbed.then(f => f());
      unlistenMediaUpdated.then(f => f());
      unlistenOutputConfig.then(f => f());
      unlistenOutputState.then(f => f());
      unlistenLicense.then(f => f());
      unlistenBibleIndex.then(f => f());
    };
  }, []);

  useEffect(() => {
    const label = getCurrentWindow().label;
    if (label === "main") {
      invoke("set_bible_version", { version: useAppStore.getState().bibleVersion })
        .catch((e) => signalOperatorWarning(`Failed to apply Bible version: ${e}`));
    }
  }, [useAppStore.getState().bibleVersion]);
}
