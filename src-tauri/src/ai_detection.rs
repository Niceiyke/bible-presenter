use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptureReference {
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
}

fn tokenize(text: &str) -> Vec<String> {
    let normalized = text.to_lowercase().replace(':', " : ").replace('-', " - ");
    normalized
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric() && c != ':' && c != '-'))
        .filter(|word| !word.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn book_aliases(books: &[String]) -> Vec<(Vec<String>, String)> {
    let mut aliases = Vec::new();
    for book in books {
        let lower = book.to_lowercase();
        aliases.push((tokenize(&lower), book.clone()));
        if let Some(rest) = lower.strip_prefix("1 ") {
            for prefix in ["first", "one"] {
                aliases.push((tokenize(&format!("{prefix} {rest}")), book.clone()));
            }
        } else if let Some(rest) = lower.strip_prefix("2 ") {
            for prefix in ["second", "two"] {
                aliases.push((tokenize(&format!("{prefix} {rest}")), book.clone()));
            }
        } else if let Some(rest) = lower.strip_prefix("3 ") {
            for prefix in ["third", "three"] {
                aliases.push((tokenize(&format!("{prefix} {rest}")), book.clone()));
            }
        }
        if lower == "psalms" {
            aliases.push((vec!["psalm".into()], book.clone()));
        }
        if lower == "song of solomon" {
            aliases.push((tokenize("song of songs"), book.clone()));
        }
    }
    aliases.sort_by_key(|(tokens, _)| std::cmp::Reverse(tokens.len()));
    aliases
}

fn number_word(word: &str) -> Option<i32> {
    Some(match word {
        "zero" => 0,
        "one" | "first" => 1,
        "two" | "second" => 2,
        "three" | "third" => 3,
        "four" | "fourth" => 4,
        "five" | "fifth" => 5,
        "six" | "sixth" => 6,
        "seven" | "seventh" => 7,
        "eight" | "eighth" => 8,
        "nine" | "ninth" => 9,
        "ten" | "tenth" => 10,
        "eleven" | "eleventh" => 11,
        "twelve" | "twelfth" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    })
}

fn parse_number(tokens: &[String], start: usize) -> Option<(i32, usize)> {
    if start >= tokens.len() {
        return None;
    }
    if let Ok(number) = tokens[start].parse::<i32>() {
        return Some((number, start + 1));
    }
    let mut index = start;
    let mut value = 0;
    let mut consumed = false;
    while index < tokens.len() {
        if tokens[index] == "and" && consumed {
            index += 1;
            continue;
        }
        if tokens[index] == "hundred" && consumed {
            value = value.max(1) * 100;
            index += 1;
            continue;
        }
        let Some(part) = number_word(&tokens[index]) else {
            break;
        };
        value += part;
        consumed = true;
        index += 1;
        if part < 20 && value >= 20 {
            break;
        }
    }
    consumed.then_some((value, index))
}

/// Parse the chapter token in a compact spoken reference. A spoken tens value
/// ("twenty") is marked as ambiguous and is accepted only when the following
/// verse is itself compound ("twenty eight"). This keeps "Psalm twenty three"
/// from becoming Psalm 20:3 while allowing "Matthew six thirty three".
fn parse_compact_chapter(token: &str) -> Option<(i32, bool)> {
    if let Ok(number) = token.parse::<i32>() {
        return Some((number, false));
    }
    let number = number_word(token)?;
    if (1..=19).contains(&number) {
        Some((number, false))
    } else if (20..=90).contains(&number) && number % 10 == 0 {
        Some((number, true))
    } else {
        None
    }
}

pub fn detect_reference(text: &str, books: &[String]) -> Option<ScriptureReference> {
    let tokens = tokenize(text);
    let aliases = book_aliases(books);
    let mut latest: Option<(usize, ScriptureReference)> = None;
    for (alias, canonical) in aliases {
        if alias.is_empty() || alias.len() > tokens.len() {
            continue;
        }
        for start in 0..=tokens.len() - alias.len() {
            if tokens[start..start + alias.len()] != alias {
                continue;
            }
            let mut index = start + alias.len();
            if tokens.get(index).is_some_and(|token| token != "chapter") {
                if let Some((chapter, compound_verse_required)) = tokens
                    .get(index)
                    .and_then(|token| parse_compact_chapter(token))
                {
                    if let Some((verse, verse_end)) = parse_number(&tokens, index + 1) {
                        let verse_is_compound = verse_end > index + 2;
                        if !compound_verse_required || verse_is_compound {
                            let candidate = ScriptureReference {
                                book: canonical.clone(),
                                chapter,
                                verse,
                            };
                            if latest
                                .as_ref()
                                .is_none_or(|(position, _)| start > *position)
                            {
                                latest = Some((start, candidate));
                            }
                            continue;
                        }
                    }
                }
            }
            if tokens.get(index).is_some_and(|token| token == "chapter") {
                index += 1;
            }
            let Some((chapter, next)) = parse_number(&tokens, index) else {
                continue;
            };
            index = next;
            if tokens
                .get(index)
                .is_some_and(|token| token == ":" || token == "verse" || token == "verses")
            {
                index += 1;
            } else {
                continue;
            }
            let Some((verse, _)) = parse_number(&tokens, index) else {
                continue;
            };
            if chapter > 0 && verse > 0 {
                let candidate = ScriptureReference {
                    book: canonical.clone(),
                    chapter,
                    verse,
                };
                if latest
                    .as_ref()
                    .is_none_or(|(position, _)| start > *position)
                {
                    latest = Some((start, candidate));
                }
            }
        }
    }
    latest.map(|(_, reference)| reference)
}

pub(crate) fn quote_tokens(text: &str) -> Vec<String> {
    tokenize(text)
        .into_iter()
        .filter(|word| word != ":" && word != "-")
        .collect()
}

fn lcs_len(left: &[String], right: &[String]) -> usize {
    let mut previous = vec![0usize; right.len() + 1];
    for a in left {
        let mut current = vec![0usize; right.len() + 1];
        for (j, b) in right.iter().enumerate() {
            current[j + 1] = if a == b {
                previous[j] + 1
            } else {
                current[j].max(previous[j + 1])
            };
        }
        previous = current;
    }
    previous[right.len()]
}

fn direct_quote_score(spoken: &str, verse: &str) -> f32 {
    let spoken = quote_tokens(spoken);
    let verse = quote_tokens(verse);
    if spoken.len() < 5 || verse.len() < 5 {
        return 0.0;
    }
    let denominator = spoken.len().min(verse.len()) as f32;
    let ordered = lcs_len(&spoken, &verse) as f32 / denominator;
    let mut verse_counts: HashMap<&str, usize> = HashMap::new();
    for token in &verse {
        *verse_counts.entry(token).or_default() += 1;
    }
    let mut overlap = 0usize;
    for token in &spoken {
        if let Some(count) = verse_counts.get_mut(token.as_str()) {
            if *count > 0 {
                *count -= 1;
                overlap += 1;
            }
        }
    }
    let lexical = overlap as f32 / denominator;
    ordered * 0.7 + lexical * 0.3
}

/// Return the calibrated lexical-alignment score when `spoken` is close enough
/// to `verse` to qualify as a direct quotation suggestion.
pub fn direct_quote_match_score(spoken: &str, verse: &str) -> Option<f32> {
    let score = direct_quote_score(spoken, verse);
    let ordered_words = lcs_len(&quote_tokens(spoken), &quote_tokens(verse));
    (score >= 0.72 && ordered_words >= 5).then_some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn books() -> Vec<String> {
        vec![
            "John".into(),
            "Matthew".into(),
            "Psalms".into(),
            "Revelation".into(),
            "1 Corinthians".into(),
            "Song of Solomon".into(),
        ]
    }

    #[test]
    fn detects_numeric_and_spoken_references() {
        assert_eq!(
            detect_reference("Please turn to John 3:16 today", &books()),
            Some(ScriptureReference {
                book: "John".into(),
                chapter: 3,
                verse: 16
            })
        );
        assert_eq!(
            detect_reference("First Corinthians chapter thirteen verse four", &books()),
            Some(ScriptureReference {
                book: "1 Corinthians".into(),
                chapter: 13,
                verse: 4
            })
        );
        assert_eq!(
            detect_reference(
                "Psalm one hundred and nineteen verse one hundred and five",
                &books()
            ),
            Some(ScriptureReference {
                book: "Psalms".into(),
                chapter: 119,
                verse: 105
            })
        );
    }

    #[test]
    fn detects_compact_references_without_chapter_verse_words() {
        assert_eq!(
            detect_reference("Revelation five eleven", &books()),
            Some(ScriptureReference {
                book: "Revelation".into(),
                chapter: 5,
                verse: 11
            })
        );
        assert_eq!(
            detect_reference("Matthew six thirty three", &books()),
            Some(ScriptureReference {
                book: "Matthew".into(),
                chapter: 6,
                verse: 33
            })
        );
        assert_eq!(detect_reference("Psalm twenty three", &books()), None);
    }

    #[test]
    fn direct_quote_alignment_rejects_unrelated_text() {
        let verse = "For God so loved the world that he gave his only begotten Son";
        assert!(
            direct_quote_match_score("For God so loved the world that he gave his son", verse)
                .is_some()
        );
        assert!(direct_quote_match_score(
            "The people crossed through the water and entered the land",
            verse
        )
        .is_none());
    }
}
