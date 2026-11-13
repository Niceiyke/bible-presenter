use crate::scripture_catalog::aliases_for_books;
use std::collections::{BTreeMap, HashMap};

pub(crate) const MIN_DIRECT_QUOTE_WORDS: usize = 5;
const EMBEDDED_QUOTE_WINDOW_WORDS: usize = 8;
const EMBEDDED_QUOTE_ANCHOR_WORDS: usize = 4;
const REPEATED_PHRASE_WORDS: usize = 4;
pub(crate) const MIN_QUOTE_CONTENT_WORDS: usize = 2;
#[allow(dead_code)] // also compiled into the standalone evaluator
pub(crate) const MIN_LOOSE_QUOTE_CONTENT_WORDS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptureReference {
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
    pub verse_end: Option<i32>,
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

/// Tokenizes one ASR update so reference and quote detection can share the
/// normalization work instead of independently scanning a growing interim
/// transcript.
// Also compiled into the standalone evaluator, which calls the text-based
// detection API rather than the application's shared-token path.
#[allow(dead_code)]
pub(crate) fn normalized_transcript_tokens(text: &str) -> Vec<String> {
    tokenize(text)
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

/// Some ASR engines spell a numeric reference digit by digit: "one one nine"
/// rather than "one hundred and nineteen". Keep this deliberately limited to
/// cardinal digits so ordinary phrases and book ordinals retain their meaning.
fn spoken_digit(word: &str) -> Option<i32> {
    match word {
        "zero" => Some(0),
        "one" => Some(1),
        "two" => Some(2),
        "three" => Some(3),
        "four" => Some(4),
        "five" => Some(5),
        "six" => Some(6),
        "seven" => Some(7),
        "eight" => Some(8),
        "nine" => Some(9),
        _ => word
            .parse::<i32>()
            .ok()
            .filter(|number| (0..=9).contains(number)),
    }
}

fn parse_spoken_digit_sequence(tokens: &[String], start: usize) -> Option<(i32, usize)> {
    let mut index = start;
    let mut value = 0;
    let mut digits = 0;
    while digits < 3 {
        let Some(digit) = tokens.get(index).and_then(|token| spoken_digit(token)) else {
            break;
        };
        value = value * 10 + digit;
        digits += 1;
        index += 1;
    }
    (digits >= 2).then_some((value, index))
}

pub(crate) fn parse_number(tokens: &[String], start: usize) -> Option<(i32, usize)> {
    if start >= tokens.len() {
        return None;
    }
    if let Ok(number) = tokens[start].parse::<i32>() {
        return Some((number, start + 1));
    }
    if let Some(number) = parse_spoken_digit_sequence(tokens, start) {
        return Some(number);
    }
    let mut index = start;
    let mut value = 0;
    let mut consumed = false;
    let mut used_hundred = false;
    while index < tokens.len() {
        if tokens[index] == "and" && consumed {
            // "and" continues a single number only after a hundreds value
            // ("one hundred and five"). In "verses eleven and twelve" it
            // separates two verse numbers and must remain unconsumed.
            if used_hundred {
                index += 1;
                continue;
            }
            break;
        }
        if tokens[index] == "hundred" && consumed {
            value = value.max(1) * 100;
            used_hundred = true;
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

/// Compact references omit the `verse` marker ("John three sixteen"). When
/// the marker exists, use the explicit parser instead: it handles digit-by-
/// digit ASR numbers such as "Psalm one one nine verse one one one".
fn has_explicit_verse_marker(tokens: &[String], start: usize) -> bool {
    let mut index = start;
    let mut consumed_number = false;
    while index < tokens.len() && index < start + 8 {
        match tokens[index].as_str() {
            "verse" | "verses" => return consumed_number,
            "hundred" | "and" => {
                consumed_number = true;
                index += 1;
            }
            token if token.parse::<i32>().is_ok() || number_word(token).is_some() => {
                consumed_number = true;
                index += 1;
            }
            _ => return false,
        }
    }
    false
}

/// Parse the chapter token in a compact spoken reference. A spoken tens value
/// ("twenty") is marked as ambiguous and is accepted only when the following
/// verse is itself compound ("twenty eight"), keeping "Matthew six thirty
/// three" competitive. When the verse is small ("Psalm twenty three") or
/// absent ("Revelation twenty one"), the reference is resolved as the compound
/// chapter number and rendered as the chapter's first verse instead.
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

fn single_number_token(token: &str) -> Option<i32> {
    token.parse::<i32>().ok().or_else(|| number_word(token))
}

/// Parse a verse number that follows an explicit `verse`/`verses` marker,
/// along with an optional spoken range end. `-` and `to` always extend the
/// range; `and` extends it only after the plural marker ("verses eleven and
/// twelve"), so "verse 5 and then we go" keeps the sentence flowing. Shared
/// with the anchor's contextual parser so both paths agree on the policy.
pub(crate) fn parse_verse_number(
    tokens: &[String],
    start: usize,
    plural_marker: bool,
) -> Option<(i32, usize, Option<i32>)> {
    let (verse, mut next) = parse_number(tokens, start)?;
    let range_candidate = tokens.get(next).and_then(|separator| {
        let named_second_verse = separator == "and"
            && tokens
                .get(next + 1)
                .is_some_and(|marker| marker == "verse" || marker == "verses");
        let is_range =
            separator == "-" || separator == "to" || (separator == "and" && plural_marker);
        if is_range {
            parse_number(tokens, next + 1)
        } else if named_second_verse {
            // "verse 28 and verse 29" is an explicit range even though the
            // first marker is singular. Keep "verse 5 and then we go" from
            // treating ordinary prose as a range.
            parse_number(tokens, next + 2)
        } else {
            None
        }
    });
    let verse_end = match range_candidate {
        Some((end, end_next)) if end >= verse => {
            next = end_next;
            Some(end)
        }
        _ => None,
    };
    Some((verse, next, verse_end))
}

/// In continuous preaching, a range is commonly spoken without a separator:
/// "Matthew six nine ten" means Matthew 6:9–10, not Matthew 6:19. Preserve
/// regular compound numbers such as "thirty three" while treating two
/// consecutive small numbers as a verse range.
fn parse_compact_verse(tokens: &[String], start: usize) -> Option<(i32, usize, Option<i32>)> {
    let first = tokens
        .get(start)
        .and_then(|token| single_number_token(token))?;
    if (1..=19).contains(&first) {
        if let Some(end) = tokens
            .get(start + 1)
            .and_then(|token| single_number_token(token))
            .filter(|end| (1..=19).contains(end) && *end >= first)
        {
            return Some((first, start + 2, Some(end)));
        }
    }
    parse_number(tokens, start).map(|(verse, next)| (verse, next, None))
}

/// Finds every unambiguous, explicit Scripture reference in a transcript
/// update. This matters during a sermon: one ASR turn can contain a sequence
/// such as "John 3:16, then Romans 8:1" and each reference should be ready in
/// the operator's Preview queue rather than silently dropping all but the last.
pub fn detect_references(text: &str, books: &[String]) -> Vec<ScriptureReference> {
    let tokens = tokenize(text);
    detect_references_from_tokens(&tokens, books)
}

pub(crate) fn detect_references_from_tokens(
    tokens: &[String],
    books: &[String],
) -> Vec<ScriptureReference> {
    let aliases = reference_aliases_for_books(books);
    detect_references_with_aliases(tokens, &aliases)
}

pub(crate) fn reference_aliases_for_books(books: &[String]) -> Vec<(Vec<String>, String)> {
    aliases_for_books(books)
}

pub(crate) fn detect_references_with_aliases(
    tokens: &[String],
    aliases: &[(Vec<String>, String)],
) -> Vec<ScriptureReference> {
    // Rank by the end of the matched book name, not its start. Numbered books
    // can contain another canonical book as a suffix ("First John" contains
    // "John"). Both aliases end at the same token, so prefer the longer alias.
    // A genuinely later reference still has a later book-name endpoint.
    let mut matches: BTreeMap<usize, (usize, ScriptureReference)> = BTreeMap::new();
    for (alias, canonical) in aliases {
        if alias.is_empty() || alias.len() > tokens.len() {
            continue;
        }
        for start in 0..=tokens.len() - alias.len() {
            if tokens[start..start + alias.len()] != alias[..] {
                continue;
            }
            let mut index = start + alias.len();
            if tokens.get(index).is_some_and(|token| token != "chapter")
                && !has_explicit_verse_marker(tokens, index)
            {
                if let Some((chapter, compound_verse_required)) = tokens
                    .get(index)
                    .and_then(|token| parse_compact_chapter(token))
                {
                    let insert_candidate =
                        |matches: &mut BTreeMap<usize, (usize, ScriptureReference)>,
                         candidate: ScriptureReference| {
                            let book_end = start + alias.len();
                            if matches
                                .get(&book_end)
                                .is_none_or(|(length, _)| alias.len() > *length)
                            {
                                matches.insert(book_end, (alias.len(), candidate));
                            }
                        };

                    // Chapter-only spoken references render as the chapter's
                    // first verse ("Psalm twenty three" -> Psalm 23:1): the
                    // card an operator can navigate forward through verse by
                    // verse. A trailing verse number suppresses this fallback
                    // so genuinely ambiguous shapes stay unresolved.

                    // A compound multi-token chapter ("John chapter four five")
                    // must not swallow a trailing verse number.
                    let compact_verse = parse_compact_verse(tokens, index + 1);
                    match compact_verse {
                        Some((verse, verse_next, verse_end)) => {
                            let verse_is_compound = verse_next > index + 2;
                            if !compound_verse_required || verse_is_compound {
                                insert_candidate(
                                    &mut matches,
                                    ScriptureReference {
                                        book: canonical.clone(),
                                        chapter,
                                        verse,
                                        verse_end,
                                    },
                                );
                                continue;
                            }
                            // A spoken tens chapter followed by a small verse
                            // ("Psalm twenty three") nearly always means the
                            // compound chapter number, not the obscure
                            // alternative reading ("Psalm 20:3"). Only a larger
                            // or "10"-plus verse keeps the compound verse
                            // reading ambiguous and unresolved.
                            let ten_ambiguity_resolvable = compound_verse_required
                                && (1..=10).contains(&verse)
                                && verse_next == index + 2
                                && tokens
                                    .get(verse_next)
                                    .is_none_or(|token| single_number_token(token).is_none());
                            if ten_ambiguity_resolvable {
                                if let Some((chapter_only, _)) = parse_number(tokens, index) {
                                    insert_candidate(
                                        &mut matches,
                                        ScriptureReference {
                                            book: canonical.clone(),
                                            chapter: chapter_only,
                                            verse: 1,
                                            verse_end: None,
                                        },
                                    );
                                    continue;
                                }
                            }
                        }
                        None => {
                            // A spoken tens chapter with no verse number
                            // following ("Psalm twenty") still names a
                            // chapter; a small unambiguous chapter followed
                            // by prose ("Act one begins...", "the number one
                            // priority") is everyday speech and stays
                            // unresolved.
                            if compound_verse_required {
                                insert_candidate(
                                    &mut matches,
                                    ScriptureReference {
                                        book: canonical.clone(),
                                        chapter,
                                        verse: 1,
                                        verse_end: None,
                                    },
                                );
                                continue;
                            }
                        }
                    }
                }
            }
            let spoken_chapter_marker = tokens.get(index).is_some_and(|token| token == "chapter");
            if spoken_chapter_marker {
                index += 1;
            }
            let chapter_start = index;
            let Some((chapter, next)) = parse_number(tokens, index) else {
                continue;
            };
            // parse_number assembles compound numbers ("twenty three" -> 23)
            // but also misassembles two unrelated small numbers ("three four"
            // -> 7), so the chapter-only fallback below only accepts single
            // spoken chapter tokens.
            let chapter_is_single_token = next == chapter_start + 1;
            index = next;
            // Natural speech often inserts a bridge between chapter and verse
            // ("Hebrews chapter 2 and verse 1" / "John 16, on verse 13").
            // Treat it as filler only when an explicit verse marker follows,
            // so compact references and hard negatives retain their existing
            // behavior.
            if tokens
                .get(index)
                .is_some_and(|token| token == "and" || token == "on")
                && tokens
                    .get(index + 1)
                    .is_some_and(|token| token == "verse" || token == "verses")
            {
                index += 1;
            }
            let verse_marker = tokens.get(index).cloned();
            if verse_marker
                .as_deref()
                .is_some_and(|token| token == ":" || token == "verse" || token == "verses")
            {
                index += 1;
            } else {
                // "John chapter three" with no verse marker renders as the
                // chapter's first verse when nothing numeric follows; a
                // further number keeps the shape ambiguous and unresolved.
                let chapter_only_allowed = spoken_chapter_marker
                    && chapter_is_single_token
                    && chapter > 0
                    && tokens
                        .get(index)
                        .map(|_| parse_number(tokens, index).is_none())
                        .unwrap_or(true);
                if chapter_only_allowed {
                    let candidate = ScriptureReference {
                        book: canonical.clone(),
                        chapter,
                        verse: 1,
                        verse_end: None,
                    };
                    let book_end = start + alias.len();
                    if matches
                        .get(&book_end)
                        .is_none_or(|(length, _)| alias.len() > *length)
                    {
                        matches.insert(book_end, (alias.len(), candidate));
                    }
                }
                continue;
            }
            let plural_marker = verse_marker.as_deref() == Some("verses");
            let Some((verse, _verse_next, verse_end)) =
                parse_verse_number(tokens, index, plural_marker)
            else {
                continue;
            };
            if chapter > 0 && verse > 0 {
                let candidate = ScriptureReference {
                    book: canonical.clone(),
                    chapter,
                    verse,
                    verse_end,
                };
                let book_end = start + alias.len();
                if matches
                    .get(&book_end)
                    .is_none_or(|(length, _)| alias.len() > *length)
                {
                    matches.insert(book_end, (alias.len(), candidate));
                }
            }
        }
    }
    matches
        .into_values()
        .map(|(_, reference)| reference)
        .collect()
}

/// Compatibility helper for callers that need only the most recently spoken
/// reference in a transcript.
pub fn detect_reference(text: &str, books: &[String]) -> Option<ScriptureReference> {
    detect_references(text, books).pop()
}

pub(crate) fn quote_tokens(text: &str) -> Vec<String> {
    quote_tokens_from_normalized(&tokenize(text))
}

fn contraction_parts(word: &str) -> Option<&'static [&'static str]> {
    Some(match word {
        "don't" | "dont" => &["do", "not"],
        "doesn't" | "doesnt" => &["does", "not"],
        "didn't" | "didnt" => &["did", "not"],
        "isn't" | "isnt" => &["is", "not"],
        "aren't" | "arent" => &["are", "not"],
        "wasn't" | "wasnt" => &["was", "not"],
        "weren't" | "werent" => &["were", "not"],
        "haven't" | "havent" => &["have", "not"],
        "hasn't" | "hasnt" => &["has", "not"],
        "hadn't" | "hadnt" => &["had", "not"],
        "won't" | "wont" => &["will", "not"],
        "wouldn't" | "wouldnt" => &["would", "not"],
        "can't" | "cant" => &["cannot"],
        "couldn't" | "couldnt" => &["could", "not"],
        "shouldn't" | "shouldnt" => &["should", "not"],
        "mustn't" | "mustnt" => &["must", "not"],
        "shan't" | "shant" => &["shall", "not"],
        "ain't" | "aint" => &["is", "not"],
        "i'm" => &["i", "am"],
        "i've" => &["i", "have"],
        "i'll" => &["i", "will"],
        "i'd" => &["i", "would"],
        "you're" | "youre" => &["you", "are"],
        "you've" | "youve" => &["you", "have"],
        "you'll" | "youll" => &["you", "will"],
        "we're" => &["we", "are"],
        "we've" | "weve" => &["we", "have"],
        "we'll" => &["we", "will"],
        "they're" | "theyre" => &["they", "are"],
        "they've" | "theyve" => &["they", "have"],
        "they'll" | "theyll" => &["they", "will"],
        "he's" => &["he", "is"],
        "she's" => &["she", "is"],
        "it's" => &["it", "is"],
        "that's" | "thats" => &["that", "is"],
        "there's" | "theres" => &["there", "is"],
        "what's" | "whats" => &["what", "is"],
        "who's" | "whos" => &["who", "is"],
        "where's" | "wheres" => &["where", "is"],
        "how's" | "hows" => &["how", "is"],
        "let's" | "lets" => &["let", "us"],
        _ => return None,
    })
}

fn archaic_variant(word: &str) -> &str {
    match word {
        "hath" => "has",
        "doth" => "does",
        "saith" => "says",
        "shalt" => "shall",
        "art" => "are",
        "thy" | "thine" => "your",
        "thee" | "thou" => "you",
        "unto" => "to",
        "shew" => "show",
        "shewed" => "showed",
        "shewn" => "shown",
        "brethren" => "brothers",
        "whosoever" => "whoever",
        "whatsoever" => "whatever",
        "wheresoever" => "wherever",
        "verily" => "truly",
        "thyself" => "yourself",
        "goeth" => "goes",
        _ => word,
    }
}

/// Conservative singular/plural fold for quote alignment only. It is applied to
/// both the spoken words and the verse text, so even an imperfect fold remains
/// symmetric and cannot favor one side.
fn stem_plural(word: &str) -> String {
    let length = word.len();
    if length < 4
        || word.ends_with("ss")
        || word.ends_with("us")
        || word.ends_with("is")
        || matches!(word, "verse" | "verses" | "chapter" | "chapters")
    {
        return word.to_string();
    }
    if word.ends_with("sses") {
        return word[..length - 2].to_string();
    }
    if word.ends_with("ies") {
        return format!("{}y", &word[..length - 3]);
    }
    if word.ends_with("ches")
        || word.ends_with("shes")
        || word.ends_with("xes")
    {
        return word[..length - 2].to_string();
    }
    if word.ends_with('s') {
        return word[..length - 1].to_string();
    }
    word.to_string()
}

pub(crate) fn quote_tokens_from_normalized(tokens: &[String]) -> Vec<String> {
    let mut normalized = Vec::with_capacity(tokens.len());
    for token in tokens {
        if token.as_str() == ":" || token.as_str() == "-" {
            continue;
        }
        let word = token.replace('’', "'");
        if let Some(parts) = contraction_parts(&word) {
            normalized.extend(parts.iter().map(|part| (*part).to_string()));
            continue;
        }
        // ASR commonly drops possessive endings ("the Lord" for "the Lord's").
        // Strip only the possessive suffix so short, otherwise exact quotations
        // can still align.
        let word = word
            .strip_suffix("'s")
            // Some legacy Bible rows contain U+FFFD where an apostrophe was
            // decoded incorrectly (for example, "LORD�s").
            .or_else(|| word.strip_suffix("�s"))
            .unwrap_or(&word);
        let word = archaic_variant(word);
        if is_quote_content_word(word) {
            normalized.push(stem_plural(word));
        } else {
            normalized.push(word.to_string());
        }
    }
    normalized
}

fn has_repeated_token_phrase(tokens: &[String]) -> bool {
    if tokens.len() < REPEATED_PHRASE_WORDS * 2 {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    tokens
        .windows(REPEATED_PHRASE_WORDS)
        .any(|phrase| !seen.insert(phrase.join(" ")))
}

#[allow(dead_code)] // also compiled into the standalone evaluator
pub(crate) fn has_repeated_phrase(text: &str) -> bool {
    has_repeated_token_phrase(&quote_tokens(text))
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

pub(crate) fn is_quote_content_word(token: &str) -> bool {
    !matches!(
        token,
        "a" | "all"
            | "also"
            | "an"
            | "and"
            | "any"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "can"
            | "could"
            | "did"
            | "do"
            | "does"
            | "for"
            | "from"
            | "he"
            | "her"
            | "him"
            | "his"
            | "how"
            | "i"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "its"
            | "like"
            | "may"
            | "me"
            | "might"
            | "must"
            | "my"
            | "nor"
            | "not"
            | "of"
            | "on"
            | "or"
            | "our"
            | "shall"
            | "she"
            | "should"
            | "so"
            | "that"
            | "the"
            | "their"
            | "them"
            | "then"
            | "there"
            | "they"
            | "this"
            | "to"
            | "too"
            | "us"
            | "was"
            | "were"
            | "what"
            | "when"
            | "which"
            | "who"
            | "will"
            | "with"
            | "would"
            | "you"
            | "your"
    )
}

fn content_words(tokens: &[String]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| is_quote_content_word(token))
        .cloned()
        .collect()
}

// Also compiled into the standalone AI evaluator (tools/ai-eval), which only
// exercises detection entry points — the word-count helper is used by the app
// crate's ai_scripture command surface, so it is unused there.
#[allow(dead_code)]
pub(crate) fn quote_content_word_count(text: &str) -> usize {
    quote_tokens(text)
        .iter()
        .filter(|token| is_quote_content_word(token))
        .count()
}

fn content_overlap(spoken: &[String], verse: &[String]) -> usize {
    let mut verse_counts: HashMap<&str, usize> = HashMap::new();
    for token in verse.iter().filter(|token| is_quote_content_word(token)) {
        *verse_counts.entry(token.as_str()).or_default() += 1;
    }
    spoken
        .iter()
        .filter(|token| is_quote_content_word(token))
        .filter(|token| {
            let Some(count) = verse_counts.get_mut(token.as_str()) else {
                return false;
            };
            if *count == 0 {
                return false;
            }
            *count -= 1;
            true
        })
        .count()
}

fn longest_contiguous_run(spoken: &[String], verse: &[String]) -> usize {
    let mut longest = 0;
    for start in 0..spoken.len() {
        for verse_start in 0..verse.len() {
            let mut length = 0;
            while start + length < spoken.len()
                && verse_start + length < verse.len()
                && spoken[start + length] == verse[verse_start + length]
            {
                length += 1;
            }
            longest = longest.max(length);
        }
    }
    longest
}

/// Content words inside the best phrase anchor: the maximum number of
/// meaningful words carried by any contiguous run of at least
/// `EMBEDDED_QUOTE_ANCHOR_WORDS` tokens. An anchor made only of function
/// words (for example "in the name of") can line up with almost any verse, so
/// callers require substance before treating a four-word match as a quotation.
fn longest_contiguous_anchor_content(spoken: &[String], verse: &[String]) -> usize {
    let mut best = 0;
    for start in 0..spoken.len() {
        for verse_start in 0..verse.len() {
            let mut length = 0;
            while start + length < spoken.len()
                && verse_start + length < verse.len()
                && spoken[start + length] == verse[verse_start + length]
            {
                length += 1;
            }
            if length >= EMBEDDED_QUOTE_ANCHOR_WORDS {
                let content = spoken[start..start + length]
                    .iter()
                    .filter(|token| is_quote_content_word(token))
                    .count();
                best = best.max(content);
            }
        }
    }
    best
}

fn token_quote_score(spoken: &[String], verse: &[String]) -> f32 {
    if spoken.len() < MIN_DIRECT_QUOTE_WORDS || verse.len() < MIN_DIRECT_QUOTE_WORDS {
        return 0.0;
    }
    let denominator = spoken.len().min(verse.len()) as f32;
    let ordered = lcs_len(spoken, verse) as f32 / denominator;
    let mut verse_counts: HashMap<&str, usize> = HashMap::new();
    for token in verse {
        *verse_counts.entry(token).or_default() += 1;
    }
    let mut overlap = 0usize;
    for token in spoken {
        if let Some(count) = verse_counts.get_mut(token.as_str()) {
            if *count > 0 {
                *count -= 1;
                overlap += 1;
            }
        }
    }
    let lexical = overlap as f32 / denominator;
    let base = ordered * 0.7 + lexical * 0.3;
    // Prefer the canonical verse where a short quotation begins the text over
    // later verses that repeat it inside a longer sentence. Non-prefix quotes
    // remain eligible; this small tie-break only resolves otherwise identical
    // lexical scores (for example Psalm 24:1 vs. 1 Corinthians 10:26).
    let starts_verse = verse.starts_with(spoken);
    base * if starts_verse { 1.0 } else { 0.98 }
}

fn quote_alignment_is_strong(
    spoken: &[String],
    verse: &[String],
    minimum_content_words: usize,
) -> bool {
    let content = content_overlap(spoken, verse);
    if content < minimum_content_words {
        return false;
    }

    let contiguous = longest_contiguous_run(spoken, verse);
    let spoken_content = content_words(spoken);
    let verse_content = content_words(verse);
    let ordered_content = lcs_len(&spoken_content, &verse_content);

    // Short quotations may be nearly exact while differing only by ASR or
    // possessive punctuation (for example, "the earth is the Lord").
    let nearly_exact_short = spoken.len() <= 8
        && contiguous >= spoken.len().saturating_sub(1)
        && content >= minimum_content_words;

    // Longer quotations need an unmistakable phrase anchor. This prevents
    // common words from making unrelated commentary look like a quotation.
    let strong_phrase = contiguous >= 5 && content >= 3;

    // ASR can substitute a word inside an embedded quotation. Four exact
    // words are sufficient only when at least three meaningful words also
    // agree and the anchor itself carries at least two of them, as in "what
    // manner of man" from James 1:24. Function-word anchors ("in the name of")
    // are rejected because they align with nearly every verse.
    let embedded_phrase = contiguous >= EMBEDDED_QUOTE_ANCHOR_WORDS
        && longest_contiguous_anchor_content(spoken, verse) >= 2
        && content >= 3
        && ordered_content >= 3;

    // Permit a heavily punctuated/ASR-resegmented long quotation when many
    // meaningful words remain in order, but never on function-word overlap
    // alone.
    let strong_ordered_alignment = spoken.len() >= 9 && ordered_content >= 5 && content >= 5;

    // ASR can preserve the structure and distinctive content of a short quote
    // while replacing its opening clause (for example, "what shall we do" for
    // "how shall we escape"). Keep this narrow and content-gated so ordinary
    // sermon commentary cannot qualify on a few shared function words.
    let close_short_quote = (7..=14).contains(&spoken.len())
        && lcs_len(spoken, verse) >= 7
        && ordered_content >= 3
        && content >= 3;

    nearly_exact_short
        || strong_phrase
        || embedded_phrase
        || strong_ordered_alignment
        || close_short_quote
}

fn direct_quote_score_tokens(
    spoken: &[String],
    verse: &[String],
    minimum_content_words: usize,
) -> f32 {
    if has_repeated_token_phrase(spoken) {
        return 0.0;
    }
    let mut best = token_quote_score(spoken, verse);
    if !quote_alignment_is_strong(spoken, verse, minimum_content_words) {
        best = 0.0;
    }
    if spoken.len() > EMBEDDED_QUOTE_WINDOW_WORDS {
        for window in spoken.windows(EMBEDDED_QUOTE_WINDOW_WORDS) {
            if quote_alignment_is_strong(window, verse, minimum_content_words) {
                best = best.max(token_quote_score(window, verse));
            }
        }
    }
    best
}

/// Ordered agreement over meaningful words only. This is a secondary signal:
/// it breaks near-ties and helps when ASR inserts or drops function words, but
/// the full-token alignment and content-word gate remain authoritative.
pub(crate) fn content_ordered_score_tokens(spoken: &[String], verse: &[String]) -> f32 {
    let spoken = content_words(spoken);
    let verse = content_words(verse);
    let denominator = spoken.len().min(verse.len());
    if denominator < 3 {
        return 0.0;
    }
    (lcs_len(&spoken, &verse) as f32 / denominator as f32).clamp(0.0, 1.0)
}

pub(crate) fn direct_quote_match_score_tokens(
    spoken_tokens: &[String],
    verse_tokens: &[String],
    minimum_content_words: usize,
) -> Option<(f32, f32)> {
    let score = direct_quote_score_tokens(spoken_tokens, verse_tokens, minimum_content_words);
    let ordered_words = lcs_len(spoken_tokens, verse_tokens);
    let close_short_quote = (7..=14).contains(&spoken_tokens.len())
        && ordered_words >= 7
        && lcs_len(
            &content_words(spoken_tokens),
            &content_words(verse_tokens),
        ) >= 3
        && content_overlap(spoken_tokens, verse_tokens) >= 3;
    let content_ordered = content_ordered_score_tokens(spoken_tokens, verse_tokens);
    ((score >= 0.72 || (close_short_quote && score >= 0.66))
        && ordered_words >= MIN_DIRECT_QUOTE_WORDS)
        .then_some((score, content_ordered))
}

pub(crate) fn direct_quote_match_score_with_content(
    spoken: &str,
    verse: &str,
    minimum_content_words: usize,
) -> Option<(f32, f32)> {
    let spoken_tokens = quote_tokens(spoken);
    let verse_tokens = quote_tokens(verse);
    direct_quote_match_score_tokens(&spoken_tokens, &verse_tokens, minimum_content_words)
}

/// Return the calibrated lexical-alignment score when `spoken` is close enough
/// to `verse` to qualify as a direct quotation suggestion. Callers that know
/// whether the quotation is anchored should use the minimum-content variant.
pub fn direct_quote_match_score(spoken: &str, verse: &str) -> Option<f32> {
    direct_quote_match_score_with_content(spoken, verse, MIN_QUOTE_CONTENT_WORDS)
        .map(|(score, _)| score)
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
            "Esther".into(),
            "Zechariah".into(),
            "1 Corinthians".into(),
            "1 Kings".into(),
            "2 Kings".into(),
            "1 John".into(),
            "2 John".into(),
            "3 John".into(),
            "Song of Solomon".into(),
            "Hebrews".into(),
            "Acts".into(),
            "Numbers".into(),
            "Judges".into(),
            "Romans".into(),
        ]
    }

    #[test]
    fn shared_normalized_tokens_preserve_reference_and_quote_detection() {
        let text = "Please turn to John 3:16, for God so loved the world.";
        let normalized = normalized_transcript_tokens(text);
        let references = detect_references_from_tokens(&normalized, &books());

        assert_eq!(references, detect_references(text, &books()));
        assert_eq!(
            quote_tokens_from_normalized(&normalized),
            quote_tokens(text)
        );
    }

    #[test]
    fn detects_numeric_and_spoken_references() {
        assert_eq!(
            detect_reference("Please turn to John 3:16 today", &books()),
            Some(ScriptureReference {
                book: "John".into(),
                chapter: 3,
                verse: 16,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("First Corinthians chapter thirteen verse four", &books()),
            Some(ScriptureReference {
                book: "1 Corinthians".into(),
                chapter: 13,
                verse: 4,
                verse_end: None,
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
                verse: 105,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_references("Psalm one one nine verse one one one", &books()),
            vec![ScriptureReference {
                book: "Psalms".into(),
                chapter: 119,
                verse: 111,
                verse_end: None,
            }],
            "digit-by-digit ASR references must not become a Psalm 1 range"
        );
        assert_eq!(
            detect_reference(
                "Psalm one one nine verses one one one and one one two",
                &books()
            ),
            Some(ScriptureReference {
                book: "Psalms".into(),
                chapter: 119,
                verse: 111,
                verse_end: Some(112),
            }),
            "digit-by-digit ASR ranges must retain their end verse"
        );
        assert_eq!(
            detect_reference(
                "Because if we go to Hebrews chapter 2 and verse 1, we'll see that this is scriptural.",
                &books()
            ),
            Some(ScriptureReference {
                book: "Hebrews".into(),
                chapter: 2,
                verse: 1,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("Now watch John 16, on verse 13.", &books()),
            Some(ScriptureReference {
                book: "John".into(),
                chapter: 16,
                verse: 13,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference(
                "First Corinthians chapter 10, verses eleven and twelve.",
                &books()
            ),
            Some(ScriptureReference {
                book: "1 Corinthians".into(),
                chapter: 10,
                verse: 11,
                verse_end: Some(12),
            })
        );
    }

    #[test]
    fn verse_range_policy_agrees_between_marker_variants() {
        // Shared helper: "and" continues a range only for the plural marker.
        let plural = parse_verse_number(&tokenize("verses eleven and twelve"), 1, true);
        assert_eq!(
            plural,
            Some((11, 4, Some(12))),
            "verses eleven and twelve should parse as an inclusive range"
        );
        let singular = parse_verse_number(&tokenize("verse ten and twelve"), 1, false);
        assert_eq!(
            singular,
            Some((10, 2, None)),
            "a singular marker must not treat 'and' as a range separator"
        );
        let explicitly_marked_second = parse_verse_number(
            &tokenize("verse twenty eight and verse twenty nine"),
            1,
            false,
        );
        assert_eq!(
            explicitly_marked_second,
            Some((28, 7, Some(29))),
            "a second explicit verse marker must form a range"
        );
        let spoken_range = parse_verse_number(&tokenize("verses 5 to 6"), 1, true);
        assert_eq!(spoken_range, Some((5, 4, Some(6))));
        let descending = parse_verse_number(&tokenize("verses ten to eight"), 1, true);
        assert_eq!(descending, Some((10, 2, None)), "end must be >= start");
    }

    #[test]
    fn detects_compact_references_without_chapter_verse_words() {
        assert_eq!(
            detect_reference("Revelation five eleven", &books()),
            Some(ScriptureReference {
                book: "Revelation".into(),
                chapter: 5,
                verse: 11,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("Matthew six thirty three", &books()),
            Some(ScriptureReference {
                book: "Matthew".into(),
                chapter: 6,
                verse: 33,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("Matthew six nine ten", &books()),
            Some(ScriptureReference {
                book: "Matthew".into(),
                chapter: 6,
                verse: 9,
                verse_end: Some(10),
            })
        );
        assert_eq!(
            detect_reference("Psalm twenty three", &books()),
            Some(ScriptureReference {
                book: "Psalms".into(),
                chapter: 23,
                verse: 1,
                verse_end: None,
            }),
            "a spoken tens chapter with a small verse resolves as the compound \
             chapter number and renders as the chapter's first verse"
        );
        assert_eq!(
            detect_reference("Hebrew one six", &books()),
            Some(ScriptureReference {
                book: "Hebrews".into(),
                chapter: 1,
                verse: 6,
                verse_end: None,
            })
        );
    }

    #[test]
    fn chapter_only_spoken_references_render_the_first_verse() {
        // The calibration corpus' Psalm-23 case: "Psalm twenty three" is the
        // compound chapter number, not the obscure Psalm 20:3 reading.
        assert_eq!(
            detect_reference("Our reading is Psalm twenty three.", &books()),
            Some(ScriptureReference {
                book: "Psalms".into(),
                chapter: 23,
                verse: 1,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("Revelation twenty one tells of the new heaven.", &books()),
            Some(ScriptureReference {
                book: "Revelation".into(),
                chapter: 21,
                verse: 1,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("Stay with me in John chapter three.", &books()),
            Some(ScriptureReference {
                book: "John".into(),
                chapter: 3,
                verse: 1,
                verse_end: None,
            })
        );
        assert_eq!(
            detect_reference("John four is the woman at the well.", &books()),
            None,
            "an unambiguous small chapter followed by prose is everyday speech, \
             not a chapter reference"
        );
        // Ambiguous shapes stay unresolved.
        assert_eq!(
            detect_reference("John twenty twelve", &books()),
            None,
            "a larger verse after a tens chapter keeps the compound verse reading \
             ambiguous"
        );
        assert_eq!(
            detect_reference("John chapter three four", &books()),
            None,
            "a trailing verse number after the chapter marker keeps the shape \
             ambiguous"
        );
    }

    #[test]
    fn numbered_john_books_are_not_truncated_to_john() {
        for (transcript, book, chapter, verse) in [
            ("First John 5:18", "1 John", 5, 18),
            ("Second John 1:2", "2 John", 1, 2),
            ("Third John 1:3", "3 John", 1, 3),
            ("1 John 1:5", "1 John", 1, 5),
        ] {
            assert_eq!(
                detect_reference(transcript, &books()),
                Some(ScriptureReference {
                    book: book.into(),
                    chapter,
                    verse,
                    verse_end: None,
                }),
                "failed to preserve the numbered book in {transcript}"
            );
        }
    }

    #[test]
    fn later_reference_still_wins_after_numbered_book_disambiguation() {
        assert_eq!(
            detect_reference("First John 5:18, then John 1:5", &books()),
            Some(ScriptureReference {
                book: "John".into(),
                chapter: 1,
                verse: 5,
                verse_end: None,
            })
        );
    }

    #[test]
    fn finds_each_reference_in_a_single_continuous_turn() {
        assert_eq!(
            detect_references("Turn to John 3:16, then Romans 8:1.", &books()),
            vec![
                ScriptureReference {
                    book: "John".into(),
                    chapter: 3,
                    verse: 16,
                    verse_end: None,
                },
                ScriptureReference {
                    book: "Romans".into(),
                    chapter: 8,
                    verse: 1,
                    verse_end: None,
                },
            ]
        );
    }

    #[test]
    fn recognizes_narrow_common_asr_book_aliases() {
        for (transcript, book, chapter, verse) in [
            ("Ester 1:3", "Esther", 1, 3),
            ("Revelations 5:11", "Revelation", 5, 11),
            ("Zachariah 8:23", "Zechariah", 8, 23),
        ] {
            assert_eq!(
                detect_reference(transcript, &books()),
                Some(ScriptureReference {
                    book: book.into(),
                    chapter,
                    verse,
                    verse_end: None,
                }),
                "failed to recognize ASR spelling in {transcript}"
            );
        }
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

    #[test]
    fn aligns_observed_hebrews_two_quotation_despite_asr_spelling() {
        assert!(direct_quote_match_score(
            "For if the word spoken by angels was steadfast, that every transgression disobedience received the just recompense of reward",
            "For if the word spoken by angels was stedfast, and every transgression and disobedience received a just recompence of reward;"
        )
        .is_some());
        assert!(direct_quote_match_score(
            "How shall we escape if we neglect so great a salvation, which at first was spoken by the Lord, confirmed unto us by those that heard him",
            "How shall we escape, if we neglect so great salvation; which at the first began to be spoken by the Lord, and was confirmed unto us by them that heard him;"
        )
        .is_some());
    }

    #[test]
    fn aligns_ephesians_five_eighteen_with_minor_asr_variation() {
        assert!(direct_quote_match_score(
            "Do not be drunk with wine wherein it excesses, but there is another substance that can enter into you.",
            "And be not drunk with wine, wherein is excess; but be filled with the Spirit;"
        )
        .is_some());
    }

    #[test]
    fn aligns_short_quote_when_asr_replaces_the_opening_clause() {
        let score = direct_quote_match_score(
            "What shall we do if we neglect this great a salvation?",
            "How shall we escape, if we neglect so great salvation;",
        )
        .expect("the preserved quote structure and content should qualify");
        assert!(score >= 0.66);
    }

    #[test]
    fn normalizes_contractions_archaic_spellings_and_plurals() {
        assert_eq!(quote_tokens("do not"), quote_tokens("don't"));
        assert_eq!(quote_tokens("you shall not"), quote_tokens("thou shalt not"));
        assert_eq!(quote_tokens("brothers"), quote_tokens("brethren"));
        assert_eq!(quote_tokens("sin"), quote_tokens("sins"));
        assert_eq!(quote_tokens("the Lord"), quote_tokens("the Lord's"));
        assert_eq!(quote_tokens("show"), quote_tokens("shew"));
    }

    #[test]
    fn content_ordered_score_rewards_meaningful_word_order() {
        let verse = quote_tokens("The LORD is my shepherd; I shall not want.");
        let ordered =
            content_ordered_score_tokens(&quote_tokens("lord shepherd want"), &verse);
        let reordered =
            content_ordered_score_tokens(&quote_tokens("lord want shepherd"), &verse);
        assert!(ordered > reordered);
        assert!(ordered > 0.9);
    }

    #[test]
    fn loose_quotes_require_three_content_words() {
        let verse = "The earth is the Lord's, and the fullness thereof.";
        assert!(
            direct_quote_match_score_with_content("The earth is the Lord", verse, 2).is_some()
        );
        assert!(
            direct_quote_match_score_with_content("The earth is the Lord", verse, 3).is_none()
        );
        assert!(direct_quote_match_score_with_content(
            "The Lord is my shepherd I shall not want",
            "The LORD is my shepherd; I shall not want.",
            3,
        )
        .is_some());
    }

    #[test]
    fn finds_an_embedded_quote_but_rejects_repeated_self_correction() {
        assert!(direct_quote_match_score(
            "I used to look at myself in the mirror and have encounters with the word, and I go my way and forget what manner of man that I am.",
            "For he beholdeth himself, and goeth his way, and straightway forgetteth what manner of man he was."
        )
        .is_some());
        assert!(direct_quote_match_score(
            "Daddy, look at that. I put my hand, I put my hand in my teeth.",
            "Wherefore do I take my flesh in my teeth, and put my life in mine hand?"
        )
        .is_none());
    }

    #[test]
    fn rejects_common_word_overlap_as_a_direct_quote() {
        assert!(direct_quote_match_score(
            "From the party, it was so bad. I never recall that we had met.",
            "Therefore Daniel went in unto Arioch, whom the king had ordained to destroy the wise men of Babylon: he went and said thus unto him; Destroy not the wise men of Babylon: bring me in before the king, and I will shew unto the king the interpretation."
        )
        .is_none());
        assert!(direct_quote_match_score(
            "This is why when they say it is an explosion that brought the order to the world.",
            "And he said, What meanest thou by all this drove which I met? And he said, These are to find grace in the sight of my lord."
        )
        .is_none());
        assert!(direct_quote_match_score(
            "People from different nations were hearing each one speak the language fluently.",
            "And how hear we every man in our own tongue, wherein we were born?"
        )
        .is_none());
        assert!(direct_quote_match_score(
            "All that it might be fulfilled.",
            "Now all this was done, that it might be fulfilled which was spoken of the Lord by the prophet, saying,"
        )
        .is_none());
    }

    #[test]
    fn direct_quote_accepts_five_words_with_dropped_possessive() {
        let psalm_score = direct_quote_match_score(
            "The earth is the Lord.",
            "The earth is the Lord's, and all its fullness, the world and those who dwell therein.",
        )
        .unwrap();
        let repeated_score = direct_quote_match_score(
            "The earth is the Lord.",
            "For the earth is the Lord's, and all its fullness.",
        )
        .unwrap();
        assert!(psalm_score > repeated_score);
        assert!(direct_quote_match_score(
            "Earth is the Lord.",
            "The earth is the Lord's, and all its fullness."
        )
        .is_none());
        assert_eq!(
            quote_tokens("The earth is the LORD�s."),
            quote_tokens("The earth is the Lord.")
        );
    }

    #[test]
    fn detects_curated_singular_book_aliases() {
        for (transcript, book) in [
            ("Act one six", "Acts"),
            ("Number one six", "Numbers"),
            ("Judge one six", "Judges"),
            ("Roman one six", "Romans"),
        ] {
            assert_eq!(
                detect_reference(transcript, &books()),
                Some(ScriptureReference {
                    book: book.into(),
                    chapter: 1,
                    verse: 6,
                    verse_end: None,
                }),
                "failed to parse {transcript}"
            );
        }
    }

    #[test]
    fn common_word_is_is_not_a_spoken_isaiah_reference() {
        let books = vec!["Isaiah".into(), "Matthew".into()];
        assert_eq!(
            detect_reference("this is chapter fourteen verse thirty one", &books),
            None
        );
        assert_eq!(
            detect_reference("Matthew chapter fourteen verse thirty one", &books),
            Some(ScriptureReference {
                book: "Matthew".into(),
                chapter: 14,
                verse: 31,
                verse_end: None,
            })
        );
    }

    #[test]
    fn detects_singular_numbered_kings_aliases() {
        for (transcript, book) in [
            ("First King three five", "1 Kings"),
            ("Second King six sixteen", "2 Kings"),
        ] {
            assert_eq!(
                detect_reference(transcript, &books()),
                Some(ScriptureReference {
                    book: book.into(),
                    chapter: if book == "1 Kings" { 3 } else { 6 },
                    verse: if book == "1 Kings" { 5 } else { 16 },
                    verse_end: None,
                }),
                "failed to parse {transcript}"
            );
        }
    }
}
