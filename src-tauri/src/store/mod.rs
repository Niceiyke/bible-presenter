use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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

pub struct BibleStore {
    conn: Arc<Mutex<Connection>>,
    _patterns: RegexSet,
    book_map: HashMap<String, String>,
    books: Vec<String>,
    available_versions: Vec<String>,
    active_version: Mutex<String>,
}

impl BibleStore {
    pub fn new_empty(app: &tauri::AppHandle) -> Self {
        log_msg(app, "BibleStore: Initializing in empty mode (waiting for database download).");
        let conn = Connection::open_in_memory().expect("Failed to create in-memory DB");
        let patterns = RegexSet::new(&[
            r"(?i)\b([1-3]?\s*[a-z]+)\s+(\d+):(\d+)\b",
            r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)",
        ]).unwrap();

        Self {
            conn: Arc::new(Mutex::new(conn)),
            _patterns: patterns,
            book_map: HashMap::new(),
            books: Vec::new(),
            available_versions: Vec::new(),
            active_version: Mutex::new("KJV".to_string()),
        }
    }

    pub fn new(app: &tauri::AppHandle, db_path: &str) -> anyhow::Result<Self> {
        if !std::path::Path::new(db_path).exists() {
            return Err(anyhow::anyhow!("Bible database not found at {}", db_path));
        }
        let conn = Connection::open(db_path)?;

        if let Err(e) = conn.execute("PRAGMA journal_mode=WAL", []) {
            log_msg(app, &format!("Warning: Could not set WAL mode: {}", e));
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
            log_msg(app, &format!("BibleStore: schema migrated to version {}", CURRENT_SCHEMA_VERSION));
        }

        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS wordlyte_bible_fts USING fts5(
            title,
            text,
            version,
            content='wordlyte_bible',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2 porter'
        )", [])?;

        // Keep the full-text index in sync with the source table. Rebuild whenever the
        // row counts differ (e.g. a freshly downloaded/replaced bible.db) rather than only
        // populating on the first launch, so the index can never go stale.
        let count_fts: i64 = conn.query_row("SELECT count(*) FROM wordlyte_bible_fts", [], |r| r.get(0))?;
        let count_src: i64 = conn.query_row(
            "SELECT count(*) FROM wordlyte_bible WHERE language = 'EN' AND text IS NOT NULL AND text != ''",
            [], |r| r.get(0)
        )?;
        if count_fts != count_src || count_fts == 0 {
            log_msg(app, &format!(
                "BibleStore: Rebuilding FTS5 index (fts={}, src={})...", count_fts, count_src
            ));
            conn.execute("INSERT INTO wordlyte_bible_fts(wordlyte_bible_fts) VALUES('rebuild')", [])?;
        }

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
        log_msg(app, &format!("BibleStore: Available versions: {:?}", available_versions));

        let default_version = available_versions.first().cloned().unwrap_or_else(|| "KJV".to_string());

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

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            _patterns: patterns,
            book_map,
            books,
            available_versions,
            active_version: Mutex::new(default_version),
        })
    }

    pub fn get_available_versions(&self) -> Vec<String> {
        self.available_versions.clone()
    }

    pub fn get_active_version(&self) -> String {
        self.active_version.lock().clone()
    }

    pub fn set_active_version(&self, app: &tauri::AppHandle, version: &str) {
        *self.active_version.lock() = version.to_string();
        log_msg(app, &format!("BibleStore: Active version set to {}", version));
    }

    fn normalize_book(&self, raw: &str) -> String {
        let clean = raw.to_lowercase().trim().to_string();
        self.book_map.get(&clean).cloned().unwrap_or(raw.to_string())
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

        let mut results = self.search_fts_keyword(query, version);

        // Still surface the explicit reference at the top of keyword results.
        if let Some(r) = ref_results.first() {
            if !results.iter().any(|v| v.book == r.book && v.chapter == r.chapter && v.verse == r.verse) {
                results.insert(0, r.clone());
            }
        }

        results.truncate(20);
        Ok(SearchResponse { results, method: "keyword".to_string() })
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
                for r in rows {
                    if let Ok(x) = r {
                        scored.push(x);
                    }
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
        for row in rows {
            if let Ok(v) = row {
                results.push(v);
            }
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
