import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { loadPptxZip, parseSingleSlide, getSlideCount } from "./pptxParser";
import type { ParsedSlide } from "./pptxParser";

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

export interface PresentationFile {
  id: string;
  name: string;
  path: string;
  slide_count: number;
}

export interface PresentationSlideData {
  presentation_id: string;
  presentation_name: string;
  presentation_path: string;
  slide_index: number;
  slide_count: number;
}

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem }
  | { type: "PresentationSlide"; data: PresentationSlideData };

export interface ScheduleEntry {
  id: string;
  item: DisplayItem;
}

export interface Schedule {
  id: string;
  name: string;
  items: ScheduleEntry[];
}

// Background is a serde-tagged enum: { type: "None" } | { type: "Color"; value: string } | { type: "Image"; value: string }
export type BackgroundSetting =
  | { type: "None" }
  | { type: "Color"; value: string }
  | { type: "Image"; value: string };

export interface PresentationSettings {
  theme: string;
  reference_position: "top" | "bottom";
  background: BackgroundSetting;
}

// ─── Themes ───────────────────────────────────────────────────────────────────
// Defined as plain objects (not Tailwind classes) to avoid content purging.

export interface ThemeColors {
  background: string;
  verseText: string;
  referenceText: string;
  waitingText: string;
}

export const THEMES: Record<string, { label: string; colors: ThemeColors }> = {
  dark: {
    label: "Classic Dark",
    colors: { background: "#000000", verseText: "#ffffff", referenceText: "#f59e0b", waitingText: "#3f3f46" },
  },
  light: {
    label: "Light",
    colors: { background: "#f8fafc", verseText: "#0f172a", referenceText: "#b45309", waitingText: "#94a3b8" },
  },
  navy: {
    label: "Navy",
    colors: { background: "#0a1628", verseText: "#e2e8f0", referenceText: "#60a5fa", waitingText: "#334155" },
  },
  maroon: {
    label: "Maroon",
    colors: { background: "#1a0505", verseText: "#fef2f2", referenceText: "#f87171", waitingText: "#7f1d1d" },
  },
  forest: {
    label: "Forest",
    colors: { background: "#051a0a", verseText: "#f0fdf4", referenceText: "#4ade80", waitingText: "#14532d" },
  },
  slate: {
    label: "Slate",
    colors: { background: "#1e2a3a", verseText: "#cbd5e1", referenceText: "#94a3b8", waitingText: "#334155" },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stableId(): string {
  return crypto.randomUUID();
}

function displayItemLabel(item: DisplayItem): string {
  if (item.type === "Verse") {
    return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
  }
  if (item.type === "PresentationSlide") {
    return `${item.data.presentation_name} – Slide ${item.data.slide_index + 1}`;
  }
  return item.data.name;
}

/** Computes the background style for the output window, respecting background override. */
function computeOutputBackground(
  settings: PresentationSettings,
  colors: ThemeColors
): React.CSSProperties {
  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const imgPath = settings.background.value;
    if (imgPath) {
      return {
        backgroundImage: `url(${convertFileSrc(imgPath)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  return { backgroundColor: colors.background };
}

/** Computes background style for the settings preview panel. */
function computePreviewBackground(
  settings: PresentationSettings,
  themeColor: string
): React.CSSProperties {
  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const imgPath = settings.background.value;
    if (imgPath) {
      return {
        backgroundImage: `url(${convertFileSrc(imgPath)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  return { backgroundColor: themeColor };
}

// ─── Slide Renderer ───────────────────────────────────────────────────────────
// Renders a ParsedSlide as a full-size div with background, images and text boxes.

function SlideRenderer({ slide }: { slide: ParsedSlide }) {
  const bgStyle: React.CSSProperties = slide.backgroundColor
    ? { backgroundColor: slide.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div className="w-full h-full relative overflow-hidden" style={bgStyle}>
      {slide.images.map((img, i) => (
        <img
          key={i}
          src={img.dataUrl}
          className="absolute inset-0 w-full h-full object-cover"
          alt=""
          style={{ zIndex: i }}
        />
      ))}
      {slide.textBoxes.map((tb, i) => (
        <div
          key={i}
          className="absolute inset-0 flex items-center justify-center p-16"
          style={{ zIndex: slide.images.length + i }}
        >
          <p
            className="text-center leading-tight drop-shadow-2xl whitespace-pre-wrap"
            style={{
              color: tb.color ?? "#ffffff",
              fontSize: tb.fontSize ? `${tb.fontSize}pt` : "3rem",
              fontWeight: tb.bold ? "bold" : "normal",
            }}
          >
            {tb.text}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Slide Thumbnail ──────────────────────────────────────────────────────────

function SlideThumbnail({
  slide,
  index,
  onStage,
  onLive,
}: {
  slide: ParsedSlide;
  index: number;
  onStage: () => void;
  onLive: () => void;
}) {
  const bgStyle: React.CSSProperties = slide.backgroundColor
    ? { backgroundColor: slide.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
      style={bgStyle}
    >
      {slide.images[0] && (
        <img src={slide.images[0].dataUrl} className="absolute inset-0 w-full h-full object-cover" alt="" />
      )}
      {slide.textBoxes[0] && (
        <div className="absolute inset-0 flex items-center justify-center p-1">
          <p
            className="text-center font-bold leading-tight"
            style={{
              fontSize: "8px",
              color: slide.textBoxes[0].color ?? "#ffffff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
            }}
          >
            {slide.textBoxes[0].text.slice(0, 60)}
          </p>
        </div>
      )}
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
        <button
          onClick={onStage}
          className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
        >
          STAGE
        </button>
        <button
          onClick={onLive}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
        >
          DISPLAY
        </button>
      </div>
    </div>
  );
}

// ─── Output Window ────────────────────────────────────────────────────────────

function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
  });
  const [currentSlide, setCurrentSlide] = useState<ParsedSlide | null>(null);
  const outputZipsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      if (event.payload.detected_item) {
        setLiveItem(event.payload.detected_item);
      }
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
    };
  }, []);

  // Parse PPTX slide when a PresentationSlide item goes live
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

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = computeOutputBackground(settings, colors);

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="text-4xl uppercase tracking-widest font-bold shrink-0"
      style={{ color: colors.referenceText }}
    >
      {liveItem.data.book} {liveItem.data.chapter}:{liveItem.data.verse}
    </p>
  ) : null;

  return (
    <div
      className="h-screen w-screen flex items-center justify-center overflow-hidden"
      style={{ ...bgStyle, color: colors.verseText }}
    >
      {liveItem ? (
        <div className="w-full h-full flex flex-col items-center justify-center p-12 animate-in fade-in duration-700">
          {liveItem.type === "Verse" ? (
            <div className="text-center max-w-5xl flex flex-col items-center gap-8">
              {isTop && ReferenceTag}
              <h1
                className="text-7xl font-serif leading-tight drop-shadow-2xl"
                style={{ color: colors.verseText }}
              >
                {liveItem.data.text}
              </h1>
              {!isTop && ReferenceTag}
            </div>
          ) : liveItem.type === "PresentationSlide" ? (
            <div className="w-full h-full">
              {currentSlide ? (
                <SlideRenderer slide={currentSlide} />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="font-serif text-2xl italic" style={{ color: colors.waitingText }}>
                    Loading slide...
                  </span>
                </div>
              )}
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
        <div
          className="font-serif text-2xl italic select-none"
          style={{ color: colors.waitingText }}
        >
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
            ) : item.type === "PresentationSlide" ? (
              <>
                <div className="text-orange-400 text-xs font-black uppercase bg-orange-400/10 px-2 py-0.5 rounded">
                  SLIDE {item.data.slide_index + 1} / {item.data.slide_count || "?"}
                </div>
                <p className="text-slate-400 text-xs font-bold truncate max-w-full">
                  {item.data.presentation_name}
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
  const [suggestedItem, setSuggestedItem] = useState<DisplayItem | null>(null);
  const [nextVerse, setNextVerse] = useState<Verse | null>(null);

  // Settings
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
  });

  // UI
  const [activeTab, setActiveTab] = useState<"bible" | "media" | "presentations" | "schedule" | "settings">("bible");
  const [toast, setToast] = useState<string | null>(null);

  // Schedule
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const scheduleRef = useRef<ScheduleEntry[]>([]);
  const [activeScheduleIdx, setActiveScheduleIdx] = useState<number | null>(null);

  // Media
  const [media, setMedia] = useState<MediaItem[]>([]);

  // Presentations
  const [presentations, setPresentations] = useState<PresentationFile[]>([]);
  const [selectedPresId, setSelectedPresId] = useState<string | null>(null);
  const [loadedSlides, setLoadedSlides] = useState<Record<string, ParsedSlide[]>>({});
  const presZipsRef = useRef<Record<string, any>>({});

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

  const loadPresentations = useCallback(async () => {
    try {
      const result: PresentationFile[] = await invoke("list_presentations");
      setPresentations(result);
    } catch (err) {
      console.error("Failed to load presentations:", err);
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    try {
      const result: Schedule = await invoke("load_schedule");
      const entries: ScheduleEntry[] = result.items.map((e: any) => ({
        id: e.id || stableId(),
        item: e.item ?? e,
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
    if (windowLabel === "output") return;

    loadAudioDevices();
    loadMedia();
    loadPresentations();
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

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      const { text, detected_item, source } = event.payload;
      setTranscript(text);
      if (detected_item) {
        if (source === "manual") {
          setLiveItem(detected_item);
        } else {
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

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    return () => {
      unlisten.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenAudioErr.then((f) => f());
      unlistenSettings.then((f) => f());
    };
  }, []);

  // ── Fetch next verse when liveItem changes to a Verse ─────────────────────

  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const v = liveItem.data;
      invoke("get_next_verse", { book: v.book, chapter: v.chapter, verse: v.verse })
        .then((result: any) => setNextVerse(result ?? null))
        .catch(() => setNextVerse(null));
    } else {
      setNextVerse(null);
    }
  }, [liveItem]);

  // ── Parse PPTX when a presentation is selected ───────────────────────────

  useEffect(() => {
    if (!selectedPresId) return;
    if (loadedSlides[selectedPresId]) return; // already cached

    const pres = presentations.find((p) => p.id === selectedPresId);
    if (!pres) return;

    (async () => {
      try {
        let zip = presZipsRef.current[selectedPresId];
        if (!zip) {
          zip = await loadPptxZip(pres.path);
          presZipsRef.current[selectedPresId] = zip;
        }
        const count = await getSlideCount(zip);
        const slides: ParsedSlide[] = [];
        for (let i = 0; i < count; i++) {
          slides.push(await parseSingleSlide(zip, i));
        }
        setLoadedSlides((prev) => ({ ...prev, [selectedPresId]: slides }));
        // Update slide count on the presentation record
        setPresentations((prev) =>
          prev.map((p) => (p.id === selectedPresId ? { ...p, slide_count: count } : p))
        );
      } catch (err) {
        console.error("Failed to parse PPTX:", err);
        setAudioError(`Failed to parse presentation: ${err}`);
      }
    })();
  }, [selectedPresId, presentations]);

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
  };

  const sendLive = async (item: DisplayItem) => {
    await stageItem(item);
    await new Promise((r) => setTimeout(r, 50));
    await goLive();
  };

  const stageSuggested = () => {
    if (suggestedItem) {
      stageItem(suggestedItem);
      setSuggestedItem(null);
    }
  };

  // ── Settings ─────────────────────────────────────────────────────────────────

  const updateSettings = async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
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
      if (verse) await stageItem({ type: "Verse", data: verse });
      else setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
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
      if (!selected) return;
      await invoke("add_media", { path: selected });
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

  // ── Presentations ────────────────────────────────────────────────────────────

  const handleImportPresentation = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
      });
      if (!selected) return;
      const pres: PresentationFile = await invoke("add_presentation", { path: selected });
      setPresentations((prev) => [...prev, pres]);
      setSelectedPresId(pres.id);
      setToast(`Imported: ${pres.name}`);
    } catch (err: any) {
      setAudioError(`Import failed: ${err}`);
    }
  };

  const handleDeletePresentation = async (id: string) => {
    try {
      await invoke("delete_presentation", { id });
      setPresentations((prev) => prev.filter((p) => p.id !== id));
      setLoadedSlides((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete presZipsRef.current[id];
      if (selectedPresId === id) setSelectedPresId(null);
    } catch (err: any) {
      setAudioError(`Delete failed: ${err}`);
    }
  };

  const stagePresentationSlide = async (pres: PresentationFile, slideIndex: number) => {
    const item: DisplayItem = {
      type: "PresentationSlide",
      data: {
        presentation_id: pres.id,
        presentation_name: pres.name,
        presentation_path: pres.path,
        slide_index: slideIndex,
        slide_count: pres.slide_count,
      },
    };
    await stageItem(item);
  };

  const sendPresentationSlide = async (pres: PresentationFile, slideIndex: number) => {
    const item: DisplayItem = {
      type: "PresentationSlide",
      data: {
        presentation_id: pres.id,
        presentation_name: pres.name,
        presentation_path: pres.path,
        slide_index: slideIndex,
        slide_count: pres.slide_count,
      },
    };
    await sendLive(item);
  };

  // ── Background image picker ──────────────────────────────────────────────────

  const handlePickBackgroundImage = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (!selected) return;
      await updateSettings({ ...settings, background: { type: "Image", value: selected } });
      setToast("Background image set");
    } catch (err: any) {
      setAudioError(`Failed to set background image: ${err}`);
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
    setToast(`Added: ${displayItemLabel(item)}`);
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
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase font-bold mb-1">Sensitivity</span>
            <input
              type="range" min="0.0001" max="0.05" step="0.0005"
              value={vadThreshold}
              onChange={(e) => updateVad(e.target.value)}
              className="w-28 accent-amber-500"
            />
          </div>

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
            {sessionState === "loading" ? "LOADING..." : sessionState === "running" ? "STOP" : "START LIVE"}
          </button>
        </div>
      </header>

      {audioError && (
        <div className="bg-red-950 border-b border-red-800 text-red-300 text-xs px-6 py-2 flex items-center gap-2 shrink-0">
          <span className="font-bold text-red-400 uppercase tracking-widest">Error</span>
          <span className="flex-1">{audioError}</span>
          <button onClick={() => setAudioError(null)} className="text-red-500 hover:text-red-200 font-bold">✕</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">

        {/* ── Left Sidebar ── */}
        <aside className="w-80 bg-slate-900/30 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
          {/* Tab nav */}
          <div className="flex border-b border-slate-800 bg-slate-900/50 shrink-0 overflow-x-auto">
            {(["bible", "media", "presentations", "schedule", "settings"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-[9px] font-bold uppercase tracking-widest transition-all relative whitespace-nowrap px-1 ${
                  activeTab === tab
                    ? "bg-slate-800 text-amber-500 border-b-2 border-amber-500"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                {tab === "settings" ? "⚙" : tab === "presentations" ? "PPTX" : tab}
                {tab === "schedule" && scheduleEntries.length > 0 && (
                  <span className="ml-1 text-[8px] bg-amber-500 text-black rounded-full px-1 font-black">
                    {scheduleEntries.length}
                  </span>
                )}
                {tab === "presentations" && presentations.length > 0 && (
                  <span className="ml-1 text-[8px] bg-orange-500 text-black rounded-full px-1 font-black">
                    {presentations.length}
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
                      {books.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={selectedChapter}
                        onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {chapters.map((c) => <option key={c} value={c}>Chap {c}</option>)}
                      </select>
                      <select
                        value={selectedVerse}
                        onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {verses.map((v) => <option key={v} value={v}>Verse {v}</option>)}
                      </select>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={handleDisplaySelection}
                        disabled={!selectedBook}
                        className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        STAGE
                      </button>
                      <button
                        onClick={handleSendLivePicker}
                        disabled={!selectedBook}
                        className="bg-amber-500 hover:bg-amber-400 text-black font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        DISPLAY
                      </button>
                      <button
                        onClick={async () => {
                          if (!selectedBook) return;
                          const v: any = await invoke("get_verse", {
                            book: selectedBook, chapter: selectedChapter, verse: selectedVerse,
                          });
                          if (v) addToSchedule({ type: "Verse", data: v });
                        }}
                        disabled={!selectedBook}
                        className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        + QUEUE
                      </button>
                    </div>
                  </div>
                </div>

                <hr className="border-slate-800" />

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
                    <button type="submit" className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all">
                      Go
                    </button>
                  </form>

                  <div className="space-y-2 overflow-y-auto">
                    {searchResults.length === 0 && searchQuery && (
                      <p className="text-slate-600 text-xs italic text-center pt-4">No results found</p>
                    )}
                    {searchResults.map((v, i) => (
                      <div key={i} className="p-3 rounded-lg bg-slate-800/50 border border-transparent hover:border-slate-700 transition-all group">
                        <p className="text-amber-500 text-xs font-bold mb-1 uppercase">{v.book} {v.chapter}:{v.verse}</p>
                        <p className="text-slate-300 text-xs mb-2 line-clamp-2">{v.text}</p>
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                          <button onClick={() => stageItem({ type: "Verse", data: v })} className="flex-1 bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded transition-all">STAGE</button>
                          <button onClick={() => sendLive({ type: "Verse", data: v })} className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded transition-all">DISPLAY</button>
                          <button onClick={() => addToSchedule({ type: "Verse", data: v })} className="px-2 bg-slate-700 hover:bg-slate-600 text-amber-500 text-[10px] font-bold py-1 rounded transition-all" title="Add to schedule">+</button>
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
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Media Library</h2>
                  <button onClick={handleFileUpload} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all">
                    + UPLOAD
                  </button>
                </div>

                {media.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">No media files. Click + UPLOAD to add images or videos.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {media.map((item) => (
                      <div key={item.id} className="group relative aspect-video bg-slate-800 rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all">
                        {item.media_type === "Image" ? (
                          <img src={convertFileSrc(item.path)} className="w-full h-full object-cover" alt={item.name} />
                        ) : (
                          <video src={convertFileSrc(item.path)} className="w-full h-full object-cover" muted preload="metadata" />
                        )}
                        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1.5 p-2">
                          <button onClick={() => stageItem({ type: "Media", data: item })} className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded">STAGE</button>
                          <button onClick={() => sendLive({ type: "Media", data: item })} className="w-full bg-white hover:bg-slate-200 text-black text-[10px] font-bold py-1 rounded">DISPLAY</button>
                          <button onClick={() => addToSchedule({ type: "Media", data: item })} className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded">+ QUEUE</button>
                          <button onClick={() => handleDeleteMedia(item.id)} className="w-full bg-red-900/60 hover:bg-red-900 text-red-300 text-[10px] font-bold py-1 rounded">DELETE</button>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 backdrop-blur-sm">
                          <p className="text-[8px] text-white truncate text-center">{item.name}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Presentations Tab ── */}
            {activeTab === "presentations" && (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Presentations</h2>
                  <button onClick={handleImportPresentation} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all">
                    + IMPORT
                  </button>
                </div>

                {presentations.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">
                    No presentations. Click + IMPORT to add a .pptx file.
                  </p>
                ) : (
                  <>
                    {/* Presentation file list */}
                    <div className="flex flex-col gap-1">
                      {presentations.map((pres) => (
                        <button
                          key={pres.id}
                          onClick={() => setSelectedPresId(pres.id)}
                          className={`flex items-center gap-2 p-2 rounded-lg border text-left text-xs transition-all ${
                            selectedPresId === pres.id
                              ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                              : "border-slate-700/50 bg-slate-800/40 text-slate-300 hover:bg-slate-800 hover:border-slate-600"
                          }`}
                        >
                          <span className="text-orange-400 font-black text-[9px] bg-orange-400/10 px-1.5 py-0.5 rounded shrink-0">
                            PPTX
                          </span>
                          <span className="flex-1 truncate text-left">{pres.name}</span>
                          {pres.slide_count > 0 && (
                            <span className="text-slate-500 text-[9px] shrink-0">
                              {pres.slide_count} slides
                            </span>
                          )}
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); handleDeletePresentation(pres.id); }}
                            className="shrink-0 text-red-500/50 hover:text-red-400 text-xs px-1 cursor-pointer"
                            title="Delete"
                          >
                            ✕
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Slide grid for the selected presentation */}
                    {selectedPresId && (
                      <div>
                        <p className="text-[9px] text-slate-600 uppercase font-bold mb-2 tracking-widest">
                          Slides
                        </p>
                        {!loadedSlides[selectedPresId] ? (
                          <p className="text-slate-600 text-xs italic text-center py-4">
                            Parsing slides...
                          </p>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {loadedSlides[selectedPresId].map((slide, idx) => {
                              const pres = presentations.find((p) => p.id === selectedPresId)!;
                              return (
                                <SlideThumbnail
                                  key={idx}
                                  slide={slide}
                                  index={idx}
                                  onStage={() => stagePresentationSlide(pres, idx)}
                                  onLive={() => sendPresentationSlide(pres, idx)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Schedule Tab ── */}
            {activeTab === "schedule" && (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Live Schedule</h2>
                  {scheduleEntries.length > 0 && (
                    <div className="flex gap-1">
                      <button
                        onClick={handlePrevScheduleItem}
                        disabled={activeScheduleIdx === 0 || scheduleEntries.length === 0}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
                      >
                        ← Prev
                      </button>
                      <button
                        onClick={handleNextScheduleItem}
                        disabled={scheduleEntries.length === 0 || activeScheduleIdx === scheduleEntries.length - 1}
                        className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded disabled:opacity-30 transition-all"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>

                {scheduleEntries.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">Schedule is empty. Add verses or media with + QUEUE.</p>
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
                          <div className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-black shrink-0 ${isActive ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-400"}`}>
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            {entry.item.type === "Verse" ? (
                              <>
                                <p className="text-amber-500 text-[10px] font-bold uppercase truncate">{entry.item.data.book} {entry.item.data.chapter}:{entry.item.data.verse}</p>
                                <p className="text-slate-400 text-[10px] truncate">{entry.item.data.text}</p>
                              </>
                            ) : entry.item.type === "PresentationSlide" ? (
                              <p className="text-orange-400 text-[10px] font-bold uppercase truncate">
                                PPTX: {entry.item.data.presentation_name} — Slide {entry.item.data.slide_index + 1}
                              </p>
                            ) : (
                              <p className="text-blue-400 text-[10px] font-bold uppercase truncate">{entry.item.data.media_type}: {entry.item.data.name}</p>
                            )}
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            <button onClick={() => handleScheduleItemSend(entry, idx)} title="Send live" className="p-1 bg-amber-500 hover:bg-amber-400 text-black rounded text-[10px] font-bold">▶</button>
                            <button onClick={() => removeFromSchedule(entry.id)} title="Remove" className="p-1 bg-red-900/50 text-red-400 rounded hover:bg-red-900 hover:text-white">✕</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Settings Tab ── */}
            {activeTab === "settings" && (
              <div className="flex flex-col gap-6">
                <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Output Settings</h2>

                {/* Theme selector */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Theme</p>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(THEMES).map(([key, { label, colors }]) => (
                      <button
                        key={key}
                        onClick={() => updateSettings({ ...settings, theme: key })}
                        className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-bold text-left transition-all ${
                          settings.theme === key
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        <span
                          className="w-5 h-5 rounded-sm shrink-0 border border-white/10"
                          style={{ backgroundColor: colors.background }}
                        />
                        <span className="truncate">{label}</span>
                        {settings.theme === key && (
                          <span className="ml-auto text-amber-500">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Reference position */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Reference</p>
                  <div className="flex gap-2">
                    {(["top", "bottom"] as const).map((pos) => (
                      <button
                        key={pos}
                        onClick={() => updateSettings({ ...settings, reference_position: pos })}
                        className={`flex-1 py-3 rounded-lg border text-xs font-bold transition-all ${
                          settings.reference_position === pos
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        {pos === "top" ? "▲  Top" : "▼  Bottom"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-600 italic mt-2">
                    Position of Book Chapter:Verse on the output screen.
                  </p>
                </div>

                {/* Output Background */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Output Background</p>

                  {/* Mode buttons */}
                  <div className="flex gap-2 mb-3">
                    {(["None", "Color", "Image"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => {
                          let bg: BackgroundSetting;
                          if (mode === "None") {
                            bg = { type: "None" };
                          } else if (mode === "Color") {
                            bg = { type: "Color", value: settings.background.type === "Color" ? (settings.background as any).value : "#1a1a2e" };
                          } else {
                            bg = { type: "Image", value: settings.background.type === "Image" ? (settings.background as any).value : "" };
                          }
                          updateSettings({ ...settings, background: bg });
                        }}
                        className={`flex-1 py-2 rounded-lg border text-xs font-bold transition-all ${
                          settings.background.type === mode
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        {mode === "None" ? "Theme" : mode}
                      </button>
                    ))}
                  </div>

                  {/* Color picker */}
                  {settings.background.type === "Color" && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={(settings.background as { type: "Color"; value: string }).value}
                        onChange={(e) =>
                          updateSettings({ ...settings, background: { type: "Color", value: e.target.value } })
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
                      />
                      <span className="text-xs text-slate-400 font-mono">
                        {(settings.background as { type: "Color"; value: string }).value}
                      </span>
                    </div>
                  )}

                  {/* Image picker */}
                  {settings.background.type === "Image" && (
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={handlePickBackgroundImage}
                        className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
                      >
                        Choose Image...
                      </button>
                      {(settings.background as { type: "Image"; value: string }).value && (
                        <p className="text-[9px] text-slate-500 truncate">
                          {(settings.background as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Live preview */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Preview</p>
                  <div
                    className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-slate-800"
                    style={computePreviewBackground(settings, THEMES[settings.theme]?.colors.background ?? "#000")}
                  >
                    {settings.reference_position === "top" && (
                      <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
                        John 3:16
                      </p>
                    )}
                    <p className="text-base font-serif leading-snug" style={{ color: THEMES[settings.theme]?.colors.verseText }}>
                      For God so loved the world that he gave his one and only Son...
                    </p>
                    {settings.reference_position === "bottom" && (
                      <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
                        John 3:16
                      </p>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-600 italic mt-2">
                    Changes apply instantly to the output window.
                  </p>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="flex-1 grid grid-rows-[1fr_2fr] gap-px bg-slate-800 overflow-hidden">

          {/* Transcription + Suggested */}
          <section className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-3">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest shrink-0">Live Transcription</h2>
            <div className="flex-1 overflow-y-auto text-xl font-light leading-snug text-slate-400 min-h-0">
              {transcript || <span className="text-slate-800 italic">Listening for audio feed...</span>}
            </div>

            {suggestedItem && (
              <div className="shrink-0 flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-0.5">Auto-detected</p>
                  {suggestedItem.type === "Verse" ? (
                    <p className="text-slate-300 text-sm truncate">
                      <span className="text-amber-500 font-bold">{suggestedItem.data.book} {suggestedItem.data.chapter}:{suggestedItem.data.verse}</span>
                      {" — "}
                      <span className="text-slate-400">{suggestedItem.data.text}</span>
                    </p>
                  ) : (
                    <p className="text-slate-300 text-sm truncate">{displayItemLabel(suggestedItem)}</p>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={stageSuggested} className="text-[10px] font-bold px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded transition-all">STAGE</button>
                  <button onClick={() => { if (suggestedItem) sendLive(suggestedItem); setSuggestedItem(null); }} className="text-[10px] font-bold px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded transition-all">DISPLAY</button>
                  <button onClick={() => setSuggestedItem(null)} className="text-[10px] text-slate-500 hover:text-slate-300 px-1 transition-all">✕</button>
                </div>
              </div>
            )}
          </section>

          {/* Dual Preview Area */}
          <section className="bg-slate-900 grid grid-cols-2 gap-px overflow-hidden relative">

            {/* Stage Preview */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden">
              <PreviewCard
                item={stagedItem}
                label="Stage Preview"
                accent="text-amber-500/50"
                badge={<span className="text-[10px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">NEXT</span>}
                empty="Stage is empty"
              />
            </div>

            {/* GO LIVE button */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
              <button
                onClick={goLive}
                disabled={!stagedItem}
                className="group relative w-20 h-20 bg-amber-500 hover:bg-amber-400 text-black rounded-full shadow-[0_0_30px_rgba(245,158,11,0.25)] flex flex-col items-center justify-center transition-all active:scale-95 disabled:grayscale disabled:opacity-40"
              >
                <span className="text-xl font-black">GO</span>
                <span className="text-[10px] font-bold">LIVE</span>
                {stagedItem && <div className="absolute inset-0 rounded-full animate-ping bg-amber-500 opacity-20 pointer-events-none" />}
              </button>
            </div>

            {/* Live Output + Next Verse strip */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-2">
              <PreviewCard
                item={liveItem}
                label="Live Output"
                accent="text-red-500/50"
                badge={
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[10px] bg-red-500/10 text-red-500 px-2 py-0.5 rounded border border-red-500/20 uppercase font-bold">On Air</span>
                  </div>
                }
                empty="Output is empty"
              />

              {/* Next verse quick-send — only shown when a verse is live */}
              {nextVerse && (
                <div className="shrink-0 flex items-center gap-2 bg-slate-900 border border-slate-700/60 rounded-xl px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] text-slate-600 uppercase font-bold mb-0.5">Up next</p>
                    <p className="text-xs truncate">
                      <span className="text-amber-500/80 font-bold">{nextVerse.book} {nextVerse.chapter}:{nextVerse.verse}</span>
                      <span className="text-slate-500 ml-1">{nextVerse.text}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => sendLive({ type: "Verse", data: nextVerse })}
                    className="shrink-0 text-[9px] font-bold px-2 py-1 bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 border border-amber-500/30 rounded transition-all whitespace-nowrap"
                  >
                    NEXT ▶
                  </button>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
