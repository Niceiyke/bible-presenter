import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MediaItemType = "Image" | "Video";

export interface Verse {
  id: number;
  book: string;
  chapter: number;
  verse: number;
  text: string;
}

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  media_type: MediaItemType;
  thumbnail_path?: string;
}

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem };

/** A schedule entry with a stable ID so React can use it as a key. */
export interface ScheduleEntry {
  id: string;
  item: DisplayItem;
}

export interface Schedule {
  id: string;
  name: string;
  items: ScheduleEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stableId(): string {
  return crypto.randomUUID();
}

function displayItemLabel(item: DisplayItem): string {
  if (item.type === "Verse") {
    return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
  }
  return item.data.name;
}

// ─── Output Window ────────────────────────────────────────────────────────────

function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);

  useEffect(() => {
    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      if (event.payload.detected_item) {
        setLiveItem(event.payload.detected_item);
      }
    });

    return () => { unlisten.then((f) => f()); };
  }, []);

  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center text-white overflow-hidden">
      {liveItem ? (
        <div className="w-full h-full flex flex-col items-center justify-center p-12 animate-in fade-in duration-700">
          {liveItem.type === "Verse" ? (
            <div className="text-center max-w-5xl">
              <h1 className="text-7xl font-serif mb-8 leading-tight drop-shadow-2xl">
                {liveItem.data.text}
              </h1>
              <p className="text-4xl text-amber-500 uppercase tracking-widest font-bold">
                {liveItem.data.book} {liveItem.data.chapter}:{liveItem.data.verse}
              </p>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              {liveItem.data.media_type === "Image" ? (
                <img
                  src={convertFileSrc(liveItem.data.path)}
                  className="max-w-full max-h-full object-contain"
                  alt={liveItem.data.name}
                />
              ) : (
                <video
                  src={convertFileSrc(liveItem.data.path)}
                  className="max-w-full max-h-full object-contain"
                  autoPlay
                  loop
                  muted
                />
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-zinc-800 font-serif text-2xl italic select-none">
          Waiting for projection...
        </div>
      )}
    </div>
  );
}

// ─── Preview Card ─────────────────────────────────────────────────────────────

function PreviewCard({
  item,
  label,
  accent,
  badge,
  empty,
}: {
  item: DisplayItem | null;
  label: string;
  accent: string;
  badge: React.ReactNode;
  empty: string;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3 shrink-0">
        <h2 className={`text-xs font-bold uppercase tracking-widest ${accent}`}>{label}</h2>
        {badge}
      </div>
      <div className="flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 p-6 text-center min-h-0">
        {item ? (
          <div className="animate-in fade-in zoom-in-95 duration-300 w-full h-full flex flex-col items-center justify-center gap-3">
            {item.type === "Verse" ? (
              <>
                <p className="text-xl font-serif text-slate-300 leading-snug line-clamp-5">
                  {item.data.text}
                </p>
                <p className="text-amber-500 font-bold uppercase tracking-widest text-sm shrink-0">
                  {item.data.book} {item.data.chapter}:{item.data.verse}
                </p>
              </>
            ) : (
              <>
                {item.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(item.data.path)}
                    className="max-w-full max-h-32 object-contain rounded shadow-xl"
                    alt={item.data.name}
                  />
                ) : (
                  <video
                    src={convertFileSrc(item.data.path)}
                    className="max-w-full max-h-32 object-contain rounded"
                    muted
                    preload="metadata"
                  />
                )}
                <p className="text-slate-400 text-xs font-bold uppercase truncate max-w-full">
                  {item.data.name}
                </p>
              </>
            )}
          </div>
        ) : (
          <p className="text-slate-800 font-serif italic text-sm">{empty}</p>
        )}
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-full shadow-xl border border-slate-600">
        {message}
      </div>
    </div>
  );
}

// ─── Main Operator Window ─────────────────────────────────────────────────────

export default function App() {
  const [label, setLabel] = useState("");

  // Presentation state
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  // Auto-detected from transcription — never directly overwrites live output
  const [suggestedItem, setSuggestedItem] = useState<DisplayItem | null>(null);

  // UI
  const [activeTab, setActiveTab] = useState<"bible" | "media" | "schedule">("bible");
  const [toast, setToast] = useState<string | null>(null);

  // Schedule — uses ScheduleEntry with stable IDs
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const scheduleRef = useRef<ScheduleEntry[]>([]);
  const [activeScheduleIdx, setActiveScheduleIdx] = useState<number | null>(null);

  // Media
  const [media, setMedia] = useState<MediaItem[]>([]);

  // Session / audio
  const [transcript, setTranscript] = useState("");
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [vadThreshold, setVadThreshold] = useState(0.005);
  const [sessionState, setSessionState] = useState<"idle" | "loading" | "running">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Manual bible picker
  const [books, setBooks] = useState<string[]>([]);
  const [chapters, setChapters] = useState<number[]>([]);
  const [verses, setVerses] = useState<number[]>([]);
  const [selectedBook, setSelectedBook] = useState("");
  const [selectedChapter, setSelectedChapter] = useState(0);
  const [selectedVerse, setSelectedVerse] = useState(0);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Verse[]>([]);

  // Keep ref in sync for event handlers that close over stale state
  scheduleRef.current = scheduleEntries;

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const loadAudioDevices = () => {
    setDeviceError(null);
    invoke("get_audio_devices")
      .then((devs: any) => {
        setDevices(devs);
        if (devs.length > 0) setSelectedDevice((prev) => prev || devs[0][0]);
        else setDeviceError("No input devices found");
      })
      .catch((err: any) => setDeviceError(String(err)));
  };

  const loadMedia = useCallback(async () => {
    try {
      const result: MediaItem[] = await invoke("list_media");
      setMedia(result);
    } catch (err) {
      console.error("Failed to load media:", err);
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    try {
      const result: Schedule = await invoke("load_schedule");
      // Assign stable IDs if loading from backend (which already has them via ScheduleEntry)
      const entries: ScheduleEntry[] = result.items.map((e: any) => ({
        id: e.id || stableId(),
        item: e.item ?? e, // handle both ScheduleEntry shape and raw DisplayItem
      }));
      setScheduleEntries(entries);
    } catch (err) {
      console.error("Failed to load schedule:", err);
    }
  }, []);

  // ── Initialisation ──────────────────────────────────────────────────────────

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") return; // output window rendered separately

    loadAudioDevices();
    loadMedia();
    loadSchedule();

    invoke("get_books")
      .then((b: any) => {
        setBooks(b);
        if (b.length > 0) setSelectedBook(b[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load books: ${err}`));

    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      const { text, detected_item, source } = event.payload;
      setTranscript(text);
      if (detected_item) {
        if (source === "manual") {
          // Operator explicitly pushed an item live
          setLiveItem(detected_item);
        } else {
          // Auto-transcription suggestion — show as hint, not override
          setSuggestedItem(detected_item);
        }
      }
    });

    const unlistenStaged = listen("item-staged", (event: any) => {
      setStagedItem(event.payload as DisplayItem);
    });

    const unlistenStatus = listen("session-status", (event: any) => {
      const { status } = event.payload as { status: string; message: string };
      if (status === "running") setSessionState("running");
      else if (status === "loading") setSessionState("loading");
      else setSessionState("idle");
    });

    const unlistenAudioErr = listen("audio-error", (event: any) => {
      setAudioError(String(event.payload));
      setSessionState("idle");
    });

    return () => {
      unlisten.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenAudioErr.then((f) => f());
    };
  }, []);

  // ── Bible picker cascades ────────────────────────────────────────────────────

  useEffect(() => {
    if (!selectedBook) return;
    invoke("get_chapters", { book: selectedBook })
      .then((c: any) => {
        setChapters(c);
        if (c.length > 0) setSelectedChapter(c[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load chapters: ${err}`));
  }, [selectedBook]);

  useEffect(() => {
    if (!selectedBook || !selectedChapter) return;
    invoke("get_verses_count", { book: selectedBook, chapter: selectedChapter })
      .then((v: any) => {
        setVerses(v);
        if (v.length > 0) setSelectedVerse(v[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load verses: ${err}`));
  }, [selectedBook, selectedChapter]);

  // ── Presentation actions ─────────────────────────────────────────────────────

  const stageItem = async (item: DisplayItem) => {
    setStagedItem(item);
    await invoke("stage_item", { item });
  };

  const goLive = async () => {
    await invoke("go_live");
    // Backend emits transcription-update with source:"manual" → setLiveItem above
  };

  /** Stage and immediately send live — single-click workflow. */
  const sendLive = async (item: DisplayItem) => {
    await stageItem(item);
    // Slight delay so backend state is set before go_live reads it
    await new Promise((r) => setTimeout(r, 50));
    await goLive();
  };

  const stageSuggested = () => {
    if (suggestedItem) {
      stageItem(suggestedItem);
      setSuggestedItem(null);
    }
  };

  // ── Manual picker ────────────────────────────────────────────────────────────

  const handleDisplaySelection = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
      });
      if (verse) {
        await stageItem({ type: "Verse", data: verse });
      } else {
        setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
      }
    } catch (err: any) {
      setAudioError(String(err));
    }
  };

  const handleSendLivePicker = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
      });
      if (verse) await sendLive({ type: "Verse", data: verse });
      else setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
    } catch (err: any) {
      setAudioError(String(err));
    }
  };

  // ── Search ──────────────────────────────────────────────────────────────────

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const results: any = await invoke("search_manual", { query: searchQuery });
      setSearchResults(results);
    } catch (err) {
      console.error("Search failed:", err);
    }
  };

  // ── Media ───────────────────────────────────────────────────────────────────

  const handleFileUpload = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
          { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
        ],
      });
      if (!selected) return; // user cancelled
      const path = typeof selected === "string" ? selected : selected;
      await invoke("add_media", { path });
      await loadMedia();
      setToast("Media added to library");
    } catch (err: any) {
      setAudioError(`Upload failed: ${err}`);
    }
  };

  const handleDeleteMedia = async (id: string) => {
    try {
      await invoke("delete_media", { id });
      setMedia((prev) => prev.filter((m) => m.id !== id));
    } catch (err: any) {
      setAudioError(`Delete failed: ${err}`);
    }
  };

  // ── Schedule ─────────────────────────────────────────────────────────────────

  const persistSchedule = async (entries: ScheduleEntry[]) => {
    try {
      const schedule: Schedule = { id: "default", name: "Default Schedule", items: entries };
      await invoke("save_schedule", { schedule });
    } catch (err) {
      console.error("Failed to save schedule:", err);
    }
  };

  const addToSchedule = async (item: DisplayItem) => {
    const entry: ScheduleEntry = { id: stableId(), item };
    const next = [...scheduleRef.current, entry];
    setScheduleEntries(next);
    await persistSchedule(next);
    setToast(`Added to schedule: ${displayItemLabel(item)}`);
  };

  const removeFromSchedule = async (id: string) => {
    const next = scheduleRef.current.filter((e) => e.id !== id);
    setScheduleEntries(next);
    setActiveScheduleIdx((prev) => {
      if (prev === null) return null;
      const newLen = next.length;
      return prev >= newLen ? (newLen > 0 ? newLen - 1 : null) : prev;
    });
    await persistSchedule(next);
  };

  const handleScheduleItemSend = async (entry: ScheduleEntry, idx: number) => {
    setActiveScheduleIdx(idx);
    await sendLive(entry.item);
  };

  const handleNextScheduleItem = async () => {
    const entries = scheduleRef.current;
    if (entries.length === 0) return;
    const nextIdx = activeScheduleIdx === null ? 0 : Math.min(activeScheduleIdx + 1, entries.length - 1);
    setActiveScheduleIdx(nextIdx);
    await sendLive(entries[nextIdx].item);
  };

  const handlePrevScheduleItem = async () => {
    const entries = scheduleRef.current;
    if (entries.length === 0) return;
    const prevIdx = activeScheduleIdx === null ? 0 : Math.max(activeScheduleIdx - 1, 0);
    setActiveScheduleIdx(prevIdx);
    await sendLive(entries[prevIdx].item);
  };

  // ── Audio controls ───────────────────────────────────────────────────────────

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const device = e.target.value;
    setSelectedDevice(device);
    invoke("set_audio_device", { deviceName: device });
  };

  const updateVad = (val: string) => {
    const threshold = parseFloat(val);
    setVadThreshold(threshold);
    invoke("set_vad_threshold", { threshold });
  };

  // ── Output window short-circuit ──────────────────────────────────────────────

  if (label === "output") return <OutputWindow />;

  // ── Operator UI ──────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-900/50 shrink-0">
        <h1 className="text-xl font-bold tracking-tight text-white">
          BIBLE PRESENTER{" "}
          <span className="text-xs bg-amber-500 text-black px-2 py-0.5 rounded ml-2">PRO</span>
        </h1>

        <div className="flex items-center gap-3">
          {/* VAD Sensitivity */}
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase font-bold mb-1">Sensitivity</span>
            <input
              type="range"
              min="0.0001"
              max="0.05"
              step="0.0005"
              value={vadThreshold}
              onChange={(e) => updateVad(e.target.value)}
              className="w-28 accent-amber-500"
            />
          </div>

          {/* Microphone selector */}
          <div className="flex items-center gap-1">
            {deviceError ? (
              <span className="text-red-400 text-xs max-w-[140px] truncate" title={deviceError}>
                No mic found
              </span>
            ) : (
              <select
                value={selectedDevice}
                onChange={handleDeviceChange}
                className="bg-slate-800 text-white border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                {devices.length === 0 && <option value="">Loading...</option>}
                {devices.map(([name, id]) => (
                  <option key={id} value={name}>{name}</option>
                ))}
              </select>
            )}
            <button
              onClick={loadAudioDevices}
              title="Refresh microphone list"
              className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-2 py-2 text-xs text-slate-400 hover:text-white transition-all"
            >
              ↺
            </button>
          </div>

          <button
            onClick={() => invoke("toggle_output_window")}
            className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-2 px-4 rounded border border-slate-700 transition-all text-sm"
          >
            TOGGLE OUTPUT
          </button>

          <button
            onClick={() => {
              if (sessionState === "running") {
                invoke("stop_session");
              } else {
                setAudioError(null);
                invoke("start_session").catch((err: any) => {
                  setAudioError(String(err));
                  setSessionState("idle");
                });
              }
            }}
            disabled={sessionState === "loading"}
            className={`font-bold py-2 px-6 rounded-full transition-all disabled:opacity-50 ${
              sessionState === "running"
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-amber-500 hover:bg-amber-600 text-black"
            }`}
          >
            {sessionState === "loading"
              ? "LOADING..."
              : sessionState === "running"
              ? "STOP"
              : "START LIVE"}
          </button>
        </div>
      </header>

      {/* Audio error banner */}
      {audioError && (
        <div className="bg-red-950 border-b border-red-800 text-red-300 text-xs px-6 py-2 flex items-center gap-2 shrink-0">
          <span className="font-bold text-red-400 uppercase tracking-widest">Error</span>
          <span className="flex-1">{audioError}</span>
          <button
            onClick={() => setAudioError(null)}
            className="text-red-500 hover:text-red-200 font-bold transition-all"
          >
            ✕
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Left Sidebar ── */}
        <aside className="w-80 bg-slate-900/30 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
          {/* Tab nav */}
          <div className="flex border-b border-slate-800 bg-slate-900/50 shrink-0">
            {(["bible", "media", "schedule"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-widest transition-all relative ${
                  activeTab === tab
                    ? "bg-slate-800 text-amber-500 border-b-2 border-amber-500"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                {tab}
                {tab === "schedule" && scheduleEntries.length > 0 && (
                  <span className="ml-1 text-[8px] bg-amber-500 text-black rounded-full px-1 font-black">
                    {scheduleEntries.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">

            {/* ── Bible Tab ── */}
            {activeTab === "bible" && (
              <>
                <div>
                  <h2 className="text-xs font-bold text-slate-500 uppercase mb-3 tracking-widest">
                    Manual Selection
                  </h2>
                  <div className="flex flex-col gap-2">
                    <select
                      value={selectedBook}
                      onChange={(e) => setSelectedBook(e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <option value="">Select Book</option>
                      {books.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={selectedChapter}
                        onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {chapters.map((c) => (
                          <option key={c} value={c}>Chap {c}</option>
                        ))}
                      </select>
                      <select
                        value={selectedVerse}
                        onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {verses.map((v) => (
                          <option key={v} value={v}>Verse {v}</option>
                        ))}
                      </select>
                    </div>

                    {/* Action row */}
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={handleDisplaySelection}
                        disabled={!selectedBook}
                        title="Stage for preview"
                        className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        STAGE
                      </button>
                      <button
                        onClick={handleSendLivePicker}
                        disabled={!selectedBook}
                        title="Send directly to output screen"
                        className="bg-amber-500 hover:bg-amber-400 text-black font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        DISPLAY
                      </button>
                      <button
                        onClick={async () => {
                          if (!selectedBook) return;
                          const v: any = await invoke("get_verse", {
                            book: selectedBook,
                            chapter: selectedChapter,
                            verse: selectedVerse,
                          });
                          if (v) addToSchedule({ type: "Verse", data: v });
                        }}
                        disabled={!selectedBook}
                        title="Add to schedule queue"
                        className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        + QUEUE
                      </button>
                    </div>
                  </div>
                </div>

                <hr className="border-slate-800" />

                {/* Keyword Search */}
                <div className="flex flex-col min-h-0">
                  <h2 className="text-xs font-bold text-slate-500 uppercase mb-3 tracking-widest">
                    Keyword Search
                  </h2>
                  <form onSubmit={handleSearch} className="mb-3 flex gap-2">
                    <input
                      type="text"
                      placeholder="Search scripture..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <button
                      type="submit"
                      className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all"
                    >
                      Go
                    </button>
                  </form>

                  <div className="space-y-2 overflow-y-auto">
                    {searchResults.length === 0 && searchQuery && (
                      <p className="text-slate-600 text-xs italic text-center pt-4">No results found</p>
                    )}
                    {searchResults.map((v, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-lg bg-slate-800/50 border border-transparent hover:border-slate-700 transition-all group"
                      >
                        <p className="text-amber-500 text-xs font-bold mb-1 uppercase">
                          {v.book} {v.chapter}:{v.verse}
                        </p>
                        <p className="text-slate-300 text-xs mb-2 line-clamp-2">{v.text}</p>
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={() => stageItem({ type: "Verse", data: v })}
                            className="flex-1 bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded transition-all"
                          >
                            STAGE
                          </button>
                          <button
                            onClick={() => sendLive({ type: "Verse", data: v })}
                            className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded transition-all"
                          >
                            DISPLAY
                          </button>
                          <button
                            onClick={() => addToSchedule({ type: "Verse", data: v })}
                            className="px-2 bg-slate-700 hover:bg-slate-600 text-amber-500 text-[10px] font-bold py-1 rounded transition-all"
                            title="Add to schedule"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── Media Tab ── */}
            {activeTab === "media" && (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                    Media Library
                  </h2>
                  <button
                    onClick={handleFileUpload}
                    className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all"
                  >
                    + UPLOAD
                  </button>
                </div>

                {media.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">
                    No media files. Click + UPLOAD to add images or videos.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {media.map((item) => (
                      <div
                        key={item.id}
                        className="group relative aspect-video bg-slate-800 rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all"
                      >
                        {item.media_type === "Image" ? (
                          <img
                            src={convertFileSrc(item.path)}
                            className="w-full h-full object-cover"
                            alt={item.name}
                          />
                        ) : (
                          <video
                            src={convertFileSrc(item.path)}
                            className="w-full h-full object-cover"
                            muted
                            preload="metadata"
                          />
                        )}

                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1.5 p-2">
                          <button
                            onClick={() => stageItem({ type: "Media", data: item })}
                            className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded"
                          >
                            STAGE
                          </button>
                          <button
                            onClick={() => sendLive({ type: "Media", data: item })}
                            className="w-full bg-white hover:bg-slate-200 text-black text-[10px] font-bold py-1 rounded"
                          >
                            DISPLAY
                          </button>
                          <button
                            onClick={() => addToSchedule({ type: "Media", data: item })}
                            className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded"
                          >
                            + QUEUE
                          </button>
                          <button
                            onClick={() => handleDeleteMedia(item.id)}
                            className="w-full bg-red-900/60 hover:bg-red-900 text-red-300 text-[10px] font-bold py-1 rounded"
                          >
                            DELETE
                          </button>
                        </div>

                        {/* Name bar */}
                        <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 backdrop-blur-sm">
                          <p className="text-[8px] text-white truncate text-center">{item.name}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Schedule Tab ── */}
            {activeTab === "schedule" && (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                    Live Schedule
                  </h2>
                  {scheduleEntries.length > 0 && (
                    <div className="flex gap-1">
                      <button
                        onClick={handlePrevScheduleItem}
                        disabled={activeScheduleIdx === 0 || scheduleEntries.length === 0}
                        title="Previous item"
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
                      >
                        ← Prev
                      </button>
                      <button
                        onClick={handleNextScheduleItem}
                        disabled={
                          scheduleEntries.length === 0 ||
                          activeScheduleIdx === scheduleEntries.length - 1
                        }
                        title="Next item"
                        className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded disabled:opacity-30 transition-all"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>

                {scheduleEntries.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">
                    Schedule is empty. Add verses or media with + QUEUE.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {scheduleEntries.map((entry, idx) => {
                      const isActive = activeScheduleIdx === idx;
                      return (
                        <div
                          key={entry.id}
                          className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all group ${
                            isActive
                              ? "bg-amber-500/10 border-amber-500/40"
                              : "bg-slate-800/40 border-slate-700/40 hover:bg-slate-800 hover:border-slate-700"
                          }`}
                        >
                          <div
                            className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-black shrink-0 ${
                              isActive
                                ? "bg-amber-500 text-black"
                                : "bg-slate-700 text-slate-400"
                            }`}
                          >
                            {idx + 1}
                          </div>

                          <div className="flex-1 min-w-0">
                            {entry.item.type === "Verse" ? (
                              <>
                                <p className="text-amber-500 text-[10px] font-bold uppercase truncate">
                                  {entry.item.data.book} {entry.item.data.chapter}:{entry.item.data.verse}
                                </p>
                                <p className="text-slate-400 text-[10px] truncate">{entry.item.data.text}</p>
                              </>
                            ) : (
                              <>
                                <p className="text-blue-400 text-[10px] font-bold uppercase truncate">
                                  {entry.item.data.media_type}: {entry.item.data.name}
                                </p>
                              </>
                            )}
                          </div>

                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            <button
                              onClick={() => handleScheduleItemSend(entry, idx)}
                              title="Send live"
                              className="p-1 bg-amber-500 hover:bg-amber-400 text-black rounded text-[10px] font-bold"
                            >
                              ▶
                            </button>
                            <button
                              onClick={() => removeFromSchedule(entry.id)}
                              title="Remove from schedule"
                              className="p-1 bg-red-900/50 text-red-400 rounded hover:bg-red-900 hover:text-white"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="flex-1 grid grid-rows-[1fr_2fr] gap-px bg-slate-800 overflow-hidden">

          {/* Live Transcription + Suggested Verse */}
          <section className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-3">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest shrink-0">
              Live Transcription
            </h2>
            <div className="flex-1 overflow-y-auto text-xl font-light leading-snug text-slate-400 min-h-0">
              {transcript || (
                <span className="text-slate-800 italic">Listening for audio feed...</span>
              )}
            </div>

            {/* Auto-detected suggestion */}
            {suggestedItem && (
              <div className="shrink-0 flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-0.5">
                    Auto-detected
                  </p>
                  {suggestedItem.type === "Verse" ? (
                    <p className="text-slate-300 text-sm truncate">
                      <span className="text-amber-500 font-bold">
                        {suggestedItem.data.book} {suggestedItem.data.chapter}:{suggestedItem.data.verse}
                      </span>
                      {" — "}
                      <span className="text-slate-400">{suggestedItem.data.text}</span>
                    </p>
                  ) : (
                    <p className="text-slate-300 text-sm truncate">{suggestedItem.data.name}</p>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={stageSuggested}
                    className="text-[10px] font-bold px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded transition-all"
                  >
                    STAGE
                  </button>
                  <button
                    onClick={() => { if (suggestedItem) sendLive(suggestedItem); setSuggestedItem(null); }}
                    className="text-[10px] font-bold px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded transition-all"
                  >
                    DISPLAY
                  </button>
                  <button
                    onClick={() => setSuggestedItem(null)}
                    className="text-[10px] text-slate-500 hover:text-slate-300 px-1 transition-all"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Dual Preview Area */}
          <section className="bg-slate-900 grid grid-cols-2 gap-px overflow-hidden relative">

            {/* Stage Preview (Next) */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden">
              <PreviewCard
                item={stagedItem}
                label="Stage Preview"
                accent="text-amber-500/50"
                badge={
                  <span className="text-[10px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">
                    NEXT
                  </span>
                }
                empty="Stage is empty — select a verse or media above"
              />
            </div>

            {/* GO LIVE button centred between the two panels */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
              <button
                onClick={goLive}
                disabled={!stagedItem}
                className="group relative w-20 h-20 bg-amber-500 hover:bg-amber-400 text-black rounded-full shadow-[0_0_30px_rgba(245,158,11,0.25)] flex flex-col items-center justify-center transition-all active:scale-95 disabled:grayscale disabled:opacity-40"
              >
                <span className="text-xl font-black">GO</span>
                <span className="text-[10px] font-bold">LIVE</span>
                {stagedItem && (
                  <div className="absolute inset-0 rounded-full animate-ping bg-amber-500 opacity-20 pointer-events-none" />
                )}
              </button>
            </div>

            {/* Live Output (Current) */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden">
              <PreviewCard
                item={liveItem}
                label="Live Output"
                accent="text-red-500/50"
                badge={
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[10px] bg-red-500/10 text-red-500 px-2 py-0.5 rounded border border-red-500/20 uppercase font-bold">
                      On Air
                    </span>
                  </div>
                }
                empty="Output is empty"
              />
            </div>
          </section>
        </main>
      </div>

      {/* Toast notification */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
