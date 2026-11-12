use crate::scripture_catalog::{alias_map_for_books, resolve_book_name};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::collections::HashMap;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use regex::{Regex, RegexSet};
use std::fs::OpenOptions;
use std::io::Write;
use tauri::{Emitter, Manager};

pub mod media_schedule;
pub mod data_db;
pub use media_schedule::*;
/// Classified data-database open failure (corrupt vs everything else), re-exported
/// so `main.rs` can decide whether quarantine/recovery is appropriate.
pub use data_db::OpenError as DataDbOpenError;

#[derive(Clone, Serialize)]
pub struct SystemLog {
    pub level: String,
    pub message: String,
    pub timestamp: u64,
}

pub fn log_msg<M: Manager<tauri::Wry> + Emitter<tauri::Wry>>(manager: &M, message: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let log = SystemLog {
        level: "info".to_string(),
        message: message.to_string(),
        timestamp,
    };

    let _ = manager.emit("system-log", &log);

    if let Ok(path) = manager.path().app_log_dir() {
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }
        let log_file = path.join("app.log");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
            let _ = writeln!(file, "[{}] {}", timestamp, message);
        }
    }
}

const STOP_WORDS: &[&str] = &[
    "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
    "from","is","was","are","were","be","been","have","has","had","do","does",
    "did","will","would","could","should","may","might","shall","can","not","no",
    "it","its","this","that","my","your","his","her","our","their","who","what",
    "which","he","she","they","we","i","you","me","him","us","them",
];

/// Lowercases a query token and strips punctuation, returning None if nothing remains.
fn clean_token(word: &str) -> Option<String> {
    let sanitized: String = word.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    if sanitized.is_empty() { None } else { Some(sanitized) }
}

pub(crate) static RE_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)").unwrap()
});

pub(crate) static RE_RANGE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)\s*-\s*(\d+)").unwrap()
});

static RE_CHAP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)").unwrap()
});

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Verse {
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
    pub text: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_splits: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResponse {
    pub results: Vec<Verse>,
    pub method: String,
}

#[derive(Debug, Clone)]
pub struct SemanticCorpusVerse {
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
    /// Text from one installed English translation for this canonical
    /// reference. Embedding a single translation keeps the document in one
    /// language register and under the model's token limit; each supported
    /// translation gets its own semantic index.
    pub text: String,
}

pub struct BibleStore {
    conn: Arc<Mutex<Connection>>,
    _patterns: RegexSet,
    book_map: HashMap<String, String>,
    books: Vec<String>,
    available_versions: Vec<String>,
    active_version: Mutex<String>,
    /// Path of the Bible database file. Empty for the in-memory placeholder.
    /// Used to open a SEPARATE connection for the background FTS rebuild so the
    /// shared connection stays available for reads while the index builds.
    db_path: String,
    /// Set once the FTS5 search index is built and in sync with the source
    /// table. The rebuild is deliberately performed OFF the UI thread at
    /// startup so a fresh install never freezes while the index is built
    /// (the build is a large write that also drives -wal/-shm growth).
    search_index_ready: AtomicBool,
}

impl BibleStore {
    pub fn new_empty(app: &tauri::AppHandle) -> anyhow::Result<Self> {
        log_msg(app, "BibleStore: Initializing in empty mode (waiting for database download).");
        let conn = Connection::open_in_memory()
            .map_err(|e| anyhow::anyhow!("Failed to create in-memory Bible DB: {e}"))?;
        let patterns = RegexSet::new([
            r"(?i)\b([1-3]?\s*[a-z]+)\s+(\d+):(\d+)\b",
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)",
        ]).map_err(|e| anyhow::anyhow!("Failed to compile Bible reference patterns: {e}"))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            _patterns: patterns,
            book_map: HashMap::new(),
            books: Vec::new(),
            available_versions: Vec::new(),
            active_version: Mutex::new("KJV".to_string()),
            db_path: String::new(),
            search_index_ready: AtomicBool::new(true), // nothing to index
        })
    }

    pub fn new(app: &tauri::AppHandle, db_path: &str) -> anyhow::Result<Self> {
        Self::open_inner(Some(app), db_path)
    }

    /// Test-only opener used by the semantic probe fixture builder, which has
    /// no Tauri app handle to log through.
    #[cfg(test)]
    pub fn open_for_tests(db_path: &std::path::Path) -> anyhow::Result<Self> {
        Self::open_inner(None, &db_path.to_string_lossy())
    }

    fn open_inner(app: Option<&tauri::AppHandle>, db_path: &str) -> anyhow::Result<Self> {
        if !std::path::Path::new(db_path).exists() {
            return Err(anyhow::anyhow!("Bible database not found at {}", db_path));
        }
        let conn = Connection::open(db_path)?;

        if let Err(e) = conn.execute("PRAGMA journal_mode=WAL", []) {
            if let Some(app) = app {
                log_msg(app, &format!("Warning: Could not set WAL mode: {}", e));
            }
        }

        const CURRENT_SCHEMA_VERSION: u32 = 2;
        let schema_version: u32 = conn.query_row(
            "PRAGMA user_version", [], |r| r.get(0)
        ).unwrap_or(0);
        if schema_version < CURRENT_SCHEMA_VERSION {
            // Drop the old FTS index so it is recreated below with the improved tokenizer/stemming.
            if schema_version < 2 {
                let _ = conn.execute_batch("DROP TABLE IF EXISTS wordlyte_bible_fts;");
            }
            conn.execute_batch(&format!("PRAGMA user_version = {}", CURRENT_SCHEMA_VERSION))?;
            if let Some(app) = app {
                log_msg(app, &format!("BibleStore: schema migrated to version {}", CURRENT_SCHEMA_VERSION));
            }
        }

        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS wordlyte_bible_fts USING fts5(
            title,
            text,
            version,
            content='wordlyte_bible',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2 porter'
        )", [])?;

        // NOTE: the FTS index is deliberately NOT rebuilt here. A fresh-install
        // rebuild is a large write that freezes startup (and drives -wal/-shm
        // growth). `main.rs` spawns `rebuild_fts_if_needed` on a background
        // thread after the window opens; until it completes, search falls back
        // to the LIKE scan.

        let books: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT title FROM wordlyte_bible ORDER BY title")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let available_versions: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT version FROM wordlyte_bible WHERE language = 'EN' ORDER BY version"
            )?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        if let Some(app) = app {
            log_msg(app, &format!("BibleStore: Available versions: {:?}", available_versions));
        }

        let default_version = available_versions.first().cloned().unwrap_or_else(|| "KJV".to_string());

        let book_map = alias_map_for_books(&books);

        let patterns = RegexSet::new([
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)",
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)",
        ])?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            _patterns: patterns,
            book_map,
            books,
            available_versions,
            active_version: Mutex::new(default_version),
            db_path: db_path.to_string(),
            search_index_ready: AtomicBool::new(false),
        })
    }

    /// True once the FTS5 index is built and in sync. Search callers can use
    /// this to report/degrade gracefully while the index is being built.
    pub fn fts_search_ready(&self) -> bool {
        self.search_index_ready.load(Ordering::SeqCst)
    }

    /// (Re)builds the full-text index when it is missing or stale relative to
    /// the source table. Runs on a background thread (see main.rs); the
    /// `search-index-status` event reports `indexing` / `ready`. It opens a
    /// DEDICATED connection so the shared read connection is never blocked —
    /// searches keep working (via the LIKE fallback) while the index builds.
    /// Afterwards the WAL is checkpointed (TRUNCATE) so the `-wal`/`-shm`
    /// sidecars shrink instead of lingering after the large build write.
    pub fn rebuild_fts_if_needed(&self, app: &tauri::AppHandle) {
        if self.db_path.is_empty() {
            // In-memory placeholder (no Bible DB yet) — nothing to index.
            self.search_index_ready.store(true, Ordering::SeqCst);
            return;
        }

        let needs = {
            let conn = self.conn.lock();
            let count_fts: i64 = conn
                .query_row("SELECT count(*) FROM wordlyte_bible_fts", [], |r| r.get(0))
                .unwrap_or(0);
            let count_src: i64 = conn
                .query_row(
                    "SELECT count(*) FROM wordlyte_bible WHERE language = 'EN' AND text IS NOT NULL AND text != ''",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            count_fts != count_src || count_fts == 0
        };

        if !needs {
            self.search_index_ready.store(true, Ordering::SeqCst);
            return;
        }

        log_msg(app, "BibleStore: Rebuilding FTS5 search index in the background...");
        let _ = app.emit("search-index-status", serde_json::json!({ "state": "indexing" }));

        // Dedicated connection: the shared `self.conn` stays available to
        // search readers while the (potentially slow) build holds this one.
        let rebuild_result = Connection::open(&self.db_path)
            .map_err(|e| e.to_string())
            .and_then(|conn| {
                conn.execute("INSERT INTO wordlyte_bible_fts(wordlyte_bible_fts) VALUES('rebuild')", [])
                    .map(|_| conn)
                    .map_err(|e| e.to_string())
            });
        match rebuild_result {
            Ok(conn) => {
                // Best-effort: fold the large build write back into the main DB
                // so the -wal/-shm sidecars are truncated rather than left
                // growing. A busy checkpoint (reader in flight) is harmless.
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                self.search_index_ready.store(true, Ordering::SeqCst);
                log_msg(app, "BibleStore: FTS5 search index ready.");
                let _ = app.emit("search-index-status", serde_json::json!({ "state": "ready" }));
            }
            Err(e) => {
                log_msg(app, &format!("BibleStore: FTS5 index rebuild failed: {e}"));
            }
        }
    }

    pub fn get_available_versions(&self) -> Vec<String> {
        self.available_versions.clone()
    }

    /// Returns one deterministic record per canonical English Bible verse.
    /// Translation text is ordered by version before aggregation so the
    /// semantic-index fingerprint remains stable across launches.
    /// Semantic corpus for one installed translation. Supported versions are
    /// indexed separately so retrieval compares the spoken paraphrase against
    /// the same register it was spoken in, and the rendered verse text can
    /// come from the version the operator is projecting.
    pub fn semantic_corpus(&self, version: &str) -> anyhow::Result<Vec<SemanticCorpusVerse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT title, chapter, verse, text
             FROM wordlyte_bible
             WHERE language = 'EN' AND version = ?1
               AND text IS NOT NULL AND text != ''
             ORDER BY book, chapter, verse"
        )?;
        let rows = stmt.query_map(params![version], |row| {
            Ok(SemanticCorpusVerse {
                book: row.get(0)?,
                chapter: row.get(1)?,
                verse: row.get(2)?,
                text: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_active_version(&self) -> String {
        self.active_version.lock().clone()
    }

    pub fn set_active_version(&self, app: &tauri::AppHandle, version: &str) {
        *self.active_version.lock() = version.to_string();
        log_msg(app, &format!("BibleStore: Active version set to {}", version));
    }

    fn normalize_book(&self, raw: &str) -> String {
        resolve_book_name(raw, &self.books).unwrap_or_else(|| raw.trim().to_string())
    }

    pub fn detect_verses_by_ref(&self, text: &str, version: &str) -> Vec<Verse> {
        let text_lower = text.to_lowercase();

        // Range ("John 3:16-18") must be checked before the single-verse regex,
        // since RE_FULL would otherwise capture it and return only verse 16.
        if let Some(caps) = RE_RANGE.captures(&text_lower) {
            let book = self.normalize_book(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
            if self.books.contains(&book) {
                if let Ok(chapter) = caps.get(2).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                    if let (Ok(from), Ok(to)) = (
                        caps.get(3).map(|m| m.as_str()).unwrap_or("").parse::<i32>(),
                        caps.get(4).map(|m| m.as_str()).unwrap_or("").parse::<i32>(),
                    ) {
                        if to >= from {
                            let mut out = Vec::new();
                            for v in from..=to {
                                if let Ok(Some(v)) = self.get_verse(&book, chapter, v, version) {
                                    out.push(v);
                                }
                            }
                            if !out.is_empty() {
                                return out;
                            }
                        }
                    }
                }
            }
        }

        if let Some(caps) = RE_FULL.captures(&text_lower) {
            let book = self.normalize_book(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
            if self.books.contains(&book) {
                if let Ok(chapter) = caps.get(2).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                    if let Ok(verse) = caps.get(3).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                        if let Ok(Some(v)) = self.get_verse(&book, chapter, verse, version) {
                            return vec![v];
                        }
                    }
                }
            }
        }

        if let Some(caps) = RE_CHAP.captures(&text_lower) {
            let book = self.normalize_book(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
            if self.books.contains(&book) {
                if let Ok(chapter) = caps.get(2).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                    if let Ok(verses) = self.get_chapter_verses(&book, chapter, version) {
                        return verses.into_iter().take(20).collect();
                    }
                }
            }
        }

        Vec::new()
    }

    pub fn detect_verse_by_ref(&self, text: &str, version: &str) -> Option<Verse> {
        self.detect_verses_by_ref(text, version).into_iter().next()
    }

    pub fn get_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, chapter, verse, text FROM wordlyte_bible \
             WHERE title LIKE ?1 AND chapter = ?2 AND verse = ?3 AND version = ?4 LIMIT 1"
        )?;
        let mut rows = stmt.query(params![book, chapter, verse, version])?;
        if let Some(row) = rows.next()? {
            let text: Option<String> = row.get(3)?;
            if let Some(t) = text {
                Ok(Some(Verse {
                    book: row.get(0)?,
                    chapter: row.get(1)?,
                    verse: row.get(2)?,
                    text: t,
                    version: version.to_string(),
                    split_index: None,
                    total_splits: None,
                    score: None,
                }))
            } else {
                Ok(None)
            }
        } else {
            Ok(None)
        }
    }

    /// Loads every verse for one installed English translation. Used to build
    /// the in-memory rare-word quote index when a listening session starts.
    pub fn verses_for_version(&self, version: &str) -> anyhow::Result<Vec<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT title, chapter, verse, text
             FROM wordlyte_bible
             WHERE version = ?1 AND language = 'EN' AND text IS NOT NULL AND text != ''
             ORDER BY book, chapter, verse",
        )?;
        let rows = stmt.query_map(params![version], |row| {
            Ok(Verse {
                book: row.get(0)?,
                chapter: row.get(1)?,
                verse: row.get(2)?,
                text: row.get(3)?,
                version: version.to_string(),
                split_index: None,
                total_splits: None,
                score: None,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_next_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        if let Some(v) = self.get_verse(book, chapter, verse + 1, version)? {
            return Ok(Some(v));
        }
        let first_verse_in_next_chapter: Option<i32> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare_cached(
                "SELECT MIN(verse) FROM wordlyte_bible WHERE title LIKE ?1 AND chapter = ?2 AND version = ?3"
            )?;
            stmt.query_row(params![book, chapter + 1, version], |row| row.get(0))
                .ok()
                .flatten()
        };
        if let Some(fv) = first_verse_in_next_chapter {
            return self.get_verse(book, chapter + 1, fv, version);
        }
        Ok(None)
    }

    pub fn get_prev_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        if verse > 1 {
            if let Some(v) = self.get_verse(book, chapter, verse - 1, version)? {
                return Ok(Some(v));
            }
        }
        if chapter > 1 {
            let last_verse_in_prev_chapter: Option<i32> = {
                let conn = self.conn.lock();
                let mut stmt = conn.prepare_cached(
                    "SELECT MAX(verse) FROM wordlyte_bible WHERE title LIKE ?1 AND chapter = ?2 AND version = ?3"
                )?;
                stmt.query_row(params![book, chapter - 1, version], |row| row.get(0))
                    .ok()
                    .flatten()
            };
            if let Some(lv) = last_verse_in_prev_chapter {
                return self.get_verse(book, chapter - 1, lv, version);
            }
        }
        Ok(None)
    }

    pub fn search_all(&self, query: &str, version: &str) -> anyhow::Result<SearchResponse> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(SearchResponse { results: Vec::new(), method: String::new() });
        }

        let ref_results = self.detect_verses_by_ref(query, version);

        // A clean reference ("John 3:16", "Psalms 23") short-circuits to the reference match.
        // If the query has extra meaningful words beyond the reference ("John 3:16 love"),
        // fall through to keyword search so a reference match never hijacks a phrase query.
        if !ref_results.is_empty() && !self.query_has_extra_words(query) {
            return Ok(SearchResponse { results: ref_results, method: "reference".to_string() });
        }

        // While the FTS index is still being built off-thread, search falls
        // back to the LIKE scan and reports method "like" so the UI can show a
        // degraded-search hint.
        let indexing = !self.fts_search_ready();

        let mut results = self.search_fts_keyword(query, version);

        // Still surface the explicit reference at the top of keyword results.
        if let Some(r) = ref_results.first() {
            if !results.iter().any(|v| v.book == r.book && v.chapter == r.chapter && v.verse == r.verse) {
                results.insert(0, r.clone());
            }
        }

        results.truncate(20);
        Ok(SearchResponse { results, method: if indexing { "like".to_string() } else { "keyword".to_string() } })
    }

    /// Retrieve direct-quotation candidates across every installed English
    /// translation with one bounded query per search tier. AI quote matching
    /// scores the returned text lexically and converts the winning canonical
    /// reference back to the operator-selected translation.
    pub fn search_quote_candidates(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
        self.search_quote_candidates_with_fallback(query, true)
    }

    /// Interim quote lookups stay on the indexed path. The broad LIKE fallback
    /// can scan the complete Bible corpus, so reserve it for finalized turns.
    pub fn search_quote_candidates_fast(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
        self.search_quote_candidates_with_fallback(query, false)
    }

    fn search_quote_candidates_with_fallback(
        &self,
        query: &str,
        allow_like_fallback: bool,
    ) -> anyhow::Result<Vec<Verse>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let tokens: Vec<String> = query.split_whitespace().filter_map(clean_token).collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }

        let escaped = query.replace('"', "\"\"");
        let phrase = format!("\"{}\"", escaped);
        let phrase_hits = self.run_fts_query_all_english(&phrase);
        if !phrase_hits.is_empty() {
            return Ok(phrase_hits);
        }

        let and_terms: Vec<String> = tokens.iter().map(|token| {
            if STOP_WORDS.contains(&token.as_str()) { token.clone() } else { format!("{}*", token) }
        }).collect();
        let and_hits = self.run_fts_query_all_english(&and_terms.join(" AND "));
        if !and_hits.is_empty() {
            return Ok(and_hits);
        }

        let or_terms: Vec<String> = tokens.iter()
            .filter(|token| !STOP_WORDS.contains(&token.as_str()))
            .map(|token| format!("{}*", token))
            .collect();
        if !or_terms.is_empty() {
            let or_hits = self.run_fts_query_all_english(&or_terms.join(" OR "));
            if !or_hits.is_empty() {
                return Ok(or_hits);
            }
        }

        if allow_like_fallback {
            self.like_contiguous_all_english(query)
        } else {
            Ok(Vec::new())
        }
    }

    /// True when the query contains tokens beyond a Bible reference (book words + numbers),
    /// i.e. real search terms. Stop words are ignored.
    fn query_has_extra_words(&self, query: &str) -> bool {
        query.split_whitespace().any(|tok| {
            let base: String = tok.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
            if base.is_empty() { return false; }
            if base.parse::<i32>().is_ok() { return false; }
            if self.book_map.contains_key(&base) { return false; }
            !STOP_WORDS.contains(&base.as_str())
        })
    }

    /// Tiered keyword search: exact phrase -> all terms (AND) -> any term (OR) -> LIKE fallback.
    /// Results carry a normalized bm25 relevance score in `Verse.score` (0..1, higher = better).
    fn search_fts_keyword(&self, query: &str, version: &str) -> Vec<Verse> {
        let tokens: Vec<String> = query.split_whitespace().filter_map(clean_token).collect();
        if tokens.is_empty() {
            return Vec::new();
        }

        // Tier 1: exact phrase match, preserving all words (including stop words).
        let escaped = query.replace('"', "\"\"");
        let phrase = format!("\"{}\"", escaped);
        let phrase_hits = self.run_fts_query(&phrase, version);
        if !phrase_hits.is_empty() {
            return phrase_hits;
        }

        // Tier 2: every token must appear. Stop words are matched exactly (no prefix) to
        // avoid "the*" hitting "them/they/theirs"; content words use a prefix for stemming.
        let and_terms: Vec<String> = tokens.iter().map(|t| {
            if STOP_WORDS.contains(&t.as_str()) { t.clone() } else { format!("{}*", t) }
        }).collect();
        let and_hits = self.run_fts_query(&and_terms.join(" AND "), version);
        if !and_hits.is_empty() {
            return and_hits;
        }

        // Tier 3: any term (stop words dropped to reduce noise).
        let or_terms: Vec<String> = tokens.iter()
            .filter(|t| !STOP_WORDS.contains(&t.as_str()))
            .map(|t| format!("{}*", t))
            .collect();
        if !or_terms.is_empty() {
            let or_hits = self.run_fts_query(&or_terms.join(" OR "), version);
            if !or_hits.is_empty() {
                return or_hits;
            }
        }

        // Final fallback: contiguous substring match via LIKE.
        self.like_contiguous(query, version).unwrap_or_default()
    }

    /// Runs an FTS5 query restricted to `version` and returns verses ordered by bm25
    /// relevance with scores normalized to 0..1.
    fn run_fts_query(&self, match_query: &str, version: &str) -> Vec<Verse> {
        let conn = self.conn.lock();
        let Ok(mut stmt) = conn.prepare_cached(
            "SELECT b.title, b.text, b.version, b.chapter, b.verse,
                    bm25(wordlyte_bible_fts) AS relevance
             FROM wordlyte_bible b
             JOIN wordlyte_bible_fts f ON b.rowid = f.rowid
             WHERE wordlyte_bible_fts MATCH ?1 AND b.version = ?2
             ORDER BY relevance
             LIMIT 200"
        ) else {
            return Vec::new();
        };

        let mut scored: Vec<(Verse, f32)> = Vec::new();
        match stmt.query_map(params![match_query, version], |row| {
            let text: Option<String> = row.get(1)?;
            Ok((
                Verse {
                    book: row.get(0)?,
                    text: text.unwrap_or_default(),
                    version: row.get(2)?,
                    chapter: row.get(3)?,
                    verse: row.get(4)?,
                    split_index: None,
                    total_splits: None,
                    score: None,
                },
                row.get::<_, f32>(5)?,
            ))
        }) {
            Ok(rows) => {
                for x in rows.flatten() {
                    scored.push(x);
                }
            }
            Err(_) => return Vec::new(),
        }

        if scored.is_empty() {
            return Vec::new();
        }

        // FTS5 bm25: lower is better. Normalize so the best hit maps to ~1.0.
        let min = scored.iter().map(|(_, s)| *s).fold(f32::INFINITY, f32::min);
        let max = scored.iter().map(|(_, s)| *s).fold(f32::NEG_INFINITY, f32::max);
        let range = if (max - min).abs() > f32::EPSILON { max - min } else { 1.0 };

        scored.into_iter()
            .map(|(mut v, s)| {
                v.score = Some(1.0 - ((s - min) / range));
                v
            })
            .collect()
    }

    fn run_fts_query_all_english(&self, match_query: &str) -> Vec<Verse> {
        let conn = self.conn.lock();
        let Ok(mut stmt) = conn.prepare_cached(
            "SELECT b.title, b.text, b.version, b.chapter, b.verse,
                    bm25(wordlyte_bible_fts) AS relevance
             FROM wordlyte_bible b
             JOIN wordlyte_bible_fts f ON b.rowid = f.rowid
             WHERE wordlyte_bible_fts MATCH ?1 AND b.language = 'EN'
             ORDER BY relevance
             LIMIT 300"
        ) else {
            return Vec::new();
        };

        let mut scored: Vec<(Verse, f32)> = Vec::new();
        match stmt.query_map(params![match_query], |row| {
            let text: Option<String> = row.get(1)?;
            Ok((
                Verse {
                    book: row.get(0)?,
                    text: text.unwrap_or_default(),
                    version: row.get(2)?,
                    chapter: row.get(3)?,
                    verse: row.get(4)?,
                    split_index: None,
                    total_splits: None,
                    score: None,
                },
                row.get::<_, f32>(5)?,
            ))
        }) {
            Ok(rows) => {
                for row in rows.flatten() {
                    scored.push(row);
                }
            }
            Err(_) => return Vec::new(),
        }
        if scored.is_empty() {
            return Vec::new();
        }

        let min = scored.iter().map(|(_, score)| *score).fold(f32::INFINITY, f32::min);
        let max = scored.iter().map(|(_, score)| *score).fold(f32::NEG_INFINITY, f32::max);
        let range = if (max - min).abs() > f32::EPSILON { max - min } else { 1.0 };
        scored.into_iter().map(|(mut verse, score)| {
            verse.score = Some(1.0 - ((score - min) / range));
            verse
        }).collect()
    }

    /// Contiguous-substring LIKE fallback, restricted to the active version.
    fn like_contiguous(&self, query: &str, version: &str) -> anyhow::Result<Vec<Verse>> {
        let pattern = format!("%{}%", query.trim().replace(' ', "%"));
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, text, version, chapter, verse FROM wordlyte_bible \
             WHERE text LIKE ?1 AND version = ?2 \
             ORDER BY rowid \
             LIMIT 20"
        )?;
        let rows = stmt.query_map(params![pattern, version], |row| {
            let text: Option<String> = row.get(1)?;
            Ok(Verse {
                book: row.get(0)?,
                text: text.unwrap_or_default(),
                version: row.get(2)?,
                chapter: row.get(3)?,
                verse: row.get(4)?,
                split_index: None,
                total_splits: None,
                score: None,
            })
        })?;
        let mut results = Vec::new();
        for v in rows.flatten() {
            results.push(v);
        }
        Ok(results)
    }

    fn like_contiguous_all_english(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
        let pattern = format!("%{}%", query.trim().replace(' ', "%"));
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, text, version, chapter, verse FROM wordlyte_bible \
             WHERE text LIKE ?1 AND language = 'EN' \
             ORDER BY rowid \
             LIMIT 100"
        )?;
        let rows = stmt.query_map(params![pattern], |row| {
            let text: Option<String> = row.get(1)?;
            Ok(Verse {
                book: row.get(0)?,
                text: text.unwrap_or_default(),
                version: row.get(2)?,
                chapter: row.get(3)?,
                verse: row.get(4)?,
                split_index: None,
                total_splits: None,
                score: None,
            })
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    pub fn get_books(&self, version: &str) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT title FROM wordlyte_bible WHERE version = ?1 AND language = 'EN' ORDER BY book"
        )?;
        let rows = stmt.query_map(params![version], |row| row.get(0))?;
        let mut books = Vec::new();
        for book in rows {
            books.push(book?);
        }
        Ok(books)
    }

    pub fn get_chapters(&self, book: &str, version: &str) -> anyhow::Result<Vec<i32>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT chapter FROM wordlyte_bible WHERE title = ?1 AND version = ?2 ORDER BY chapter"
        )?;
        let rows = stmt.query_map(params![book, version], |row| row.get(0))?;
        let mut chapters = Vec::new();
        for chap in rows {
            chapters.push(chap?);
        }
        Ok(chapters)
    }

    pub fn get_verses_count(&self, book: &str, chapter: i32, version: &str) -> anyhow::Result<Vec<i32>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT verse FROM wordlyte_bible WHERE title = ?1 AND chapter = ?2 AND version = ?3 ORDER BY verse"
        )?;
        let rows = stmt.query_map(params![book, chapter, version], |row| row.get(0))?;
        let mut verses = Vec::new();
        for v in rows {
            verses.push(v?);
        }
        Ok(verses)
    }

    pub fn get_chapter_verses(&self, book: &str, chapter: i32, version: &str) -> anyhow::Result<Vec<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, chapter, verse, text FROM wordlyte_bible \
             WHERE title = ?1 AND chapter = ?2 AND version = ?3 ORDER BY verse"
        )?;
        let rows = stmt.query_map(params![book, chapter, version], |row| {
            Ok(Verse {
                book: row.get(0)?,
                chapter: row.get(1)?,
                verse: row.get(2)?,
                text: row.get(3)?,
                version: version.to_string(),
                split_index: None,
                total_splits: None,
                score: None,
            })
        })?;
        let mut verses = Vec::new();
        for v in rows {
            verses.push(v?);
        }
        Ok(verses)
    }
}
