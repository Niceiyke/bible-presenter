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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Verse {
    pub id: i32,
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
    pub text: String,
}

pub struct BibleStore {
    conn: Arc<Mutex<Connection>>,
    patterns: RegexSet,
    book_map: HashMap<String, String>,
    verse_cache: Vec<Verse>,
    embeddings: Option<Array2<f32>>, // Pre-computed embeddings for all verses
}

impl BibleStore {
    pub fn new(db_path: &str, embeddings_path: Option<&str>) -> anyhow::Result<Self> {
        let conn = Connection::open(db_path)?;
        
        // Attempt WAL mode but don't fail if it doesn't work (e.g. read-only fs)
        if let Err(e) = conn.execute("PRAGMA journal_mode=WAL", []) {
            eprintln!("Warning: Could not set WAL mode: {}", e);
        }
        
        // Pre-load verses for manual search/fallback
        let mut verse_cache = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT id, book, chapter, verse, text FROM verses ORDER BY id")?;
            let verse_iter = stmt.query_map([], |row| {
                Ok(Verse {
                    id: row.get(0)?,
                    book: row.get(1)?,
                    chapter: row.get(2)?,
                    verse: row.get(3)?,
                    text: row.get(4)?,
                })
            })?;

            for verse in verse_iter {
                verse_cache.push(verse?);
            }
        }
        println!("BibleStore: Cached {} verses", verse_cache.len());

        let embeddings = if let Some(path) = embeddings_path {
            match File::open(path) {
                Ok(mut file) => match Array2::<f32>::read_npy(&mut file) {
                    Ok(arr) => {
                        println!("BibleStore: Loaded {} embeddings (dim {})", arr.nrows(), arr.ncols());
                        Some(arr)
                    },
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
            embeddings,
        })
    }

    pub fn detect_verse_hybrid(&self, text: &str, embedding: Option<Vec<f32>>) -> Option<Verse> {
        // 1. Explicit Regex Search (Priority)
        if let Some(verse) = self.detect_verse(text) {
            return Some(verse);
        }

        // 2. Semantic Search Fallback
        if let Some(emb) = embedding {
            return self.search_semantic_mem(&emb);
        }

        None
    }

    pub fn detect_verse(&self, text: &str) -> Option<Verse> {
        let matches: Vec<_> = self.patterns.matches(text).into_iter().collect();
        if matches.is_empty() { return None; }

        let re = Regex::new(r"(?i)([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)").ok()?;
        if let Some(caps) = re.captures(text) {
            let book = self.normalize_book(caps.get(1)?.as_str());
            let chapter: i32 = caps.get(2)?.as_str().parse().ok()?;
            let verse: i32 = caps.get(3)?.as_str().parse().ok()?;
            
            return self.get_verse(&book, chapter, verse).ok().flatten();
        }
        None
    }

    fn normalize_book(&self, raw: &str) -> String {
        let clean = raw.to_lowercase().trim().to_string();
        self.book_map.get(&clean).cloned().unwrap_or(raw.to_string())
    }

    pub fn get_verse(&self, book: &str, chapter: i32, verse: i32) -> anyhow::Result<Option<Verse>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT id, book, chapter, verse, text FROM verses WHERE book LIKE ?1 AND chapter = ?2 AND verse = ?3 LIMIT 1"
        )?;

        let mut rows = stmt.query(params![book, chapter, verse])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Verse {
                id: row.get(0)?,
                book: row.get(1)?,
                chapter: row.get(2)?,
                verse: row.get(3)?,
                text: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    fn search_semantic_mem(&self, embedding: &[f32]) -> Option<Verse> {
        let embeddings = self.embeddings.as_ref()?;
        let query = ndarray::ArrayView1::from(embedding);
        
        // Fast matrix-vector multiplication (dot product)
        // Since both are L2 normalized, result is cosine similarity
        let similarities = embeddings.dot(&query);

        let mut best_idx = 0;
        let mut max_score = 0.0;

        for (idx, &score) in similarities.iter().enumerate() {
            if score > max_score {
                max_score = score;
                best_idx = idx;
            }
        }

        // Threshold for a good match (consistent with Python engine)
        if max_score >= 0.45 {
            self.verse_cache.get(best_idx).cloned()
        } else {
            None
        }
    }

    pub fn search_semantic_text(&self, text: &str) -> Option<Verse> {
        let text_lower = text.to_lowercase();
        let query_words: Vec<&str> = text_lower.split_whitespace()
            .filter(|w| w.len() > 3) // Ignore common small words
            .collect();

        if query_words.is_empty() { return None; }

        let mut best_verse = None;
        let mut max_score = 0;

        // Iterate through cache to find the best text match
        for verse in &self.verse_cache {
            let mut score = 0;
            let verse_text = verse.text.to_lowercase();
            for word in &query_words {
                if verse_text.contains(word) {
                    score += 1;
                }
            }

            if score > max_score {
                max_score = score;
                best_verse = Some(verse.clone());
            }
        }

        // Return only if we have a significant overlap (e.g. 3+ keywords)
        if max_score >= 3 {
            best_verse
        } else {
            None
        }
    }

    pub fn search_manual(&self, query: &str) -> anyhow::Result<Vec<Verse>> {
        let query_lower = query.to_lowercase();

        // Common stop words that appear in nearly every verse — skip them
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
            // Nothing meaningful to search — return empty
            return Ok(Vec::new());
        }

        // Score every verse by how many query words appear as substrings.
        // Substring matching means "love" matches "loved", "loves", "lovely".
        let mut scored: Vec<(usize, &Verse)> = self
            .verse_cache
            .iter()
            .filter_map(|verse| {
                let verse_lower = verse.text.to_lowercase();
                let score: usize = query_words
                    .iter()
                    .filter(|&&w| verse_lower.contains(w))
                    .count();
                if score > 0 {
                    Some((score, verse))
                } else {
                    None
                }
            })
            .collect();

        // Best matches first; cap at 10 results
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(scored.into_iter().take(10).map(|(_, v)| v.clone()).collect())
    }

    pub fn get_books(&self) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT DISTINCT book FROM verses ORDER BY id")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut books = Vec::new();
        for book in rows {
            books.push(book?);
        }
        Ok(books)
    }

    pub fn get_chapters(&self, book: &str) -> anyhow::Result<Vec<i32>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT DISTINCT chapter FROM verses WHERE book = ?1 ORDER BY chapter")?;
        let rows = stmt.query_map(params![book], |row| row.get(0))?;
        let mut chapters = Vec::new();
        for chap in rows {
            chapters.push(chap?);
        }
        Ok(chapters)
    }

    pub fn get_verses_count(&self, book: &str, chapter: i32) -> anyhow::Result<Vec<i32>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT verse FROM verses WHERE book = ?1 AND chapter = ?2 ORDER BY verse")?;
        let rows = stmt.query_map(params![book, chapter], |row| row.get(0))?;
        let mut verses = Vec::new();
        for v in rows {
            verses.push(v?);
        }
        Ok(verses)
    }
}
