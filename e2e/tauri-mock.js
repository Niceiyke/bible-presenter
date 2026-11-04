(() => {
  try { localStorage.setItem("wordlyte_onboarding_v1", "done"); } catch {}
  const verse = {
    type: "Verse",
    data: { book: "John", chapter: 3, verse: 16, version: "KJV", text: "For God so loved the world." },
  };
  const entry = { id: "service-john-3-16", item: verse };
  const state = {
    staged: null,
    live: null,
    schedule: [entry],
    failNextSend: false,
    calls: [],
  };
  window.__WORDLYTE_E2E__ = state;

  let callbackId = 1;
  const callbacks = new Map();
  const okLicense = {
    status: "active", tier: "premium", license_key: "WORD…E2E0",
    machine_id_hash: "e2e", max_machines: 50, machines_used: 1,
    offline: false, message: "Active",
  };

  async function invoke(cmd, args = {}) {
    state.calls.push({ cmd, args });
    if (cmd.startsWith("plugin:event|")) return cmd.endsWith("listen") ? callbackId++ : null;
    if (cmd.startsWith("plugin:")) return null;
    switch (cmd) {
      case "get_startup_status": return { issues: [] };
      case "get_bible_versions": return ["KJV"];
      case "get_books":
      case "get_chapters":
      case "get_verses_count":
      case "get_chapter":
      case "list_phone_cameras": return [];
      case "list_media":
      case "list_studio_presentations":
      case "list_songs":
      case "get_hymn_library":
      case "load_lt_templates":
      case "get_props":
      case "list_scenes":
      case "outputs_list":
      case "outputs_states": return [];
      case "load_schedule": return { id: "default", name: "Sunday Service", items: state.schedule };
      case "list_services": return [{ id: "default", name: "Sunday Service", item_count: state.schedule.length, updated_at: Date.now() }];
      case "get_app_data_dir": return "C:\\WordlyteE2E";
      case "presentation_snapshot": return { live: state.live, staged: state.staged, settings: null, props: [], lower_third: null };
      case "get_settings": return null;
      case "license_status": return okLicense;
      case "bible_fts_status": return true;
      case "load_workspace": return null;
      case "set_bible_version":
      case "save_workspace":
      case "save_recovery":
      case "save_service":
      case "save_schedule": return null;
      case "get_next_verse": return null;
      case "split_verse": return [args.verse];
      case "stage_item": state.staged = args.item; return null;
      case "commit_staged": state.live = state.staged; state.staged = null; return state.live;
      case "send_live_item":
        if (state.failNextSend) { state.failNextSend = false; throw new Error("simulated output failure"); }
        state.staged = args.item; state.live = args.item; return state.live;
      case "clear_live": state.live = null; return null;
      case "clear_staged": state.staged = null; return null;
      case "clear_all": state.live = null; state.staged = null; return null;
      case "system_info": return {
        cpu_model: "E2E CPU", physical_cores: 8, total_ram_mb: 16384,
        total_disk_mb: 512000, ffmpeg_available: true, h264_encoder: "h264_mf",
        windows_graphics_capture_supported: true, windows_graphics_capture_reason: "Available",
      };
      case "system_metrics": return { cpu_usage_percent: 5, used_ram_percent: 10, used_disk_percent: 20, active_rtmp_sessions: 0 };
      case "audio_devices": return [];
      case "ndi_status": return { supported: false, reason: "Not installed in E2E" };
      case "get_available_monitors": return [{ name: "E2E Display", is_primary: true, width: 1920, height: 1080, x: 0, y: 0 }];
      default: return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke,
    transformCallback(callback, once = false) {
      const id = callbackId++;
      callbacks.set(id, (...args) => {
        callback?.(...args);
        if (once) callbacks.delete(id);
      });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(path) { return `file:///${String(path).replaceAll("\\", "/")}`; },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };
})();
