//! In-memory rare-word candidate index for direct Scripture quotations.
//!
//! The previous quote path asked SQLite FTS for every 24-word window, first with
//! an exact phrase, then an AND query, then a very broad OR query. Continuous
//! sermon audio creates many overlapping windows, so the OR tier dominated the
//! listening pipeline. This index is built once per installed translation for
//! the session and narrows a window to a small set of verses using rare content
//! words before the expensive lexical alignment runs.
//!
//! Common words such as "lord", "god", "said" and "again" do not become
//! candidates. That is deliberate: a common phrase is not a quotation merely
//! because it appears somewhere in Scripture.

use crate::ai_detection::{is_quote_content_word, quote_tokens};
use crate::store::{BibleStore, Verse};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Terms appearing in more verses than this are too common to be useful for
/// candidate generation. The exact value is deliberately conservative; a true
/// quotation normally contains at least one distinctive word.
const MAX_RARE_TERM_DF: usize = 900;
/// Keep the candidate pool small enough that lexical alignment remains cheap.
pub(super) const MAX_QUOTE_CANDIDATES: usize = 64;
const MAX_QUERY_TERMS: usize = 8;
/// A single common-ish term may still be enough to recover a very short quote
/// such as "The Lord is my shepherd", but only when its posting list is small.
const MAX_SINGLE_TERM_DF: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct QuoteCandidate {
    pub verse_index: usize,
    pub rare_terms: usize,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct QuoteHit {
    pub verse_index: usize,
    pub score: f32,
    pub rare_terms: usize,
}

pub(super) struct QuoteSearchIndex {
    version: String,
    verses: Vec<Verse>,
    postings: HashMap<String, Vec<u32>>,
    document_frequency: HashMap<String, usize>,
}

impl QuoteSearchIndex {
    pub(super) fn build(version: String, verses: Vec<Verse>) -> Self {
        // Build every content-word posting list first, then discard the common
        // terms. Tokenizing once makes session startup materially cheaper than
        // a two-pass build, especially in debug builds.
        let mut postings: HashMap<String, Vec<u32>> = HashMap::new();
        for (index, verse) in verses.iter().enumerate() {
            let mut seen = HashSet::new();
            for token in quote_tokens(&verse.text) {
                if token.len() < 3 || !is_quote_content_word(&token) || !seen.insert(token.clone())
                {
                    continue;
                }
                postings.entry(token).or_default().push(index as u32);
            }
        }

        let document_frequency: HashMap<String, usize> = postings
            .iter()
            .map(|(term, entries)| (term.clone(), entries.len()))
            .collect();
        postings.retain(|_, entries| entries.len() <= MAX_RARE_TERM_DF);

        Self {
            version,
            verses,
            postings,
            document_frequency,
        }
    }

    pub(super) fn version(&self) -> &str {
        &self.version
    }

    pub(super) fn verse(&self, index: usize) -> Option<&Verse> {
        self.verses.get(index)
    }

    pub(super) fn verse_count(&self) -> usize {
        self.verses.len()
    }

    /// Returns candidates ordered by the number of matching rare query terms.
    /// No FTS query or full-corpus LIKE scan is performed here.
    pub(super) fn candidates(&self, text: &str) -> Vec<QuoteCandidate> {
        let mut seen = HashSet::new();
        let mut terms: Vec<(String, usize)> = quote_tokens(text)
            .into_iter()
            .filter(|token| {
                token.len() >= 3
                    && is_quote_content_word(token)
                    && self.postings.contains_key(token)
                    && seen.insert(token.clone())
            })
            .filter_map(|token| {
                self.document_frequency
                    .get(&token)
                    .copied()
                    .map(|df| (token, df))
            })
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }
        terms.sort_by_key(|(_, df)| *df);
        terms.truncate(MAX_QUERY_TERMS);

        let strongest_df = terms[0].1;
        let required = if terms.len() >= 2 {
            2
        } else if strongest_df <= MAX_SINGLE_TERM_DF {
            1
        } else {
            return Vec::new();
        };

        let mut counts: HashMap<u32, usize> = HashMap::new();
        for (term, _) in &terms {
            if let Some(postings) = self.postings.get(term) {
                for index in postings {
                    *counts.entry(*index).or_default() += 1;
                }
            }
        }

        let mut candidates: Vec<QuoteCandidate> = counts
            .into_iter()
            .filter(|(_, count)| *count >= required)
            .map(|(verse_index, rare_terms)| QuoteCandidate {
                verse_index: verse_index as usize,
                rare_terms,
            })
            .collect();

        // An ASR substitution can remove one of the two rare terms. If the
        // strict request produced very little, allow one-term candidates
        // through; the lexical alignment still has to accept the verse.
        if candidates.len() < 16 {
            for (term, df) in &terms {
                if *df > MAX_SINGLE_TERM_DF {
                    continue;
                }
                if let Some(postings) = self.postings.get(term) {
                    for index in postings {
                        if !candidates
                            .iter()
                            .any(|candidate| candidate.verse_index == *index as usize)
                        {
                            candidates.push(QuoteCandidate {
                                verse_index: *index as usize,
                                rare_terms: 1,
                            });
                        }
                    }
                }
            }
        }

        candidates.sort_by(|left, right| {
            right
                .rare_terms
                .cmp(&left.rare_terms)
                .then_with(|| left.verse_index.cmp(&right.verse_index))
        });
        candidates.truncate(MAX_QUOTE_CANDIDATES);
        candidates
    }
}

/// Lazily builds an index for the currently selected output translation.
/// Version changes are uncommon, so a single-entry cache is enough for the
/// common case while still allowing the operator to switch translations.
pub(super) struct QuoteIndexCache {
    bible: Arc<BibleStore>,
    index: Option<Arc<QuoteSearchIndex>>,
}

impl QuoteIndexCache {
    pub(super) fn new(bible: Arc<BibleStore>) -> Self {
        Self { bible, index: None }
    }

    pub(super) fn get_or_build(&mut self, version: &str) -> Result<Arc<QuoteSearchIndex>, String> {
        if let Some(index) = &self.index {
            if index.version == version {
                return Ok(index.clone());
            }
        }
        let verses = self
            .bible
            .verses_for_version(version)
            .map_err(|error| error.to_string())?;
        let index = Arc::new(QuoteSearchIndex::build(version.to_string(), verses));
        self.index = Some(index.clone());
        Ok(index)
    }
}

#[derive(Default)]
pub(super) struct QuoteSearchCache {
    entries: HashMap<u64, Option<QuoteHit>>,
}

impl QuoteSearchCache {
    pub(super) fn get(&self, version: &str, window: &str) -> Option<Option<QuoteHit>> {
        self.entries.get(&cache_key(version, window)).copied()
    }

    pub(super) fn insert(&mut self, version: &str, window: &str, hit: Option<QuoteHit>) {
        if self.entries.len() > 4_096 {
            self.entries.clear();
        }
        self.entries.insert(cache_key(version, window), hit);
    }
}

fn cache_key(version: &str, window: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    version.hash(&mut hasher);
    window.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verse(book: &str, chapter: i32, number: i32, text: &str) -> Verse {
        Verse {
            book: book.into(),
            chapter,
            verse: number,
            text: text.into(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        }
    }

    #[test]
    fn rare_words_narrow_the_candidate_pool() {
        let index = QuoteSearchIndex::build(
            "KJV".into(),
            vec![
                verse(
                    "Psalms",
                    23,
                    1,
                    "The LORD is my shepherd; I shall not want.",
                ),
                verse(
                    "John",
                    3,
                    16,
                    "For God so loved the world, that he gave his only begotten Son.",
                ),
                verse(
                    "Isaiah",
                    55,
                    11,
                    "So shall my word be that goeth forth out of my mouth.",
                ),
            ],
        );

        let candidates = index.candidates("The Lord is my shepherd");
        assert!(candidates.iter().any(|candidate| index
            .verse(candidate.verse_index)
            .unwrap()
            .verse
            == 1));
        assert!(index.candidates("now let me tell you this").is_empty());
    }

    #[test]
    fn cache_is_scoped_to_the_selected_translation() {
        let mut cache = QuoteSearchCache::default();
        let hit = QuoteHit {
            verse_index: 4,
            score: 0.9,
            rare_terms: 2,
        };
        cache.insert("KJV", "the ark went upon the waters", Some(hit));
        assert!(cache
            .get("KJV", "the ark went upon the waters")
            .unwrap()
            .is_some());
        assert!(cache.get("NIV", "the ark went upon the waters").is_none());
    }
}
