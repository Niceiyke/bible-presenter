//! Canonical Bible-book names and their input aliases.
//!
//! Both the manual Bible picker and live ASR detection resolve through this
//! module. Keeping aliases here prevents an operator search and a spoken
//! reference from disagreeing about the same book name.

use std::collections::HashMap;

const ABBREVIATIONS: &[(&str, &str)] = &[
    ("gen", "Genesis"),
    ("gn", "Genesis"),
    ("exod", "Exodus"),
    ("ex", "Exodus"),
    ("lev", "Leviticus"),
    ("lv", "Leviticus"),
    ("num", "Numbers"),
    ("nm", "Numbers"),
    ("deut", "Deuteronomy"),
    ("dt", "Deuteronomy"),
    ("josh", "Joshua"),
    ("jos", "Joshua"),
    ("judg", "Judges"),
    ("jdg", "Judges"),
    ("rth", "Ruth"),
    ("1samuel", "1 Samuel"),
    ("1sam", "1 Samuel"),
    ("1sm", "1 Samuel"),
    ("2samuel", "2 Samuel"),
    ("2sam", "2 Samuel"),
    ("2sm", "2 Samuel"),
    ("1kings", "1 Kings"),
    ("1kgs", "1 Kings"),
    ("1kg", "1 Kings"),
    ("2kings", "2 Kings"),
    ("2kgs", "2 Kings"),
    ("2kg", "2 Kings"),
    ("1chronicles", "1 Chronicles"),
    ("1chr", "1 Chronicles"),
    ("2chronicles", "2 Chronicles"),
    ("2chr", "2 Chronicles"),
    ("ezr", "Ezra"),
    ("neh", "Nehemiah"),
    ("esth", "Esther"),
    ("est", "Esther"),
    ("jb", "Job"),
    ("ps", "Psalms"),
    ("psa", "Psalms"),
    ("prov", "Proverbs"),
    ("prv", "Proverbs"),
    ("eccl", "Ecclesiastes"),
    ("ecc", "Ecclesiastes"),
    ("sos", "Song of Solomon"),
    ("isa", "Isaiah"),
    ("jer", "Jeremiah"),
    ("lam", "Lamentations"),
    ("ezek", "Ezekiel"),
    ("ezk", "Ezekiel"),
    ("dan", "Daniel"),
    ("dn", "Daniel"),
    ("hos", "Hosea"),
    ("jl", "Joel"),
    ("obad", "Obadiah"),
    ("ob", "Obadiah"),
    ("jon", "Jonah"),
    ("mic", "Micah"),
    ("nah", "Nahum"),
    ("na", "Nahum"),
    ("hab", "Habakkuk"),
    ("zeph", "Zephaniah"),
    ("zep", "Zephaniah"),
    ("hag", "Haggai"),
    ("zech", "Zechariah"),
    ("zec", "Zechariah"),
    ("mal", "Malachi"),
    ("matt", "Matthew"),
    ("mt", "Matthew"),
    ("mrk", "Mark"),
    ("mk", "Mark"),
    ("lk", "Luke"),
    ("jn", "John"),
    ("rom", "Romans"),
    ("rm", "Romans"),
    ("1corinthians", "1 Corinthians"),
    ("1cor", "1 Corinthians"),
    ("2corinthians", "2 Corinthians"),
    ("2cor", "2 Corinthians"),
    ("gal", "Galatians"),
    ("eph", "Ephesians"),
    ("phil", "Philippians"),
    ("php", "Philippians"),
    ("col", "Colossians"),
    ("1thessalonians", "1 Thessalonians"),
    ("1thess", "1 Thessalonians"),
    ("2thessalonians", "2 Thessalonians"),
    ("2thess", "2 Thessalonians"),
    ("1timothy", "1 Timothy"),
    ("1tim", "1 Timothy"),
    ("2timothy", "2 Timothy"),
    ("2tim", "2 Timothy"),
    ("tit", "Titus"),
    ("philem", "Philemon"),
    ("phm", "Philemon"),
    ("heb", "Hebrews"),
    ("jas", "James"),
    ("jm", "James"),
    ("1peter", "1 Peter"),
    ("1pet", "1 Peter"),
    ("2peter", "2 Peter"),
    ("2pet", "2 Peter"),
    ("1john", "1 John"),
    ("1jn", "1 John"),
    ("2john", "2 John"),
    ("2jn", "2 John"),
    ("3john", "3 John"),
    ("3jn", "3 John"),
    ("jud", "Jude"),
    ("rev", "Revelation"),
    ("rv", "Revelation"),
];

const SINGULAR_ALIASES: &[(&str, &str)] = &[
    ("psalms", "psalm"),
    ("numbers", "number"),
    ("judges", "judge"),
    ("acts", "act"),
    ("romans", "roman"),
    ("hebrews", "hebrew"),
];

const ASR_ALIASES: &[(&str, &str)] = &[
    ("ester", "Esther"),
    ("revelations", "Revelation"),
    ("filemon", "Philemon"),
    ("zachariah", "Zechariah"),
    ("zephania", "Zephaniah"),
    ("habakuk", "Habakkuk"),
];

/// Normalizes a potential book label without treating punctuation as meaning.
pub(crate) fn tokenize_book_name(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn installed(books: &[String], canonical: &str) -> bool {
    books
        .iter()
        .any(|book| book.eq_ignore_ascii_case(canonical))
}

/// Returns tokenized aliases ordered so multi-word aliases win over prefixes.
pub(crate) fn aliases_for_books(books: &[String]) -> Vec<(Vec<String>, String)> {
    let mut aliases = Vec::new();
    for book in books {
        let lower = book.to_lowercase();
        aliases.push((tokenize_book_name(&lower), book.clone()));
        let numbered = if let Some(rest) = lower.strip_prefix("1 ") {
            Some((rest, ["first", "one"]))
        } else if let Some(rest) = lower.strip_prefix("2 ") {
            Some((rest, ["second", "two"]))
        } else if let Some(rest) = lower.strip_prefix("3 ") {
            Some((rest, ["third", "three"]))
        } else {
            None
        };
        if let Some((rest, prefixes)) = numbered {
            for prefix in prefixes {
                aliases.push((
                    tokenize_book_name(&format!("{prefix} {rest}")),
                    book.clone(),
                ));
                if rest == "kings" {
                    aliases.push((tokenize_book_name(&format!("{prefix} king")), book.clone()));
                }
            }
        }
        for &(plural, singular) in SINGULAR_ALIASES {
            if lower == plural {
                aliases.push((vec![singular.into()], book.clone()));
            }
        }
        if lower == "song of solomon" {
            aliases.push((tokenize_book_name("song of songs"), book.clone()));
        }
    }
    for &(alias, canonical) in ABBREVIATIONS.iter().chain(ASR_ALIASES.iter()) {
        if installed(books, canonical) {
            aliases.push((tokenize_book_name(alias), canonical.into()));
            // Accept both compact (`1kgs`) and operator-entered (`1 kgs`)
            // numbered abbreviations from the same canonical alias entry.
            if let Some(number) = alias
                .chars()
                .next()
                .filter(|character| character.is_ascii_digit())
            {
                let rest = &alias[number.len_utf8()..];
                aliases.push((
                    tokenize_book_name(&format!("{number} {rest}")),
                    canonical.into(),
                ));
            }
        }
    }
    aliases.sort_by(|(left, _), (right, _)| {
        right.len().cmp(&left.len()).then_with(|| left.cmp(right))
    });
    aliases.dedup();
    aliases
}

pub(crate) fn alias_map_for_books(books: &[String]) -> HashMap<String, String> {
    aliases_for_books(books)
        .into_iter()
        .map(|(tokens, canonical)| (tokens.join(" "), canonical))
        .collect()
}

/// Resolves a complete book label from either manual or ASR input.
pub(crate) fn resolve_book_name(input: &str, books: &[String]) -> Option<String> {
    let input = tokenize_book_name(input).join(" ");
    alias_map_for_books(books).remove(&input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_king_is_shared_manual_and_spoken_alias() {
        let books = vec!["1 Kings".into(), "John".into()];
        assert_eq!(
            resolve_book_name("First King", &books).as_deref(),
            Some("1 Kings")
        );
        assert_eq!(
            resolve_book_name("1 Kgs", &books).as_deref(),
            Some("1 Kings")
        );
    }

    #[test]
    fn common_word_is_is_not_an_isaiah_alias() {
        let books = vec!["Isaiah".into()];
        assert_eq!(resolve_book_name("is", &books), None);
        assert_eq!(
            resolve_book_name("isa", &books).as_deref(),
            Some("Isaiah")
        );
    }
}
