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

static RE_FULL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)((?:[1-3]?\s*|1st\s+|2nd\s+|3rd\s+|first\s+|second\s+|third\s+)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+)[:\s]+(\d+)").unwrap()
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

        const CURRENT_SCHEMA_VERSION: u32 = 1;
        let schema_version: u32 = conn.query_row(
            "PRAGMA user_version", [], |r| r.get(0)
        ).unwrap_or(0);
        if schema_version < CURRENT_SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version = {}", CURRENT_SCHEMA_VERSION))?;
            log_msg(app, &format!("BibleStore: schema migrated to version {}", CURRENT_SCHEMA_VERSION));
        }

        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS wordlyte_bible_fts USING fts5(
            title,
            text,
            version,
            content='wordlyte_bible',
            content_rowid='rowid'
        )", [])?;

        let count_fts: i64 = conn.query_row("SELECT count(*) FROM wordlyte_bible_fts", [], |r| r.get(0))?;
        if count_fts == 0 {
            log_msg(app, "BibleStore: Initializing FTS5 index...");
            conn.execute("INSERT INTO wordlyte_bible_fts(rowid, title, text, version)
                         SELECT rowid, title, text, version FROM wordlyte_bible
                         WHERE language = 'EN' AND text IS NOT NULL AND text != ''", [])?;
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

    pub fn detect_verses_by_ref(&self, text: &str) -> Vec<Verse> {
        let text_lower = text.to_lowercase();

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

    pub fn search_all(&self, query: &str) -> anyhow::Result<SearchResponse> {
        let ref_results = self.detect_verses_by_ref(query);
        if !ref_results.is_empty() {
            return Ok(SearchResponse { results: ref_results, method: "reference".to_string() });
        }

        let fts_results = self.search_manual_all_versions(query)?;
        Ok(SearchResponse { results: fts_results.into_iter().take(20).collect(), method: "keyword".to_string() })
    }

    pub fn search_manual_all_versions(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
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
            "SELECT b.title, b.text, b.version, b.chapter, b.verse FROM wordlyte_bible b \
             JOIN wordlyte_bible_fts f ON b.rowid = f.rowid \
             WHERE wordlyte_bible_fts MATCH ?1 \
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

        for verse in &matched_verses {
            if verse.version == active_version {
                let key = (verse.book.clone(), verse.chapter, verse.verse);
                if seen.insert(key) {
                    results.push(verse.clone());
                    if results.len() >= 20 { break; }
                }
            }
        }

        if results.len() < 20 {
            for verse in &matched_verses {
                let key = (verse.book.clone(), verse.chapter, verse.verse);
                if seen.insert(key) {
                    results.push(verse.clone());
                    if results.len() >= 20 { break; }
                }
            }
        }

        if results.len() < 5 {
            let like_pattern = format!("%{}%", query.trim().replace(' ', "%"));
            let mut stmt_like = conn.prepare_cached(
                "SELECT title, text, version, chapter, verse FROM wordlyte_bible \
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
            "SELECT b.title, b.text, b.version, b.chapter, b.verse FROM wordlyte_bible b \
             JOIN wordlyte_bible_fts f ON b.rowid = f.rowid \
             WHERE wordlyte_bible_fts MATCH ?1 AND b.version = ?2 \
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

        if results.is_empty() {
            let like_pattern = format!("%{}%", query.trim().replace(' ', "%"));
            let mut stmt_like = conn.prepare_cached(
                "SELECT title, text, version, chapter, verse FROM wordlyte_bible \
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
