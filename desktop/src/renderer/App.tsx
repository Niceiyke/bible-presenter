import React, { useEffect, useState, useRef } from 'react'

const OperatorView = () => {
  const [transcription, setTranscription] = useState('')
  const [detectedVerses, setDetectedVerses] = useState<any[]>([])
  const [isListening, setIsListening] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        (window as any).electron.sendBuffer('audio-chunk', pcmData.buffer);
      };

      setIsListening(true);
      setTranscription('Microphone active. Listening for sermon...');
    } catch (err) {
      console.error('Failed to start microphone:', err);
      setTranscription('Error: Could not access microphone.');
    }
  };

  const stopListening = () => {
    processorRef.current?.disconnect();
    audioContextRef.current?.close();
    setIsListening(false);
    setTranscription('Microphone stopped.');
  };

  useEffect(() => {
    (window as any).electron.on('transcription-update', (data: any) => {
      // Handle the new data structure from the hybrid engine
      if (typeof data === 'string') {
        setTranscription(prev => (prev.length > 1000 ? data : prev + ' ' + data));
      } else {
        setTranscription(prev => (prev.length > 1000 ? data.text : prev + ' ' + data.text));
        
        // Handle detected verses (explicit + semantic)
        const allMatches = [...(data.matches || []), ...(data.semantic_matches || [])];
        if (allMatches.length > 0) {
          setDetectedVerses(prev => {
            const newVerses = allMatches.filter(m => !prev.some(v => v.reference === m.reference));
            return [...newVerses, ...prev].slice(0, 50); // Keep last 50
          });
        }
      }
      
      // Auto-scroll transcription
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });

    (window as any).electron.on('verse-found', (verse: any) => {
      setDetectedVerses(prev => {
          if (prev.find(v => v.reference === verse.reference)) return prev;
          return [verse, ...prev];
      });
    });
  }, []);

  const handleManualSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
        const ref = (e.target as HTMLInputElement).value;
        (window as any).electron.send('search-verse', ref);
    }
  }

  const projectVerse = (verse: any) => {
    (window as any).electron.send('update-verse', verse);
  }

  return (
    <div className="p-8 w-screen h-screen bg-slate-900 text-white flex flex-col overflow-hidden">
      <header className="mb-8 flex justify-between items-center shrink-0">
        <div>
           <h1 className="text-3xl font-bold text-bible-gold font-serif">Bible Presenter</h1>
           <p className="text-slate-400 text-sm tracking-widest uppercase">Hybrid Intelligence Mode</p>
        </div>
        <div className="flex gap-4">
          <input 
            type="text" 
            placeholder="Quick Jump (e.g. John 3:16)"
            className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700 w-64 focus:border-bible-gold outline-none transition-all"
            onKeyDown={handleManualSearch}
          />
          {!isListening ? (
            <button 
              onClick={startListening}
              className="px-6 py-2 bg-bible-gold text-slate-900 rounded-lg font-bold hover:bg-yellow-500 shadow-lg shadow-yellow-900/20"
            >
              Start AI Engine
            </button>
          ) : (
            <button 
              onClick={stopListening}
              className="px-6 py-2 bg-red-600 text-white rounded-lg font-bold hover:bg-red-500"
            >
              Stop AI Engine
            </button>
          )}
        </div>
      </header>
      
      <main className="flex-1 grid grid-cols-2 gap-8 overflow-hidden min-h-0">
        <section className="bg-slate-800/50 border border-slate-700 p-6 rounded-2xl flex flex-col overflow-hidden backdrop-blur-sm">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4 font-bold shrink-0">Live Sermon Context</h2>
          <div ref={scrollRef} className="flex-1 bg-slate-950/50 p-6 rounded-xl overflow-y-auto text-xl leading-relaxed text-slate-200 font-serif italic border border-slate-800">
            {transcription || 'AI Engine is offline. Start the engine to begin tracking.'}
          </div>
        </section>

        <section className="bg-slate-800/50 border border-slate-700 p-6 rounded-2xl flex flex-col overflow-hidden backdrop-blur-sm">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4 font-bold shrink-0">Detected & Suggested Scriptures</h2>
          <div className="flex-1 space-y-4 overflow-y-auto pr-2 custom-scrollbar">
            {detectedVerses.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 italic">
                    <p>Scriptures will appear here</p>
                    <p className="text-xs">as the sermon progresses...</p>
                </div>
            )}
            {detectedVerses.map((v, i) => (
                <div key={i} className={`p-5 rounded-xl border-l-4 animate-in slide-in-from-right duration-500 ${
                    v.type === 'explicit' 
                        ? 'bg-bible-indigo border-bible-gold' 
                        : 'bg-slate-800 border-indigo-400 opacity-90'
                }`}>
                    <div className="flex justify-between items-start mb-2">
                        <span className={`text-[10px] uppercase font-black px-2 py-0.5 rounded ${
                            v.type === 'explicit' ? 'bg-bible-gold text-slate-900' : 'bg-indigo-500 text-white'
                        }`}>
                            {v.type === 'explicit' ? 'Direct Reference' : `Semantic Match (${Math.round(v.score * 100)}%)`}
                        </span>
                        <span className="text-xs text-slate-500 font-mono">#{i + 1}</span>
                    </div>
                    <p className="text-2xl font-serif text-white">{v.reference}</p>
                    <p className="text-sm text-slate-300 line-clamp-3 italic my-3 leading-relaxed">"{v.text}"</p>
                    <button 
                        onClick={() => projectVerse(v)}
                        className={`mt-2 w-full py-2.5 rounded-lg font-bold transition-all ${
                            v.type === 'explicit' 
                                ? 'bg-bible-gold text-slate-900 hover:bg-yellow-500' 
                                : 'bg-indigo-600 text-white hover:bg-indigo-500'
                        }`}
                    >
                        Project to Output
                    </button>
                </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}

const OutputView = () => {
  const [verse, setVerse] = useState<any>(null);

  useEffect(() => {
    (window as any).electron.on('verse-updated', (newVerse: any) => {
      setVerse(newVerse);
    });
  }, []);

  if (!verse) return <div className="bg-slate-950 w-screen h-screen"></div>;

  return (
    <div className="w-screen h-screen flex flex-col justify-center items-center p-24 bg-slate-950 overflow-hidden">
      <div className="max-w-6xl text-center animate-in zoom-in-95 fade-in duration-700">
        <h2 className="text-6xl font-serif text-white leading-tight mb-16 drop-shadow-2xl">
          "{verse.text}"
        </h2>
        <div className="flex items-center justify-center gap-6">
            <div className="h-[1px] w-32 bg-gradient-to-r from-transparent to-bible-gold"></div>
            <p className="text-4xl font-sans text-bible-gold font-bold uppercase tracking-[0.3em] drop-shadow">
                {verse.reference}
            </p>
            <div className="h-[1px] w-32 bg-gradient-to-l from-transparent to-bible-gold"></div>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [view, setView] = useState('operator');

  useEffect(() => {
    if (window.location.hash.includes('output')) {
      setView('output');
    }
  }, []);

  return (
    <div className="app bg-slate-950 selection:bg-bible-gold selection:text-slate-900">
      {view === 'operator' ? <OperatorView /> : <OutputView />}
    </div>
  )
}

export default App;
