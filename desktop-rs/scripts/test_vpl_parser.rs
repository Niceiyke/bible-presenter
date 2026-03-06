use std::fs::File;
use std::io::{BufRead, BufReader};

fn main() {
    let file = File::open("eng-kjv2006_vpl.txt").expect("Could not open file");
    let reader = BufReader::new(file);

    println!("--- PARSING TEST ---");
    for (i, line) in reader.lines().enumerate().take(10) {
        let line = line.expect("Could not read line");
        if let Some(parsed) = parse_vpl_line(&line) {
            println!("Line {}: Book: {}, Ch: {}, Vs: {}, Text: {:.30}...", 
                i + 1, parsed.book, parsed.chapter, parsed.verse, parsed.text);
        }
    }
}

struct ParsedVerse {
    book: String,
    chapter: i32,
    verse: i32,
    text: String,
}

fn parse_vpl_line(line: &str) -> Option<ParsedVerse> {
    // Format: GEN 1:1 In the beginning...
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
