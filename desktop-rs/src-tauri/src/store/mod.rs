use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::collections::HashMap;
use parking_lot::Mutex;
use regex::{Regex, RegexSet};
use ndarray::Array2;
use ndarray_npy::ReadNpyExt;
use std::fs::File;

pub mod media_schedule;
pub use media_schedule::*;

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
}

pub struct BibleStore {
    conn: Arc<Mutex<Connection>>,
    patterns: RegexSet,
    book_map: HashMap<String, String>,
    /// All verses from all embedded versions, stacked in EMBEDDED_VERSIONS order.
    /// verse_cache[i] corresponds to embeddings row i.
    verse_cache: Vec<Verse>,
    /// Per-version offsets: version_offsets[i] = start row index for EMBEDDED_VERSIONS[i].
    version_offsets: Vec<usize>,
    /// Total verse count per version (all versions should be equal, but store per version for safety).
    version_lengths: Vec<usize>,
    /// Stacked L2-normalised embeddings for all versions, shape (N_total, 384).
    embeddings: Option<Array2<f32>>,
    /// Currently active version for display queries.
    active_version: Mutex<String>,
    /// All available versions found in the DB.
    available_versions: Vec<String>,
}

impl BibleStore {
    pub fn new(db_path: &str, embeddings_path: Option<&str>) -> anyhow::Result<Self> {
        let conn = Connection::open(db_path)?;

        if let Err(e) = conn.execute("PRAGMA journal_mode=WAL", []) {
            eprintln!("Warning: Could not set WAL mode: {}", e);
        }

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

        // Pre-load verse_cache for every embedded version (in EMBEDDED_VERSIONS order)
        let mut verse_cache: Vec<Verse> = Vec::new();
        let mut version_offsets: Vec<usize> = Vec::new();
        let mut version_lengths: Vec<usize> = Vec::new();

        for &version in EMBEDDED_VERSIONS {
            if !available_versions.iter().any(|v| v == version) {
                continue;
            }
            let offset = verse_cache.len();
            version_offsets.push(offset);

            let mut stmt = conn.prepare(
                "SELECT title, chapter, verse, text FROM super_bible \
                 WHERE version = ?1 AND language = 'EN' \
                 ORDER BY book, chapter, verse"
            )?;
            let rows = stmt.query_map(params![version], |row| {
                Ok(Verse {
                    book: row.get(0)?,
                    chapter: row.get(1)?,
                    verse: row.get(2)?,
                    text: row.get(3)?,
                    version: version.to_string(),
                })
            })?;
            let mut count = 0usize;
            for row in rows {
                verse_cache.push(row?);
                count += 1;
            }
            version_lengths.push(count);
            println!("BibleStore: Cached {} verses for {}", count, version);
        }
        println!("BibleStore: Total cached verses: {}", verse_cache.len());

        // Load stacked embeddings
        let embeddings = if let Some(path) = embeddings_path {
            match File::open(path) {
                Ok(mut file) => match Array2::<f32>::read_npy(&mut file) {
                    Ok(arr) => {
                        println!(
                            "BibleStore: Loaded stacked embeddings ({} rows, {} dims)",
                            arr.nrows(), arr.ncols()
                        );
                        Some(arr)
                    }
                    Err(e) => {
                        eprintln!("Warning: Failed to parse embeddings .npy: {}", e);
                        None
                    }
                },
                Err(e) => {
                    eprintln!("Warning: Could not open embeddings at {}: {}", path, e);
                    None
                }
            }
        } else {
            None
        };

        let default_version = EMBEDDED_VERSIONS
            .iter()
            .find(|&&v| available_versions.iter().any(|a| a == v))
            .map(|v| v.to_string())
            .unwrap_or_else(|| available_versions.first().cloned().unwrap_or_else(|| "KJV".to_string()));

        let mut book_map = HashMap::new();
        let books = vec![
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

        for (alias, full) in books {
            book_map.insert(alias.to_string(), full.to_string());
        }

        let patterns = RegexSet::new(&[
            r"(?i)([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)",
            r"(?i)(1st|2nd|3rd|first|second|third)\s+([a-z]+)\s+(\d+)[:\s]+(\d+)",
        ])?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            patterns,
            book_map,
            verse_cache,
            version_offsets,
            version_lengths,
            embeddings,
            active_version: Mutex::new(default_version),
            available_versions,
        })
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

    fn normalize_book(&self, raw: &str) -> String {
        let clean = raw.to_lowercase().trim().to_string();
        self.book_map.get(&clean).cloned().unwrap_or(raw.to_string())
    }

    pub fn detect_verse_hybrid(&self, text: &str, embedding: Option<Vec<f32>>) -> Option<Verse> {
        // 1. Explicit reference regex (e.g. "John 3:16")
        if let Some(verse) = self.detect_verse_by_ref(text) {
            return Some(verse);
        }
        // 2. Semantic search across ALL versions
        if let Some(emb) = embedding {
            return self.search_semantic_stacked(&emb);
        }
        None
    }

    pub fn detect_verse_by_ref(&self, text: &str) -> Option<Verse> {
        let matches: Vec<_> = self.patterns.matches(text).into_iter().collect();
        if matches.is_empty() { return None; }

        let re = Regex::new(r"(?i)([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)").ok()?;
        if let Some(caps) = re.captures(text) {
            let book = self.normalize_book(caps.get(1)?.as_str());
            let chapter: i32 = caps.get(2)?.as_str().parse().ok()?;
            let verse: i32 = caps.get(3)?.as_str().parse().ok()?;
            let version = self.get_active_version();
            return self.get_verse(&book, chapter, verse, &version).ok().flatten();
        }
        None
    }

    /// Searches the full stacked embeddings matrix across all embedded versions.
    /// Returns the best matching verse looked up in the active display version.
    fn search_semantic_stacked(&self, embedding: &[f32]) -> Option<Verse> {
        let embeddings = self.embeddings.as_ref()?;
        let query = ndarray::ArrayView1::from(embedding);
        let similarities = embeddings.dot(&query);

        let mut best_idx = 0;
        let mut max_score = 0.0f32;
        for (idx, &score) in similarities.iter().enumerate() {
            if score > max_score {
                max_score = score;
                best_idx = idx;
            }
        }

        if max_score < 0.45 {
            return None;
        }

        // Identify the verse coordinates from the best-matching cache entry
        let matched = self.verse_cache.get(best_idx)?;
        let active_version = self.get_active_version();

        // Look up the same (book, chapter, verse) in the active display version
        self.get_verse(&matched.book, matched.chapter, matched.verse, &active_version)
            .ok()
            .flatten()
            // Fallback: return matched verse as-is if active version doesn't have it
            .or_else(|| Some(matched.clone()))
    }

    pub fn get_verse(&self, book: &str, chapter: i32, verse: i32, version: &str) -> anyhow::Result<Option<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT title, chapter, verse, text FROM super_bible \
             WHERE title LIKE ?1 AND chapter = ?2 AND verse = ?3 AND version = ?4 LIMIT 1"
        )?;
        let mut rows = stmt.query(params![book, chapter, verse, version])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Verse {
                book: row.get(0)?,
                chapter: row.get(1)?,
                verse: row.get(2)?,
                text: row.get(3)?,
                version: version.to_string(),
            }))
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

    /// Full-text keyword search within the active version only.
    pub fn search_manual(&self, query: &str, version: &str) -> anyhow::Result<Vec<Verse>> {
        let query_lower = query.to_lowercase();
        let stop: &[&str] = &[
            "the", "and", "for", "that", "with", "this", "are", "was", "were",
            "they", "them", "from", "have", "has", "not", "but", "his", "her",
            "our", "your", "its", "who", "all", "one", "you", "him", "she",
            "what", "will", "said", "when", "also", "into", "unto", "shall",
            "thee", "thou", "thy",
        ];
        let query_words: Vec<&str> = query_lower
            .split_whitespace()
            .filter(|w| w.len() >= 2 && !stop.contains(w))
            .collect();

        if query_words.is_empty() {
            return Ok(Vec::new());
        }

        // Find the slice of verse_cache for this version
        let cache_slice = self.version_slice(version);

        let mut scored: Vec<(usize, &Verse)> = cache_slice
            .iter()
            .filter_map(|verse| {
                let verse_lower = verse.text.to_lowercase();
                let score: usize = query_words
                    .iter()
                    .filter(|&&w| verse_lower.contains(w))
                    .count();
                if score > 0 { Some((score, verse)) } else { None }
            })
            .collect();

        scored.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(scored.into_iter().take(10).map(|(_, v)| v.clone()).collect())
    }

    /// Returns the verse_cache slice that belongs to `version`.
    fn version_slice(&self, version: &str) -> &[Verse] {
        let idx = EMBEDDED_VERSIONS.iter().position(|&v| v == version);
        match idx {
            Some(i) if i < self.version_offsets.len() => {
                let start = self.version_offsets[i];
                let len = self.version_lengths[i];
                &self.verse_cache[start..start + len]
            }
            _ => &[], // version not in embedded set; fall back to empty
        }
    }

    pub fn get_books(&self, version: &str) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
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
        let mut stmt = conn.prepare(
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
        let mut stmt = conn.prepare(
            "SELECT verse FROM super_bible WHERE title = ?1 AND chapter = ?2 AND version = ?3 ORDER BY verse"
        )?;
        let rows = stmt.query_map(params![book, chapter, version], |row| row.get(0))?;
        let mut verses = Vec::new();
        for v in rows {
            verses.push(v?);
        }
        Ok(verses)
    }
}
