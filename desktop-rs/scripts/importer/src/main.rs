use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};

fn main() -> Result<()> {
    let db_path = "../../src-tauri/bible_data/wordlyte_bible.db";
    let web_vpl_path = "../../engwebp_vpl.txt";

    println!("Connecting to database: {}", db_path);
    let mut conn = Connection::open(db_path).context("Failed to open database")?;

    // 1. Remove OEB version
    println!("Removing OEB version...");
    conn.execute("DELETE FROM super_bible WHERE version = 'OEB'", [])?;

    // 2. Define Book Mapping (Updated for ebible codes)
    let mut book_map = HashMap::new();
    let books = [
        ("GEN", "Genesis", 1), ("EXO", "Exodus", 2), ("LEV", "Leviticus", 3), ("NUM", "Numbers", 4),
        ("DEU", "Deuteronomy", 5), ("JOS", "Joshua", 6), ("JDG", "Judges", 7), ("RUT", "Ruth", 8),
        ("1SA", "1 Samuel", 9), ("2SA", "2 Samuel", 10), ("1KI", "1 Kings", 11), ("2KI", "2 Kings", 12),
        ("1CH", "1 Chronicles", 13), ("2CH", "2 Chronicles", 14), ("EZR", "Ezra", 15), ("NEH", "Nehemiah", 16),
        ("EST", "Esther", 17), ("JOB", "Job", 18), ("PSA", "Psalms", 19), ("PRO", "Proverbs", 20),
        ("ECC", "Ecclesiastes", 21), ("SOL", "Song of Solomon", 22), ("ISA", "Isaiah", 23), ("JER", "Jeremiah", 24),
        ("LAM", "Lamentations", 25), ("EZE", "Ezekiel", 26), ("DAN", "Daniel", 27), ("HOS", "Hosea", 28),
        ("JOE", "Joel", 29), ("AMO", "Amos", 30), ("OBA", "Obadiah", 31), ("JON", "Jonah", 32),
        ("MIC", "Micah", 33), ("NAH", "Nahum", 34), ("HAB", "Habakkuk", 35), ("ZEP", "Zephaniah", 36),
        ("HAG", "Haggai", 37), ("ZEC", "Zechariah", 38), ("MAL", "Malachi", 39), ("MAT", "Matthew", 40),
        ("MAR", "Mark", 41), ("LUK", "Luke", 42), ("JOH", "John", 43), ("ACT", "Acts", 44),
        ("ROM", "Romans", 45), ("1CO", "1 Corinthians", 46), ("2CO", "2 Corinthians", 47), ("GAL", "Galatians", 48),
        ("EPH", "Ephesians", 49), ("PHI", "Philippians", 50), ("COL", "Colossians", 51), ("1TH", "1 Thessalonians", 52),
        ("2TH", "2 Thessalonians", 53), ("1TI", "1 Timothy", 54), ("2TI", "2 Timothy", 55), ("TIT", "Titus", 56),
        ("PHM", "Philemon", 57), ("HEB", "Hebrews", 58), ("JAM", "James", 59), ("1PE", "1 Peter", 60),
        ("2PE", "2 Peter", 61), ("1JO", "1 John", 62), ("2JO", "2 John", 63), ("3JO", "3 John", 64),
        ("JUD", "Jude", 65), ("REV", "Revelation", 66),
    ];
    for (code, name, id) in books {
        book_map.insert(code, (name, id));
    }

    // 3. Import WEB version
    println!("Starting import of WEB from {}...", web_vpl_path);
    conn.execute("DELETE FROM super_bible WHERE version = 'WEB'", [])?;

    let tx = conn.transaction()?;
    let mut count = 0;
    {
        let file = File::open(web_vpl_path).context("Could not open WEB VPL file")?;
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = line?;
            if let Some(parsed) = parse_vpl_line(&line) {
                if let Some((full_name, book_id)) = book_map.get(parsed.book.as_str()) {
                    tx.execute(
                        "INSERT INTO super_bible (title, book, chapter, verse, text, version, language) 
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![full_name, book_id, parsed.chapter, parsed.verse, parsed.text, "WEB", "EN"],
                    )?;
                    count += 1;
                }
            }
        }
    }
    tx.commit()?;
    println!("Imported {} verses for WEB.", count);

    // Final verification
    let mut stmt = conn.prepare("SELECT version, count(*) FROM super_bible GROUP BY version")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    println!("--- Final Database Status ---");
    for row in rows {
        let (v, c) = row?;
        println!("Version: {}, Count: {}", v, c);
    }

    Ok(())
}

struct ParsedVerse {
    book: String,
    chapter: i32,
    verse: i32,
    text: String,
}

fn parse_vpl_line(line: &str) -> Option<ParsedVerse> {
    let space_idx = line.find(' ')?;
    let book = &line[..space_idx];
    let remainder = &line[space_idx + 1..];
    let colon_idx = remainder.find(':')?;
    let chapter_str = &remainder[..colon_idx];
    let second_space_idx = remainder.find(' ')?;
    let verse_str = &remainder[colon_idx + 1..second_space_idx];
    let text = &remainder[second_space_idx + 1..];

    Some(ParsedVerse {
        book: book.to_string(),
        chapter: chapter_str.parse().ok()?,
        verse: verse_str.parse().ok()?,
        text: text.trim().to_string(),
    })
}
