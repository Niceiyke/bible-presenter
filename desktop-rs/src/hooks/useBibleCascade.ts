import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

export function useBibleCascade() {
  const {
    label,
    bibleVersion,
    availableVersions,
    selectedBook, setSelectedBook,
    selectedChapter, setSelectedChapter,
    setBooks, setChapters, setVerses,
    setAudioError
  } = useAppStore();

  // isOperator: only operator windows load Bible data.
  // isReady: don't fire until useAppInitialization has confirmed the backend is up
  //          (availableVersions is populated only after get_bible_versions succeeds).
  const isOperator = label === "main" || label === "design";
  const isReady = isOperator && availableVersions.length > 0;

  // 1. Version change -> Load Books
  useEffect(() => {
    if (!isReady) return;
    invoke("set_bible_version", { version: bibleVersion }).catch(() => {});
    invoke("get_books", { version: bibleVersion })
      .then((b: any) => {
        setBooks(b);
        setSelectedBook((prev: string) => (b.includes(prev) ? prev : (b.length > 0 ? b[0] : "")));
      })
      .catch((err: any) => setAudioError(`Failed to load books: ${err}`));
  }, [bibleVersion, isReady, setBooks, setSelectedBook, setAudioError]);

  // 2. Book change -> Load Chapters
  useEffect(() => {
    if (!isReady || !selectedBook) return;
    invoke("get_chapters", { book: selectedBook, version: bibleVersion })
      .then((c: any) => {
        setChapters(c);
        setSelectedChapter(c.length > 0 ? (c.includes(selectedChapter) ? selectedChapter : c[0]) : 0);
      })
      .catch((err: any) => setAudioError(`Failed to load chapters: ${err}`));
  }, [selectedBook, bibleVersion, isReady, setChapters, setSelectedChapter, setAudioError, selectedChapter]);

  // 3. Chapter change -> Load Verses count
  useEffect(() => {
    if (!isReady || !selectedBook || !selectedChapter) return;
    invoke("get_verses_count", { book: selectedBook, chapter: selectedChapter, version: bibleVersion })
      .then((v: any) => {
        setVerses(v);
      })
      .catch((err: any) => setAudioError(`Failed to load verses: ${err}`));
  }, [selectedBook, selectedChapter, bibleVersion, isReady, setVerses, setAudioError]);
}
