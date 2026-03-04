use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::collections::HashMap;
use parking_lot::Mutex;
use once_cell::sync::Lazy;
use regex::{Regex, RegexSet};
use std::fs::File;
use hnsw_rs::prelude::*;
use memmap2::Mmap;

pub mod media_schedule;
pub use media_schedule::*;

const STOP_WORDS: &[&str] = &[
    "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
    "from","is","was","are","were","be","been","have","has","had","do","does",
    "did","will","would","could","should","may","might","shall","can","not","no",
    "it","its","this","that","my","your","his","her","our","their","who","what",
    "which","he","she","they","we","i","you","me","him","us","them",
];

static RE_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)").unwrap()
});

static RE_CHAP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)").unwrap()
});

/// Ordered list of versions embedded into all_versions_embeddings.npy.
/// Must match the order used in scripts/generate_embeddings.py.
pub const EMBEDDED_VERSIONS: &[&str] = &["KJV", "AMP", "NIV", "ESV", "NKJV", "NASB"];

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

/// A compact version of Verse for memory-efficient caching.
/// Only 6 bytes per verse: (u16 book_idx, u16 chapter, u16 verse, u8 version_idx)
#[derive(Clone)]
pub struct CachedVerse {
    pub book_idx: u16,
    pub chapter: u16,
    pub verse: u16,
    pub version_idx: u8,
}

pub struct BibleStore {
    conn: Arc<Mutex<Connection>>,
    _patterns: RegexSet,
    book_map: HashMap<String, String>,
    /// All books found in the DB, for indexing CachedVerse.
    books: Vec<String>,
    /// All available versions found in the DB, for indexing CachedVerse.
    available_versions: Vec<String>,
    /// All verses from all embedded versions, stacked in EMBEDDED_VERSIONS order.
    /// verse_cache[i] corresponds to row i in the HNSW index.
    verse_cache: Vec<CachedVerse>,
    /// Memory-mapped embeddings file.
    _mmap: Option<Mmap>,
    /// HNSW index for fast semantic search (L2 distance on normalized embeddings).
    hnsw_index: Option<Hnsw<'static, f32, DistL2>>,
    /// Currently active version for display queries.
    active_version: Mutex<String>,
    /// Minimum cosine similarity score for a semantic match to be accepted (default 0.55).
    confidence_threshold: Mutex<f32>,
    /// Whether semantic search index (HNSW) was successfully loaded.
    embeddings_loaded: bool,
}

impl BibleStore {
    pub fn new(app: &tauri::AppHandle, db_path: &str, embeddings_path: Option<&str>) -> anyhow::Result<Self> {
        let conn = Connection::open(db_path)?;

        if let Err(e) = conn.execute("PRAGMA journal_mode=WAL", []) {
            eprintln!("Warning: Could not set WAL mode: {}", e);
        }

        // Schema versioning — bump CURRENT_SCHEMA_VERSION when the schema changes
        const CURRENT_SCHEMA_VERSION: u32 = 1;
        let schema_version: u32 = conn.query_row(
            "PRAGMA user_version", [], |r| r.get(0)
        ).unwrap_or(0);
        if schema_version < CURRENT_SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version = {}", CURRENT_SCHEMA_VERSION))?;
            println!("BibleStore: schema migrated to version {}", CURRENT_SCHEMA_VERSION);
        }

        // Initialize FTS5 virtual table for lightning-fast keyword search
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS super_bible_fts USING fts5(
            title, 
            text, 
            version, 
            content='super_bible', 
            content_rowid='rowid'
        )", [])?;
        
        // Populate FTS if it's empty (trigger sync)
        let count_fts: i64 = conn.query_row("SELECT count(*) FROM super_bible_fts", [], |r| r.get(0))?;
        if count_fts == 0 {
            println!("BibleStore: Initializing FTS5 index...");
            conn.execute("INSERT INTO super_bible_fts(rowid, title, text, version) 
                         SELECT rowid, title, text, version FROM super_bible 
                         WHERE language = 'EN' AND text IS NOT NULL AND text != ''", [])?;
        }

        // Discover all books across all versions
        let books: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT title FROM super_bible ORDER BY title")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Discover which versions are in the DB
        let mut available_versions: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT version FROM super_bible WHERE language = 'EN' ORDER BY version"
            )?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        // Put EMBEDDED_VERSIONS first (in order), then any extras
        available_versions.sort_by_key(|v| {
            EMBEDDED_VERSIONS.iter().position(|e| *e == v.as_str()).unwrap_or(usize::MAX)
        });
        println!("BibleStore: Available versions: {:?}", available_versions);

        // Pre-load verse_cache for every version (in specific order to match embeddings)
        let mut verse_cache: Vec<CachedVerse> = Vec::new();
        for (v_idx, version) in available_versions.iter().enumerate() {
            let mut stmt = conn.prepare(
                "SELECT title, chapter, verse FROM super_bible \
                 WHERE version = ?1 AND language = 'EN' AND text IS NOT NULL AND text != '' \
                 ORDER BY book, chapter, verse"
            )?;
            let rows = stmt.query_map(params![version], |row| {
                let book: String = row.get(0)?;
                let book_idx = books.iter().position(|b| b == &book).unwrap_or(0) as u16;
                Ok(CachedVerse {
                    book_idx,
                    chapter: row.get::<_, i32>(1)? as u16,
                    verse: row.get::<_, i32>(2)? as u16,
                    version_idx: v_idx as u8,
                })
            })?;
            for row in rows {
                verse_cache.push(row?);
            }
        }
        println!("BibleStore: Total cached verses: {}", verse_cache.len());

        // Load stacked embeddings into HNSW index (Memory-Mapped)
        let mut hnsw_index = None;
        let mut _mmap = None;
        if let Some(path) = embeddings_path {
            match File::open(path) {
                Ok(file) => {
                    match unsafe { Mmap::map(&file) } {
                        Ok(m) => {
                            // Simple NPY header parsing to find data offset
                            let header_len_raw = &m[8..10];
                            let header_len = u16::from_le_bytes([header_len_raw[0], header_len_raw[1]]) as usize;
                            let data_offset = 10 + header_len;
                            
                            // Get pointer to raw f32 data
                            let byte_slice = &m[data_offset..];
                            let f32_count = byte_slice.len() / 4;
                            
                            let n_rows = verse_cache.len();
                            let n_dims = 384;
                            
                            if f32_count < n_rows * n_dims {
                                let msg = format!("CRITICAL: Embedding file size mismatch (found {} floats, expected {}). Semantic search disabled.", f32_count, n_rows * n_dims);
                                eprintln!("{}", msg);
                                // Emit a raw event since we don't have log_msg here
                                let _ = app.emit("system-log", serde_json::json!({
                                    "level": "error",
                                    "message": msg,
                                    "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
                                }));
                            } else {
                                println!("BibleStore: Building HNSW index from MMap'd data ({} rows, {} dims)", n_rows, n_dims);
                                
                                // Safely handle alignment by copying to an aligned buffer or using unaligned reads.
                                // ARM systems (Apple Silicon) will SIGBUS if we cast an unaligned byte slice to f32.
                                let f32_data: Vec<f32> = if (byte_slice.as_ptr() as usize) % 4 == 0 {
                                    unsafe { std::slice::from_raw_parts(byte_slice.as_ptr() as *const f32, n_rows * n_dims).to_vec() }
                                } else {
                                    let mut v = Vec::with_capacity(n_rows * n_dims);
                                    unsafe {
                                        for i in 0..(n_rows * n_dims) {
                                            let ptr = byte_slice.as_ptr().add(i * 4);
                                            v.push(std::ptr::read_unaligned(ptr as *const f32));
                                        }
                                    }
                                    v
                                };

                                let max_nb_conn = 16;
                                let max_layer = 16;
                                let ef_construction = 200;
                                let hnsw = Hnsw::new(max_nb_conn, n_rows, max_layer, ef_construction, DistL2 {});
                                
                                // Insert embeddings in parallel
                                let data_to_insert: Vec<(Vec<f32>, usize)> = (0..n_rows)
                                    .map(|i| {
                                        let start = i * n_dims;
                                        let end = start + n_dims;
                                        (f32_data[start..end].to_vec(), i)
                                    })
                                    .collect();
                                let insert_refs: Vec<(&Vec<f32>, usize)> = data_to_insert
                                    .iter()
                                    .map(|(v, id)| (v, *id))
                                    .collect();
                                hnsw.parallel_insert(&insert_refs);
                                hnsw_index = Some(hnsw);
                                _mmap = Some(m);
                            }
                        }
                        Err(e) => eprintln!("Warning: Failed to MMap embeddings: {}", e),
                    }
                },
                Err(e) => eprintln!("Warning: Could not open embeddings at {}: {}", path, e),
            }
        }

        let default_version = EMBEDDED_VERSIONS
            .iter()
            .find(|&&v| available_versions.iter().any(|a| a == v))
            .map(|v| v.to_string())
            .unwrap_or_else(|| available_versions.first().cloned().unwrap_or_else(|| "KJV".to_string()));

        let mut book_map = HashMap::new();
        let alias_books = vec![
            ("genesis", "Genesis"), ("gen", "Genesis"), ("gn", "Genesis"),
            ("exodus", "Exodus"), ("exod", "Exodus"), ("ex", "Exodus"),
            ("leviticus", "Leviticus"), ("lev", "Leviticus"), ("lv", "Leviticus"),
            ("numbers", "Numbers"), ("num", "Numbers"), ("nm", "Numbers"),
            ("deuteronomy", "Deuteronomy"), ("deut", "Deuteronomy"), ("dt", "Deuteronomy"),
            ("joshua", "Joshua"), ("josh", "Joshua"), ("jos", "Joshua"),
            ("judges", "Judges"), ("judg", "Judges"), ("jdg", "Judges"),
            ("ruth", "Ruth"), ("rth", "Ruth"),
            ("1 samuel", "1 Samuel"), ("1samuel", "1 Samuel"), ("1sam", "1 Samuel"), ("1sm", "1 Samuel"),
            ("2 samuel", "2 Samuel"), ("2samuel", "2 Samuel"), ("2sam", "2 Samuel"), ("2sm", "2 Samuel"),
            ("1 kings", "1 Kings"), ("1kings", "1 Kings"), ("1kgs", "1 Kings"), ("1kg", "1 Kings"),
            ("2 kings", "2 Kings"), ("2kings", "2 Kings"), ("2kgs", "2 Kings"), ("2kg", "2 Kings"),
            ("1 chronicles", "1 Chronicles"), ("1chronicles", "1 Chronicles"), ("1chr", "1 Chronicles"),
            ("2 chronicles", "2 Chronicles"), ("2chronicles", "2 Chronicles"), ("2chr", "2 Chronicles"),
            ("ezra", "Ezra"), ("ezr", "Ezra"),
            ("nehemiah", "Nehemiah"), ("neh", "Nehemiah"),
            ("esther", "Esther"), ("esth", "Esther"), ("est", "Esther"),
            ("job", "Job"), ("jb", "Job"),
            ("psalms", "Psalms"), ("psalm", "Psalms"), ("ps", "Psalms"), ("psa", "Psalms"),
            ("proverbs", "Proverbs"), ("prov", "Proverbs"), ("prv", "Proverbs"),
            ("ecclesiastes", "Ecclesiastes"), ("eccl", "Ecclesiastes"), ("ecc", "Ecclesiastes"),
            ("song of solomon", "Song of Solomon"), ("song", "Song of Solomon"), ("sos", "Song of Solomon"),
            ("isaiah", "Isaiah"), ("isa", "Isaiah"), ("is", "Isaiah"),
            ("jeremiah", "Jeremiah"), ("jer", "Jeremiah"),
            ("lamentations", "Lamentations"), ("lam", "Lamentations"),
            ("ezekiel", "Ezekiel"), ("ezek", "Ezekiel"), ("ezk", "Ezekiel"),
            ("daniel", "Daniel"), ("dan", "Daniel"), ("dn", "Daniel"),
            ("hosea", "Hosea"), ("hos", "Hosea"),
            ("joel", "Joel"), ("jl", "Joel"),
            ("amos", "Amos"), ("am", "Amos"),
            ("obadiah", "Obadiah"), ("obad", "Obadiah"), ("ob", "Obadiah"),
            ("jonah", "Jonah"), ("jon", "Jonah"),
            ("micah", "Micah"), ("mic", "Micah"),
            ("nahum", "Nahum"), ("nah", "Nahum"), ("na", "Nahum"),
            ("habakkuk", "Habakkuk"), ("hab", "Habakkuk"),
            ("zephaniah", "Zephaniah"), ("zeph", "Zephaniah"), ("zep", "Zephaniah"),
            ("haggai", "Haggai"), ("hag", "Haggai"),
            ("zechariah", "Zechariah"), ("zech", "Zechariah"), ("zec", "Zechariah"),
            ("malachi", "Malachi"), ("mal", "Malachi"),
            ("matthew", "Matthew"), ("matt", "Matthew"), ("mt", "Matthew"),
            ("mark", "Mark"), ("mrk", "Mark"), ("mk", "Mark"),
            ("luke", "Luke"), ("lk", "Luke"),
            ("john", "John"), ("jn", "John"),
            ("acts", "Acts"), ("act", "Acts"),
            ("romans", "Romans"), ("rom", "Romans"), ("rm", "Romans"),
            ("1 corinthians", "1 Corinthians"), ("1corinthians", "1 Corinthians"), ("1cor", "1 Corinthians"),
            ("2 corinthians", "2 Corinthians"), ("2corinthians", "2 Corinthians"), ("2cor", "2 Corinthians"),
            ("galatians", "Galatians"), ("gal", "Galatians"),
            ("ephesians", "Ephesians"), ("eph", "Ephesians"),
            ("philippians", "Philippians"), ("phil", "Philippians"), ("php", "Philippians"),
            ("colossians", "Colossians"), ("col", "Colossians"),
            ("1 thessalonians", "1 Thessalonians"), ("1thessalonians", "1 Thessalonians"), ("1thess", "1 Thessalonians"),
            ("2 thessalonians", "2 Thessalonians"), ("2thessalonians", "2 Thessalonians"), ("2thess", "2 Thessalonians"),
            ("1 timothy", "1 Timothy"), ("1timothy", "1 Timothy"), ("1tim", "1 Timothy"),
            ("2 timothy", "2 Timothy"), ("2timothy", "2 Timothy"), ("2tim", "2 Timothy"),
            ("titus", "Titus"), ("tit", "Titus"),
            ("philemon", "Philemon"), ("philem", "Philemon"), ("phm", "Philemon"),
            ("hebrews", "Hebrews"), ("heb", "Hebrews"),
            ("james", "James"), ("jas", "James"), ("jm", "James"),
            ("1 peter", "1 Peter"), ("1peter", "1 Peter"), ("1pet", "1 Peter"),
            ("2 peter", "2 Peter"), ("2peter", "2 Peter"), ("2pet", "2 Peter"),
            ("1 john", "1 John"), ("1john", "1 John"), ("1jn", "1 John"),
            ("2 john", "2 John"), ("2john", "2 John"), ("2jn", "2 John"),
            ("3 john", "3 John"), ("3john", "3 John"), ("3jn", "3 John"),
            ("jude", "Jude"), ("jud", "Jude"),
            ("revelation", "Revelation"), ("rev", "Revelation"), ("rv", "Revelation"),
        ];

        for (alias, full) in alias_books {
            book_map.insert(alias.to_string(), full.to_string());
        }

        let patterns = RegexSet::new(&[
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)",
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)",
        ])?;

        let embeddings_loaded = hnsw_index.is_some();

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            _patterns: patterns,
            book_map,
            books,
            available_versions,
            verse_cache,
            _mmap,
            hnsw_index,
            active_version: Mutex::new(default_version),
            confidence_threshold: Mutex::new(0.55),
            embeddings_loaded,
        })
    }

    pub fn is_embeddings_loaded(&self) -> bool {
        self.embeddings_loaded
    }

    pub fn get_available_versions(&self) -> Vec<String> {
        self.available_versions.clone()
    }

    pub fn get_active_version(&self) -> String {
        self.active_version.lock().clone()
    }

    pub fn set_active_version(&self, version: &str) {
        *self.active_version.lock() = version.to_string();
        println!("BibleStore: Active version set to {}", version);
    }

    pub fn set_confidence_threshold(&self, threshold: f32) {
        *self.confidence_threshold.lock() = threshold.clamp(0.0, 1.0);
        println!("BibleStore: Confidence threshold set to {}", threshold);
    }

    fn normalize_book(&self, raw: &str) -> String {
        let clean = raw.to_lowercase().trim().to_string();
        self.book_map.get(&clean).cloned().unwrap_or(raw.to_string())
    }

    /// Returns `(Option<Verse>, confidence)` where confidence is 0.0–1.0.
    /// Regex matches get 1.0; semantic matches get the cosine similarity score.
    pub fn detect_verse_hybrid(&self, text: &str, embedding: Option<Vec<f32>>) -> (Option<Verse>, f32) {
        // 1. Explicit reference regex (e.g. "John 3:16")
        if let Some(verse) = self.detect_verse_by_ref(text) {
            return (Some(verse), 1.0);
        }
        // 2. Semantic search across ALL versions
        if let Some(emb) = embedding {
            let (verse, score) = self.search_semantic_stacked(&emb);
            return (verse, score);
        }
        (None, 0.0)
    }

    /// Detects if a string is a bible reference and returns the matching verses.
    /// If it's a Book Chap:Verse, it returns 1 verse (from active version).
    /// If it's a Book Chap, it returns the first 10 verses of that chapter.
    pub fn detect_verses_by_ref(&self, text: &str) -> Vec<Verse> {
        let text_lower = text.to_lowercase();

        // Try Book Chap:Verse
        if let Some(caps) = RE_FULL.captures(&text_lower) {
            let book = self.normalize_book(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
            if self.books.contains(&book) {
                if let Ok(chapter) = caps.get(2).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                    if let Ok(verse) = caps.get(3).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                        let version = self.get_active_version();
                        if let Ok(Some(v)) = self.get_verse(&book, chapter, verse, &version) {
                            return vec![v];
                        }
                    }
                }
            }
        }

        // Try Book Chap
        if let Some(caps) = RE_CHAP.captures(&text_lower) {
            let book = self.normalize_book(caps.get(1).map(|m| m.as_str()).unwrap_or(""));
            if self.books.contains(&book) {
                if let Ok(chapter) = caps.get(2).map(|m| m.as_str()).unwrap_or("").parse::<i32>() {
                    let version = self.get_active_version();
                    if let Ok(verses) = self.get_chapter_verses(&book, chapter, &version) {
                        return verses.into_iter().take(20).collect();
                    }
                }
            }
        }

        Vec::new()
    }

    pub fn detect_verse_by_ref(&self, text: &str) -> Option<Verse> {
        self.detect_verses_by_ref(text).into_iter().next()
    }

    /// Searches the full stacked embeddings matrix across all embedded versions.
    /// Returns `(Option<Verse>, score)` — the best match and its cosine similarity score.
    fn search_semantic_stacked(&self, embedding: &[f32]) -> (Option<Verse>, f32) {
        let hnsw = match self.hnsw_index.as_ref() {
            Some(h) => h,
            None => return (None, 0.0),
        };

        let search_results = hnsw.search(embedding, 1, 128);
        if search_results.is_empty() {
            return (None, 0.0);
        }

        let neighbor = &search_results[0];
        // hnsw_rs DistL2 returns the *squared* L2 distance (no sqrt).
        // For L2-normalized unit vectors: cos_sim = 1 - d²/2.
        // Clamp to [0,1] — anti-correlated embeddings would give negative values.
        let score = (1.0 - (neighbor.distance as f32) / 2.0).clamp(0.0, 1.0);

        let threshold = *self.confidence_threshold.lock();
        if score < threshold {
            return (None, score);
        }

        let idx = neighbor.d_id;
        if let Some(matched) = self.verse_cache.get(idx) {
            let book = &self.books[matched.book_idx as usize];
            let version = &self.available_versions[matched.version_idx as usize];
            let active_version = self.get_active_version();

            // Look up the same (book, chapter, verse) in the active display version
            let verse = self.get_verse(book, matched.chapter as i32, matched.verse as i32, &active_version)
                .ok()
                .flatten()
                .or_else(|| self.get_verse(book, matched.chapter as i32, matched.verse as i32, version).ok().flatten());
            
            return (verse, score);
        }
        (None, 0.0)
    }

    pub fn get_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, chapter, verse, text FROM super_bible \
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
                Ok(None) // skip verses with NULL text
            }
        } else {
            Ok(None)
        }
    }

    pub fn get_next_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        if let Some(v) = self.get_verse(book, chapter, verse + 1, version)? {
            return Ok(Some(v));
        }
        let first_verse_in_next_chapter: Option<i32> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare_cached(
                "SELECT MIN(verse) FROM super_bible WHERE title LIKE ?1 AND chapter = ?2 AND version = ?3"
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

    /// Semantic search across ALL stacked versions using HNSW index.
    /// Returns top-N unique (book,chapter,verse) results.
    /// Prefers the active version for the displayed text.
    pub fn search_top_n_semantic(&self, embedding: &[f32], top_n: usize) -> Vec<Verse> {
        let hnsw = match self.hnsw_index.as_ref() {
            Some(h) => h,
            None => return Vec::new(),
        };

        // Search HNSW for top results (using slightly more than top_n to allow deduplication)
        let search_results = hnsw.search(embedding, top_n * 2, 128);
        
        let active_version = self.get_active_version();
        let mut seen = std::collections::HashSet::new();
        let mut results = Vec::new();

        for neighbor in search_results {
            if results.len() >= top_n {
                break;
            }
            let idx = neighbor.d_id;
            let score = (1.0 - (neighbor.distance as f32) / 2.0).clamp(0.0, 1.0);

            if let Some(matched) = self.verse_cache.get(idx) {
                let book = &self.books[matched.book_idx as usize];
                let key = (matched.book_idx, matched.chapter, matched.verse);
                if seen.insert(key) {
                    // 1. Try to get this verse in the active version
                    let mut verse = self.get_verse(book, matched.chapter as i32, matched.verse as i32, &active_version)
                        .ok()
                        .flatten();
                    
                    // 2. Fallback to original version found in search if active doesn't have it
                    if verse.is_none() {
                        let version = &self.available_versions[matched.version_idx as usize];
                        verse = self.get_verse(book, matched.chapter as i32, matched.verse as i32, version)
                            .ok()
                            .flatten();
                    }

                    if let Some(mut v) = verse {
                        v.score = Some(score);
                        results.push(v);
                    }
                }
            }
        }
        results
    }

    /// Full-text keyword search across ALL versions using SQLite FTS5.
    /// Deduplicated by (book,chapter,verse).
    pub fn search_manual_all_versions(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        // Filter stop words, then build FTS5 query with prefix matching
        let words: Vec<String> = query
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .filter(|w| !STOP_WORDS.contains(&w.as_str()))
            .collect();

        if words.is_empty() {
            return Ok(Vec::new());
        }

        let cleaned_query = words
            .iter()
            .map(|w| {
                let sanitized = w.chars().filter(|c| c.is_alphanumeric()).collect::<String>();
                if sanitized.is_empty() { String::new() } else { format!("\"{}\"*", sanitized) }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        if cleaned_query.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT b.title, b.text, b.version, b.chapter, b.verse FROM super_bible b \
             JOIN super_bible_fts f ON b.rowid = f.rowid \
             WHERE super_bible_fts MATCH ?1 \
             ORDER BY rank \
             LIMIT 100"
        )?;

        let active_version = self.get_active_version();
        let mut seen = std::collections::HashSet::new();
        let mut results = Vec::new();

        let rows = stmt.query_map(params![cleaned_query], |row| {
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

        let mut matched_verses = Vec::new();
        for row in rows {
            if let Ok(v) = row {
                matched_verses.push(v);
            }
        }

        // Pass 1: results in active version
        for verse in &matched_verses {
            if verse.version == active_version {
                let key = (verse.book.clone(), verse.chapter, verse.verse);
                if seen.insert(key) {
                    results.push(verse.clone());
                    if results.len() >= 20 { break; }
                }
            }
        }

        // Pass 2: Fill remaining with other versions
        if results.len() < 20 {
            for verse in &matched_verses {
                let key = (verse.book.clone(), verse.chapter, verse.verse);
                if seen.insert(key) {
                    results.push(verse.clone());
                    if results.len() >= 20 { break; }
                }
            }
        }

        // Pass 3: Fallback to LIKE search if FTS found nothing or too little
        if results.len() < 5 {
            let like_pattern = format!("%{}%", query.trim().replace(' ', "%"));
            let mut stmt_like = conn.prepare_cached(
                "SELECT title, text, version, chapter, verse FROM super_bible \
                 WHERE text LIKE ?1 \
                 ORDER BY (CASE WHEN version = ?2 THEN 0 ELSE 1 END), rowid \
                 LIMIT 50"
            )?;
            let like_rows = stmt_like.query_map(params![like_pattern, active_version], |row| {
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
            for row in like_rows {
                if let Ok(v) = row {
                    let key = (v.book.clone(), v.chapter, v.verse);
                    if seen.insert(key) {
                        results.push(v);
                        if results.len() >= 20 { break; }
                    }
                }
            }
        }

        Ok(results)
    }

    /// Full-text keyword search within the active version only using SQLite FTS5.
    pub fn search_manual(&self, query: &str, version: &str) -> anyhow::Result<Vec<Verse>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let words: Vec<String> = query
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .filter(|w| !STOP_WORDS.contains(&w.as_str()))
            .collect();

        if words.is_empty() {
            return Ok(Vec::new());
        }

        let cleaned_query = words
            .iter()
            .map(|w| {
                let sanitized = w.chars().filter(|c| c.is_alphanumeric()).collect::<String>();
                if sanitized.is_empty() { String::new() } else { format!("\"{}\"*", sanitized) }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        if cleaned_query.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT b.title, b.text, b.version, b.chapter, b.verse FROM super_bible b \
             JOIN super_bible_fts f ON b.rowid = f.rowid \
             WHERE super_bible_fts MATCH ?1 AND b.version = ?2 \
             ORDER BY rank \
             LIMIT 50"
        )?;

        let rows = stmt.query_map(params![cleaned_query, version], |row| {
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
            if let Ok(v) = row {
                results.push(v);
            }
        }

        // Fallback to LIKE if FTS fails
        if results.is_empty() {
            let like_pattern = format!("%{}%", query.trim().replace(' ', "%"));
            let mut stmt_like = conn.prepare_cached(
                "SELECT title, text, version, chapter, verse FROM super_bible \
                 WHERE text LIKE ?1 AND version = ?2 \
                 ORDER BY rowid LIMIT 50"
            )?;
            let like_rows = stmt_like.query_map(params![like_pattern, version], |row| {
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
            for row in like_rows {
                if let Ok(v) = row {
                    results.push(v);
                }
            }
        }

        Ok(results)
    }

    pub fn get_books(&self, version: &str) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT title FROM super_bible WHERE version = ?1 AND language = 'EN' ORDER BY book"
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
            "SELECT DISTINCT chapter FROM super_bible WHERE title = ?1 AND version = ?2 ORDER BY chapter"
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
            "SELECT verse FROM super_bible WHERE title = ?1 AND chapter = ?2 AND version = ?3 ORDER BY verse"
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
            "SELECT title, chapter, verse, text FROM super_bible \
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
