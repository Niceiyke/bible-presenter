import React, { useEffect, useState, useRef } from 'react'

const OperatorView = () => {
  const [transcription, setTranscription] = useState('')
  const [detectedVerses, setDetectedVerses] = useState<any[]>([])
  const [isListening, setIsListening] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      // Using ScriptProcessor for simple PCM streaming
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert to Int16 for Faster-Whisper
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
    (window as any).electron.on('transcription-update', (text: string) => {
      setTranscription(prev => (prev.length > 500 ? text : prev + ' ' + text));
      simulateDetection(text);
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
           <h1 className="text-3xl font-bold text-bible-gold">Bible Presenter Core</h1>
           <p className="text-slate-400 text-sm">Real-time Broadcast Mode Active</p>
        </div>
        <div className="flex gap-4">
          <input 
            type="text" 
            placeholder="Manual search (e.g. John 3:16)"
            className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700 w-64 focus:border-bible-gold outline-none"
            onKeyDown={handleManualSearch}
          />
          {!isListening ? (
            <button 
              onClick={startListening}
              className="px-4 py-2 bg-bible-gold text-slate-900 rounded-lg font-bold hover:bg-yellow-500"
            >
              Start Listening
            </button>
          ) : (
            <button 
              onClick={stopListening}
              className="px-4 py-2 bg-red-600 text-white rounded-lg font-bold hover:bg-red-500"
            >
              Stop Listening
            </button>
          )}
        </div>
      </header>
      
      <main className="flex-1 grid grid-cols-2 gap-8 overflow-hidden min-h-0">
        <section className="bg-slate-800 p-6 rounded-xl flex flex-col overflow-hidden">
          <h2 className="text-xl mb-4 font-semibold shrink-0">Live Transcription</h2>
          <div className="flex-1 bg-slate-950 p-4 rounded-lg overflow-y-auto text-lg leading-relaxed text-slate-300 italic">
            {transcription || 'Waiting for sermon audio...'}
            <p className="mt-4 text-xs text-slate-500 italic">(Simulated: Search "John 3:16" in the manual box above to see detection in action)</p>
          </div>
        </section>

        <section className="bg-slate-800 p-6 rounded-xl flex flex-col overflow-hidden">
          <h2 className="text-xl mb-4 font-semibold shrink-0">Detected Scriptures</h2>
          <div className="flex-1 space-y-4 overflow-y-auto pr-2">
            {detectedVerses.map((v, i) => (
                <div key={i} className="bg-bible-indigo p-4 rounded-lg border-l-4 border-bible-gold animate-in slide-in-from-right duration-300">
                    <p className="text-xs uppercase text-slate-400 font-bold mb-1">Detected Reference</p>
                    <p className="text-xl font-serif">{v.reference}</p>
                    <p className="text-sm text-slate-300 line-clamp-2 italic my-2">{v.text}</p>
                    <button 
                        onClick={() => projectVerse(v)}
                        className="mt-2 w-full py-2 bg-bible-gold text-slate-900 rounded font-bold hover:bg-yellow-500 transition-colors"
                    >
                        Project to Screen
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

  if (!verse) return <div className="bg-transparent w-screen h-screen"></div>;

  return (
    <div className="w-screen h-screen flex flex-col justify-center items-center p-20 bg-slate-900 animate-in fade-in duration-500">
      <div className="max-w-5xl text-center">
        <h2 className="text-5xl font-serif text-white leading-tight mb-12 drop-shadow-lg">
          "{verse.text}"
        </h2>
        <div className="flex items-center justify-center gap-4">
            <div className="h-[2px] w-20 bg-bible-gold"></div>
            <p className="text-4xl font-sans text-bible-gold font-bold uppercase tracking-[0.2em]">
                {verse.reference}
            </p>
            <div className="h-[2px] w-20 bg-bible-gold"></div>
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
    <div className="app bg-slate-950">
      {view === 'operator' ? <OperatorView /> : <OutputView />}
    </div>
  )
}

export default App
