import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export default function App() {
  const [label, setLabel] = useState("");
  const [transcript, setTranscript] = useState("");
  const [activeVerse, setActiveVerse] = useState<any>(null);
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [vadThreshold, setVadThreshold] = useState(0.005);
  const [sessionState, setSessionState] = useState<"idle" | "loading" | "running">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);

  // Manual Selection State
  const [books, setBooks] = useState<string[]>([]);
  const [chapters, setChapters] = useState<number[]>([]);
  const [verses, setVerses] = useState<number[]>([]);
  const [selectedBook, setSelectedBook] = useState("");
  const [selectedChapter, setSelectedChapter] = useState(0);
  const [selectedVerse, setSelectedVerse] = useState(0);

  useEffect(() => {
    setLabel(getCurrentWindow().label);

    if (getCurrentWindow().label !== "output") {
      invoke("get_audio_devices").then((devs: any) => {
        setDevices(devs);
        if (devs.length > 0) setSelectedDevice(devs[0][0]);
      });

      invoke("get_books").then((b: any) => setBooks(b));
    }

    const unlisten = listen("transcription-update", (event: any) => {
      setTranscript(event.payload.text);
      if (event.payload.detected_verse) {
        setActiveVerse(event.payload.detected_verse);
      }
    });

    // C3/C5: Track session lifecycle for the START/STOP button
    const unlistenStatus = listen("session-status", (event: any) => {
      const { status } = event.payload as { status: string; message: string };
      if (status === "running") setSessionState("running");
      else if (status === "loading") setSessionState("loading");
      else setSessionState("idle");
    });

    // C4: Show audio device errors visibly instead of silently dropping them
    const unlistenAudioErr = listen("audio-error", (event: any) => {
      setAudioError(String(event.payload));
      setSessionState("idle");
    });

    return () => {
      unlisten.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenAudioErr.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (selectedBook) {
      invoke("get_chapters", { book: selectedBook }).then((c: any) => {
        setChapters(c);
        setSelectedChapter(c[0] || 0);
      });
    }
  }, [selectedBook]);

  useEffect(() => {
    if (selectedBook && selectedChapter) {
      invoke("get_verses_count", { book: selectedBook, chapter: selectedChapter }).then((v: any) => {
        setVerses(v);
        setSelectedVerse(v[0] || 0);
      });
    }
  }, [selectedBook, selectedChapter]);

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const device = e.target.value;
    setSelectedDevice(device);
    invoke("set_audio_device", { deviceName: device });
  };

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

  const selectManualVerse = async (verse: any) => {
    setActiveVerse(verse);
    invoke("select_verse", { verse }).catch((err: any) =>
      setAudioError(String(err))
    );
  };

  const handleDisplaySelection = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
      });
      if (verse) {
        setActiveVerse(verse);
        invoke("select_verse", { verse }).catch((err: any) =>
          setAudioError(String(err))
        );
      } else {
        setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
      }
    } catch (err: any) {
      setAudioError(String(err));
    }
  };

  const updateVad = (val: string) => {
    const threshold = parseFloat(val);
    setVadThreshold(threshold);
    invoke("set_vad_threshold", { threshold });
  };

  if (label === "output") {
    return (
      <div className="h-screen w-screen bg-black flex flex-col items-center justify-center p-12 text-white">
        {activeVerse ? (
          <div className="text-center animate-in fade-in duration-700">
            <h1 className="text-7xl font-serif mb-8">{activeVerse.text}</h1>
            <p className="text-4xl text-amber-500 uppercase tracking-widest">
              {activeVerse.book} {activeVerse.chapter}:{activeVerse.verse}
            </p>
          </div>
        ) : (
          <div className="text-zinc-800 font-serif text-2xl italic">Waiting for scripture...</div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      <header className="flex justify-between items-center p-6 border-b border-slate-800 bg-slate-900/50">
        <h1 className="text-xl font-bold tracking-tight text-white">BIBLE PRESENTER <span className="text-xs bg-amber-500 text-black px-2 py-0.5 rounded ml-2">PRO</span></h1>
        
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end mr-4">
            <span className="text-[10px] text-slate-500 uppercase font-bold mb-1">Sensitivity</span>
            <input 
              type="range" min="0.0001" max="0.05" step="0.0005" 
              value={vadThreshold} 
              onChange={(e) => updateVad(e.target.value)}
              className="w-32 accent-amber-500"
            />
          </div>

          <select 
            value={selectedDevice} 
            onChange={handleDeviceChange}
            className="bg-slate-800 text-white border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            {devices.map(([name, id]) => (
              <option key={id} value={name}>{name}</option>
            ))}
          </select>

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
          <span className="font-bold text-red-400 uppercase tracking-widest">Audio Error</span>
          <span className="flex-1">{audioError}</span>
          <button
            onClick={() => setAudioError(null)}
            className="text-red-500 hover:text-red-200 font-bold transition-all"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Selection & Search */}
        <aside className="w-80 bg-slate-900/30 border-r border-slate-800 p-6 flex flex-col gap-8">
          {/* Reference Picker */}
          <div>
            <h2 className="text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">Manual Selection</h2>
            <div className="grid grid-cols-1 gap-3">
              <select 
                value={selectedBook} 
                onChange={(e) => setSelectedBook(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select Book</option>
                {books.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              
              <div className="grid grid-cols-2 gap-3">
                <select 
                    value={selectedChapter} 
                    onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                >
                    {chapters.map(c => <option key={c} value={c}>Chap {c}</option>)}
                </select>
                <select 
                    value={selectedVerse} 
                    onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                >
                    {verses.map(v => <option key={v} value={v}>Verse {v}</option>)}
                </select>
              </div>

              <button 
                onClick={handleDisplaySelection}
                disabled={!selectedBook}
                className="bg-slate-100 hover:bg-white text-black font-bold py-2 rounded-lg transition-all text-sm disabled:opacity-30"
              >
                DISPLAY REFERENCE
              </button>
            </div>
          </div>

          <hr className="border-slate-800" />

          {/* Keyword Search */}
          <div className="flex-1 flex flex-col min-h-0">
            <h2 className="text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">Keyword Search</h2>
            <form onSubmit={handleSearch} className="mb-4 flex gap-2">
              <input
                type="text"
                placeholder="Search scripture..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <button
                type="submit"
                className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all"
              >
                Go
              </button>
            </form>
            
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {searchResults.map((v, i) => (
                <button 
                    key={i}
                    onClick={() => selectManualVerse(v)}
                    className="w-full text-left p-3 rounded-lg bg-slate-800/50 hover:bg-slate-800 border border-transparent hover:border-slate-700 transition-all group"
                >
                    <p className="text-amber-500 text-xs font-bold mb-1 uppercase">{v.book} {v.chapter}:{v.verse}</p>
                    <p className="text-slate-300 text-xs line-clamp-2 group-hover:text-white">{v.text}</p>
                </button>
                ))}
            </div>
          </div>
        </aside>

        {/* Main Content: Live Feed */}
        <main className="flex-1 grid grid-rows-2 gap-px bg-slate-800 overflow-hidden">
          <section className="bg-slate-950 p-8 flex flex-col overflow-hidden">
            <h2 className="text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">Live Transcription</h2>
            <div className="flex-1 overflow-y-auto text-3xl font-light leading-tight text-slate-400">
              {transcript || <span className="text-slate-800 italic">Listening for audio feed...</span>}
            </div>
          </section>

          <section className="bg-slate-950 p-8 flex flex-col border-t border-slate-800 overflow-hidden">
            <h2 className="text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">Current Projection</h2>
            {activeVerse ? (
              <div className="animate-in slide-in-from-bottom duration-700">
                <p className="text-4xl font-serif mb-6 text-white leading-snug">{activeVerse.text}</p>
                <div className="flex items-center gap-4">
                  <span className="text-amber-500 font-black text-lg tracking-widest uppercase">
                    {activeVerse.book} {activeVerse.chapter}:{activeVerse.verse}
                  </span>
                  <span className="h-px flex-1 bg-slate-800"></span>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center border-2 border-dashed border-slate-900 rounded-3xl">
                <p className="text-slate-800 font-serif text-xl">Output window is empty</p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
