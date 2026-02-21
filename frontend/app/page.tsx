"use client"
import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, Settings, Play, ExternalLink, X, Search, BookOpen, Sparkles, Mic, MicOff, Radio, Book, Eye } from 'lucide-react';

interface Verse {
  id: number;
  reference: string;
  text: string;
}

interface SearchResult {
  reference: string;
  text: string;
  score?: number;
}

interface ChapterVerse {
  reference: string;
  text: string;
  verse: number;
  book: string;
  chapter: number;
}

const BiblePresenter = () => {
  const [verses, setVerses] = useState<Verse[]>([
    { id: 1, reference: 'John 3:16', text: 'For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life.' }
  ]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [bgColor, setBgColor] = useState('#000000');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [fontSize, setFontSize] = useState(48);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMode, setSearchMode] = useState('semantic');
  const [displayMode, setDisplayMode] = useState('control');
  const [apiUrl, setApiUrl] = useState('https://bible-api.iykebytes.xyz');
  const [apiStatus, setApiStatus] = useState('unknown');

  // Bible browser states
  const [bibleBooks, setBibleBooks] = useState<string[]>([]);
  const [selectedBook, setSelectedBook] = useState('');
  const [selectedChapter, setSelectedChapter] = useState(1);
  const [chapterVerses, setChapterVerses] = useState<ChapterVerse[]>([]);
  const [previewVerse, setPreviewVerse] = useState<ChapterVerse | null>(null);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [maxChapter, setMaxChapter] = useState(1);
  const [autoLoadChapter, setAutoLoadChapter] = useState(true);

  // Live speech recognition states
  const [isListening, setIsListening] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [detectedReferences, setDetectedReferences] = useState<string[]>([]);
  const [autoDisplay, setAutoDisplay] = useState(true);
  const [speechStatus, setSpeechStatus] = useState('idle');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    checkApiHealth();
    loadBibleBooks();
  }, [apiUrl]);

  const checkApiHealth = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/health`);
      if (response.ok) {
        const data = await response.json();
        setApiStatus(`online (${data.verses_in_db} verses)`);
      } else {
        setApiStatus('offline');
      }
    } catch (error) {
      setApiStatus('offline');
    }
  };

  const loadBibleBooks = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/books`);
      if (response.ok) {
        const data = await response.json();
        setBibleBooks(data.books);
        if (data.books.length > 0) {
          setSelectedBook(data.books[0]);
        }
      }
    } catch (error) {
      console.error('Failed to load books:', error);
    }
  };

  const loadChapter = async (book: string, chapter: number) => {
    setIsLoadingChapter(true);
    try {
      const response = await fetch(`${apiUrl}/api/search/direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: `${book} ${chapter}`
        })
      });

      if (response.ok) {
        const data = await response.json();
        setChapterVerses(data);
        // Determine max chapter by trying next chapter
        const nextResponse = await fetch(`${apiUrl}/api/search/direct`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            reference: `${book} ${chapter + 1}`
          })
        });
        if (!nextResponse.ok && chapter > 1) {
          setMaxChapter(chapter);
        }
      }
    } catch (error) {
      console.error('Failed to load chapter:', error);
    } finally {
      setIsLoadingChapter(false);
    }
  };

  useEffect(() => {
    if (selectedBook) {
      loadChapter(selectedBook, selectedChapter);
    }
  }, [selectedBook, selectedChapter]);

  const addVerseToPresentation = (verse: ChapterVerse) => {
    const newVerse = {
      id: Date.now(),
      reference: verse.reference,
      text: verse.text
    };
    setVerses([...verses, newVerse]);
    setPreviewVerse(null);
  };

  const addChapterToPresentation = () => {
    if (chapterVerses.length === 0) return;

    const newVerses = chapterVerses.map((v, idx) => ({
      id: Date.now() + idx,
      reference: v.reference,
      text: v.text
    }));

    setVerses([...verses, ...newVerses]);
    alert(`Added ${newVerses.length} verses from ${selectedBook} ${selectedChapter}`);
  };

  const showVerseOnPresenter = (verse: ChapterVerse) => {
    const newVerse = {
      id: Date.now(),
      reference: verse.reference,
      text: verse.text
    };
    setVerses([...verses, newVerse]);
    setCurrentIndex(verses.length);

    // Auto-load all verses in chapter if enabled
    if (autoLoadChapter) {
      setTimeout(() => {
        const chapterNum = verse.chapter;
        const bookName = verse.book;
        loadAndAddChapter(bookName, chapterNum);
      }, 100);
    }
  };

  const loadAndAddChapter = async (book: string, chapter: number) => {
    try {
      const response = await fetch(`${apiUrl}/api/search/direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: `${book} ${chapter}`
        })
      });

      if (response.ok) {
        const data: ChapterVerse[] = await response.json();
        const existingRefs = new Set(verses.map(v => v.reference));
        const newVerses = data
          .filter(v => !existingRefs.has(v.reference))
          .map((v, idx) => ({
            id: Date.now() + idx + 1,
            reference: v.reference,
            text: v.text
          }));

        if (newVerses.length > 0) {
          setVerses(prev => [...prev, ...newVerses]);
        }
      }
    } catch (error) {
      console.error('Failed to load chapter:', error);
    }
  };

  const semanticSearch = async (query: string) => {
    if (!query.trim()) return;

    setIsSearching(true);
    setSearchResults([]);

    try {
      const response = await fetch(`${apiUrl}/api/search/semantic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          limit: 10
        })
      });

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data: SearchResult[] = await response.json();
      setSearchResults(data.map(v => ({
        reference: v.reference,
        text: v.text,
        score: v.score
      })));
    } catch (error) {
      console.error('Semantic search error:', error);
      alert('Semantic search failed. Make sure the backend API is running at ' + apiUrl);
    } finally {
      setIsSearching(false);
    }
  };

  const directSearch = async (reference: string) => {
    if (!reference.trim()) return;

    setIsSearching(true);
    setSearchResults([]);

    try {
      const response = await fetch(`${apiUrl}/api/search/direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: reference
        })
      });

      if (!response.ok) {
        throw new Error('Reference not found');
      }

      const data: SearchResult[] = await response.json();
      setSearchResults(data.map(v => ({
        reference: v.reference,
        text: v.text
      })));
    } catch (error) {
      console.error('Direct search error:', error);
      alert('Reference not found. Try something like "John 3:16" or "Psalms 23"');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = () => {
    if (searchMode === 'semantic') {
      semanticSearch(searchQuery);
    } else {
      directSearch(searchQuery);
    }
  };

  // Live speech recognition functions
  const startListening = async () => {
    try {
      setSpeechStatus('initializing');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm'
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await processAudio(audioBlob);
        audioChunksRef.current = [];
      };

      mediaRecorder.start();
      setIsListening(true);
      setSpeechStatus('listening');

      intervalIdRef.current = setInterval(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          setTimeout(() => {
            if (isListening && mediaRecorderRef.current) {
              mediaRecorderRef.current.start();
            }
          }, 100);
        }
      }, 5000);

    } catch (error) {
      console.error('Error starting audio:', error);
      alert('Could not access microphone. Please grant permission.');
      setSpeechStatus('error');
    }
  };

  const stopListening = () => {
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }

    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }

      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
    }

    setIsListening(false);
    setSpeechStatus('idle');
  };

  const processAudio = async (audioBlob: Blob) => {
    try {
      setSpeechStatus('processing');

      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');

      const response = await fetch(`${apiUrl}/api/speech/transcribe`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Transcription failed');
      }

      const data = await response.json();

      setTranscription(prev => prev + ' ' + data.text);

      if (data.detected_references.length > 0) {
        setDetectedReferences(prev => [...prev, ...data.detected_references]);
      }

      if (autoDisplay && data.verses.length > 0) {
        const newVerses = data.verses.map((v: { reference: string; text: string }, idx: number) => ({
          id: Date.now() + idx,
          reference: v.reference,
          text: v.text
        }));

        setVerses(prev => [...prev, ...newVerses]);

        if (newVerses.length > 0) {
          setCurrentIndex(verses.length);
        }
      }

      setSpeechStatus('listening');

    } catch (error) {
      console.error('Processing error:', error);
      setSpeechStatus('error');
      setTimeout(() => {
        if (isListening) {
          setSpeechStatus('listening');
        }
      }, 2000);
    }
  };

  const clearTranscription = () => {
    setTranscription('');
    setDetectedReferences([]);
  };

  const addVerseFromSearch = (result: SearchResult) => {
    const newVerse = {
      id: Date.now(),
      reference: result.reference,
      text: result.text
    };
    setVerses([...verses, newVerse]);
    alert('Verse added to list!');
  };

  const addMultipleVerses = () => {
    if (searchResults.length === 0) return;

    const newVerses = searchResults.map((result, index) => ({
      id: Date.now() + index,
      reference: result.reference,
      text: result.text
    }));

    setVerses([...verses, ...newVerses]);
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    alert(`Added ${newVerses.length} verse(s) to list!`);
  };

  // Initialize Broadcast Channel
  useEffect(() => {
    channelRef.current = new BroadcastChannel('bible_presenter_channel');

    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'presenter') {
      setDisplayMode('presenter');

      const savedState = sessionStorage.getItem('presenterState');
      if (savedState) {
        const state = JSON.parse(savedState);
        setVerses(state.verses);
        setCurrentIndex(state.currentIndex);
        setBgColor(state.bgColor);
        setTextColor(state.textColor);
        setFontSize(state.fontSize);
      }

      channelRef.current.onmessage = (event) => {
        const { type, data } = event.data;

        if (type === 'STATE_UPDATE') {
          setVerses(data.verses);
          setCurrentIndex(data.currentIndex);
          setBgColor(data.bgColor);
          setTextColor(data.textColor);
          setFontSize(data.fontSize);
        }
      };

      channelRef.current.postMessage({ type: 'REQUEST_STATE' });
    } else {
      channelRef.current.onmessage = (event) => {
        if (event.data.type === 'REQUEST_STATE') {
          const state = {
            verses,
            currentIndex,
            bgColor,
            textColor,
            fontSize
          };
          channelRef.current?.postMessage({ type: 'STATE_UPDATE', data: state });
        }
      };
    }

    return () => {
      if (channelRef.current) {
        channelRef.current.close();
      }
      if (isListening) {
        stopListening();
      }
    };
  }, []);

  useEffect(() => {
    if (displayMode === 'control' && channelRef.current) {
      const state = {
        verses,
        currentIndex,
        bgColor,
        textColor,
        fontSize
      };

      sessionStorage.setItem('presenterState', JSON.stringify(state));
      channelRef.current.postMessage({ type: 'STATE_UPDATE', data: state });
    }
  }, [verses, currentIndex, bgColor, textColor, fontSize, displayMode]);

  const addVerse = () => {
    const newVerse = {
      id: Date.now(),
      reference: '',
      text: ''
    };
    setVerses([...verses, newVerse]);
  };

  const deleteVerse = (id: number) => {
    setVerses(verses.filter(v => v.id !== id));
  };

  const updateVerse = (id: number, field: string, value: string) => {
    setVerses(verses.map(v => v.id === id ? { ...v, [field]: value } : v));
  };

  const moveVerse = (index: number, direction: number) => {
    const newVerses = [...verses];
    const targetIndex = index + direction;
    if (targetIndex >= 0 && targetIndex < verses.length) {
      [newVerses[index], newVerses[targetIndex]] = [newVerses[targetIndex], newVerses[index]];
      setVerses(newVerses);
      if (currentIndex === index) setCurrentIndex(targetIndex);
      else if (currentIndex === targetIndex) setCurrentIndex(index);
    }
  };

  const openPresenterTab = () => {
    const state = {
      verses,
      currentIndex,
      bgColor,
      textColor,
      fontSize
    };
    sessionStorage.setItem('presenterState', JSON.stringify(state));

    const url = window.location.href.split('?')[0] + '?mode=presenter';
    window.open(url, '_blank');
  };

  const goToVerse = (index: number) => {
    setCurrentIndex(index);
  };

  const nextVerse = () => {
    if (currentIndex < verses.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const prevVerse = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (displayMode === 'control' && !showSearch && !showBrowser) {
        if (e.key === 'ArrowRight' || e.key === ' ') {
          e.preventDefault();
          nextVerse();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          prevVerse();
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentIndex, verses.length, displayMode, showSearch, showBrowser]);

  // Presenter View
  if (displayMode === 'presenter') {
    const verse = verses[currentIndex] || { reference: '', text: '' };

    return (
      <div
        style={{
          backgroundColor: bgColor,
          color: textColor,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily: 'Arial, sans-serif'
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '90%', width: '100%' }}>
          <div style={{
            fontWeight: 'bold',
            marginBottom: '1.5rem',
            opacity: 0.9,
            fontSize: `clamp(20px, ${fontSize * 0.7}px, ${fontSize * 0.7}px)`
          }}>
            {verse.reference}
          </div>
          <div style={{
            lineHeight: 1.6,
            fontSize: `clamp(24px, ${fontSize}px, ${fontSize}px)`
          }}>
            {verse.text}
          </div>
        </div>
      </div>
    );
  }

  // Control Interface
  return (
    <div className="min-h-screen bg-gray-900 text-white p-3 sm:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 sm:mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">Bible Presenter</h1>
          <div className="flex flex-wrap gap-2 sm:gap-3 w-full sm:w-auto">
            <button
              onClick={isListening ? stopListening : startListening}
              className={`flex-1 sm:flex-none px-3 sm:px-4 py-2 rounded-lg flex items-center justify-center gap-2 text-sm sm:text-base ${isListening ? 'bg-red-600 hover:bg-red-700 animate-pulse' : 'bg-green-600 hover:bg-green-700'
                }`}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
              {isListening ? 'Stop' : 'Live'}
            </button>
            <button
              onClick={() => setShowBrowser(!showBrowser)}
              className="flex-1 sm:flex-none px-3 sm:px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-700 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <Book size={18} className="sm:w-5 sm:h-5" />
              Browse
            </button>
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="flex-1 sm:flex-none px-3 sm:px-4 py-2 bg-purple-600 rounded-lg hover:bg-purple-700 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <Search size={18} className="sm:w-5 sm:h-5" />
              Search
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex-1 sm:flex-none px-3 sm:px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <Settings size={18} className="sm:w-5 sm:h-5" />
              Settings
            </button>
            <button
              onClick={openPresenterTab}
              className="flex-1 sm:flex-none px-3 sm:px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <ExternalLink size={18} className="sm:w-5 sm:h-5" />
              Presenter
            </button>
          </div>
        </div>

        {/* API Status */}
        <div className="mb-4 p-3 bg-gray-800 rounded-lg flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${apiStatus.includes('online') ? 'bg-green-500' : 'bg-red-500'}`} />
            <span>Backend: {apiStatus}</span>
            {speechStatus !== 'idle' && (
              <>
                <span className="text-gray-400">|</span>
                <Radio size={16} className={speechStatus === 'listening' ? 'text-green-500' : 'text-yellow-500'} />
                <span className="capitalize">{speechStatus}</span>
              </>
            )}
          </div>
          <button
            onClick={checkApiHealth}
            className="text-blue-400 hover:text-blue-300 text-xs"
          >
            Refresh
          </button>
        </div>

        {/* Bible Browser Panel */}
        {showBrowser && (
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2">
                <Book size={20} />
                Bible Browser
              </h2>
              <button onClick={() => setShowBrowser(false)} className="sm:hidden">
                <X size={24} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Book Selection */}
              <div>
                <label className="block mb-2 text-sm font-bold">Select Book</label>
                <select
                  value={selectedBook}
                  onChange={(e) => {
                    setSelectedBook(e.target.value);
                    setSelectedChapter(1);
                  }}
                  className="w-full px-3 py-2 bg-gray-700 rounded text-white text-sm"
                >
                  {bibleBooks.map(book => (
                    <option key={book} value={book}>{book}</option>
                  ))}
                </select>
              </div>

              {/* Chapter Selection */}
              <div>
                <label className="block mb-2 text-sm font-bold">Chapter</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedChapter(prev => Math.max(1, prev - 1))}
                    disabled={selectedChapter <= 1}
                    className="px-3 py-2 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
                  >
                    ←
                  </button>
                  <input
                    type="number"
                    min="1"
                    value={selectedChapter}
                    onChange={(e) => setSelectedChapter(parseInt(e.target.value) || 1)}
                    className="flex-1 px-3 py-2 bg-gray-700 rounded text-white text-center"
                  />
                  <button
                    onClick={() => setSelectedChapter(prev => prev + 1)}
                    className="px-3 py-2 bg-gray-700 rounded hover:bg-gray-600"
                  >
                    →
                  </button>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-2">
                <label className="block mb-2 text-sm font-bold opacity-0">Actions</label>
                <button
                  onClick={addChapterToPresentation}
                  className="px-4 py-2 bg-green-600 rounded hover:bg-green-700 text-sm flex items-center justify-center gap-2"
                >
                  <Plus size={16} />
                  Add Chapter
                </button>
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input
                    type="checkbox"
                    checked={autoLoadChapter}
                    onChange={(e) => setAutoLoadChapter(e.target.checked)}
                    className="rounded"
                  />
                  Auto-load chapter on display
                </label>
              </div>
            </div>

            {/* Verses Display */}
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-sm">
                  {selectedBook} {selectedChapter} ({chapterVerses.length} verses)
                </h3>
              </div>

              {isLoadingChapter ? (
                <div className="text-center py-8 text-gray-400">Loading...</div>
              ) : (
                <div className="bg-gray-900 rounded p-4 max-h-96 overflow-y-auto space-y-2">
                  {chapterVerses.map((verse, idx) => (
                    <div
                      key={idx}
                      className="group hover:bg-gray-800 p-3 rounded cursor-pointer transition-colors"
                      onMouseEnter={() => setPreviewVerse(verse)}
                      onMouseLeave={() => setPreviewVerse(null)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <span className="font-bold text-blue-400 mr-2">{verse.verse}.</span>
                          <span className="text-sm text-gray-300">{verse.text}</span>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              showVerseOnPresenter(verse);
                            }}
                            className="px-2 py-1 bg-blue-600 rounded hover:bg-blue-700 text-xs flex items-center gap-1"
                            title="Show on presenter"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              addVerseToPresentation(verse);
                            }}
                            className="px-2 py-1 bg-green-600 rounded hover:bg-green-700 text-xs flex items-center gap-1"
                            title="Add to queue"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Preview Panel */}
            {previewVerse && (
              <div className="mt-4 p-4 bg-gray-700 rounded">
                <div className="flex justify-between items-start mb-2">
                  <h4 className="font-bold text-blue-400">{previewVerse.reference}</h4>
                  <Eye size={16} className="text-gray-400" />
                </div>
                <p className="text-sm text-gray-200">{previewVerse.text}</p>
              </div>
            )}
          </div>
        )}

        {/* Live Transcription Panel */}
        {isListening && (
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2">
                <Radio size={20} className="text-red-500 animate-pulse" />
                Live Transcription
              </h2>
              <div className="flex gap-2 items-center">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={autoDisplay}
                    onChange={(e) => setAutoDisplay(e.target.checked)}
                    className="rounded"
                  />
                  Auto-display verses
                </label>
                <button
                  onClick={clearTranscription}
                  className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-sm"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="bg-gray-900 p-4 rounded mb-3 min-h-24 max-h-48 overflow-y-auto">
              <p className="text-gray-300 text-sm">
                {transcription || 'Listening for pastor\'s voice...'}
              </p>
            </div>

            {detectedReferences.length > 0 && (
              <div className="bg-gray-700 p-3 rounded">
                <h3 className="text-sm font-bold mb-2">Detected References:</h3>
                <div className="flex flex-wrap gap-2">
                  {detectedReferences.map((ref, idx) => (
                    <span key={idx} className="px-2 py-1 bg-blue-600 rounded text-xs">
                      {ref}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bible Search Panel */}
        {showSearch && (
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg sm:text-xl font-bold flex items-center gap-2">
                <BookOpen size={20} />
                Search Bible
              </h2>
              <button onClick={() => setShowSearch(false)} className="sm:hidden">
                <X size={24} />
              </button>
            </div>

            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setSearchMode('semantic')}
                className={`flex-1 px-4 py-2 rounded-lg flex items-center justify-center gap-2 text-sm ${searchMode === 'semantic'
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
              >
                <Sparkles size={18} />
                Semantic Search
              </button>
              <button
                onClick={() => setSearchMode('direct')}
                className={`flex-1 px-4 py-2 rounded-lg flex items-center justify-center gap-2 text-sm ${searchMode === 'direct'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
              >
                <Search size={18} />
                Direct Reference
              </button>
            </div>

            <div className="mb-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder={
                    searchMode === 'semantic'
                      ? 'e.g., "God\'s love" or "faith and works"'
                      : 'e.g., "John 3:16" or "Psalms 23"'
                  }
                  className="flex-1 px-4 py-3 bg-gray-700 rounded text-white text-sm sm:text-base"
                />
                <button
                  onClick={handleSearch}
                  disabled={isSearching}
                  className="px-4 py-3 bg-purple-600 rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSearching ? '...' : <Search size={20} />}
                </button>
              </div>
              <div className="mt-2 text-xs sm:text-sm text-gray-400">
                {searchMode === 'semantic' ? (
                  <>💡 <strong>Semantic:</strong> Search by meaning - "in the beginning was the word", "love your enemies"</>
                ) : (
                  <>💡 <strong>Direct:</strong> Search by reference - "John 3:16", "Genesis 1:1-5", "Psalms 23"</>
                )}
              </div>
            </div>

            {searchResults.length > 0 && (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-sm sm:text-base">
                    Results ({searchResults.length})
                    {searchMode === 'semantic' && ' - Sorted by relevance'}
                  </h3>
                  {searchResults.length > 1 && (
                    <button
                      onClick={addMultipleVerses}
                      className="px-3 py-1 bg-green-600 rounded hover:bg-green-700 text-xs sm:text-sm"
                    >
                      Add All {searchResults.length} Verses
                    </button>
                  )}
                </div>

                <div className="max-h-96 overflow-y-auto space-y-2">
                  {searchResults.map((result, index) => (
                    <div key={index} className="bg-gray-700 rounded p-3 sm:p-4">
                      <div className="flex justify-between items-start gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <div className="font-bold text-sm sm:text-base text-blue-400">
                            {result.reference}
                          </div>
                          {result.score && (
                            <span className="text-xs text-gray-400">
                              ({(result.score * 100).toFixed(0)}% match)
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => addVerseFromSearch(result)}
                          className="px-2 py-1 bg-green-600 rounded hover:bg-green-700 text-xs sm:text-sm whitespace-nowrap"
                        >
                          + Add
                        </button>
                      </div>
                      <div className="text-gray-300 text-xs sm:text-sm">{result.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg sm:text-xl font-bold">Display Settings</h2>
              <button onClick={() => setShowSettings(false)} className="sm:hidden">
                <X size={24} />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block mb-2 text-sm sm:text-base">Background Color</label>
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  className="w-full h-10 rounded cursor-pointer"
                />
              </div>
              <div>
                <label className="block mb-2 text-sm sm:text-base">Text Color</label>
                <input
                  type="color"
                  value={textColor}
                  onChange={(e) => setTextColor(e.target.value)}
                  className="w-full h-10 rounded cursor-pointer"
                />
              </div>
              <div>
                <label className="block mb-2 text-sm sm:text-base">Font Size: {fontSize}px</label>
                <input
                  type="range"
                  min="24"
                  max="96"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
            <div className="mt-4">
              <label className="block mb-2 text-sm sm:text-base">Backend API URL</label>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="http://localhost:8000"
                className="w-full px-3 py-2 bg-gray-700 rounded text-white text-sm"
              />
            </div>
          </div>
        )}

        {/* Control Panel */}
        <div className="bg-gray-800 rounded-lg p-4 sm:p-6 mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-0 mb-4">
            <h2 className="text-lg sm:text-xl font-bold">Control Panel</h2>
            <div className="flex gap-2 w-full sm:w-auto">
              <button
                onClick={prevVerse}
                disabled={currentIndex === 0}
                className="flex-1 sm:flex-none px-3 py-2 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
              >
                ← Previous
              </button>
              <button
                onClick={nextVerse}
                disabled={currentIndex === verses.length - 1}
                className="flex-1 sm:flex-none px-3 py-2 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
              >
                Next →
              </button>
            </div>
          </div>
          <div className="text-xs sm:text-sm text-gray-400 mb-2">
            Current: {currentIndex + 1} of {verses.length}
          </div>
          {verses[currentIndex] && (
            <div className="bg-gray-900 p-3 sm:p-4 rounded">
              <div className="font-bold text-base sm:text-lg mb-2">{verses[currentIndex].reference}</div>
              <div className="text-gray-300 text-sm sm:text-base">{verses[currentIndex].text}</div>
            </div>
          )}
        </div>

        {/* Verse List */}
        <div className="bg-gray-800 rounded-lg p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
            <h2 className="text-lg sm:text-xl font-bold">Verse List</h2>
            <button
              onClick={addVerse}
              className="w-full sm:w-auto px-4 py-2 bg-green-600 rounded-lg hover:bg-green-700 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <Plus size={18} className="sm:w-5 sm:h-5" />
              Add Blank Verse
            </button>
          </div>

          <div className="space-y-4">
            {verses.map((verse, index) => (
              <div key={verse.id} className={`bg-gray-700 rounded-lg p-3 sm:p-4 ${currentIndex === index ? 'ring-2 ring-blue-500' : ''}`}>
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mb-3">
                  <button
                    onClick={() => goToVerse(index)}
                    className="sm:flex-none px-3 py-2 bg-blue-600 rounded hover:bg-blue-700 flex items-center justify-center gap-1 text-sm"
                  >
                    <Play size={16} />
                    Show
                  </button>
                  <input
                    type="text"
                    placeholder="Reference (e.g., John 3:16)"
                    value={verse.reference}
                    onChange={(e) => updateVerse(verse.id, 'reference', e.target.value)}
                    className="flex-1 px-3 py-2 bg-gray-600 rounded text-white text-sm sm:text-base"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => moveVerse(index, -1)}
                      disabled={index === 0}
                      className="flex-1 sm:flex-none px-2 py-2 bg-gray-600 rounded hover:bg-gray-500 disabled:opacity-50"
                    >
                      <ArrowUp size={18} className="sm:w-5 sm:h-5" />
                    </button>
                    <button
                      onClick={() => moveVerse(index, 1)}
                      disabled={index === verses.length - 1}
                      className="flex-1 sm:flex-none px-2 py-2 bg-gray-600 rounded hover:bg-gray-500 disabled:opacity-50"
                    >
                      <ArrowDown size={18} className="sm:w-5 sm:h-5" />
                    </button>
                    <button
                      onClick={() => deleteVerse(verse.id)}
                      className="flex-1 sm:flex-none px-2 py-2 bg-red-600 rounded hover:bg-red-700"
                    >
                      <Trash2 size={18} className="sm:w-5 sm:h-5" />
                    </button>
                  </div>
                </div>
                <textarea
                  placeholder="Verse text"
                  value={verse.text}
                  onChange={(e) => updateVerse(verse.id, 'text', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 rounded text-white resize-none text-sm sm:text-base"
                  rows={3}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BiblePresenter;