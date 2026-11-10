// `ai_detection.rs` resolves book names through the canonical catalog, which
// lives in the app crate root — net-new to commit "unify scripture retrieval
// catalog". Path-include it here too so the standalone evaluator sees the
// same `crate::scripture_catalog` namespace. It has no cross-crate deps.
// `allow(dead_code)`: the evaluator only exercises the detection entry points,
// so unused catalog helpers are still compiled but intentionally not called.
#[allow(dead_code)]
#[path = "../../../src-tauri/src/scripture_catalog.rs"]
mod scripture_catalog;

#[path = "../../../src-tauri/src/ai_detection.rs"]
mod ai_detection;

use ai_detection::{detect_reference, direct_quote_match_score, ScriptureReference};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const MIN_REFERENCE_PRECISION: f64 = 0.99;
const MIN_REFERENCE_RECALL: f64 = 0.90;
const MIN_QUOTE_PRECISION: f64 = 0.90;
const MIN_QUOTE_RECALL: f64 = 0.80;

const CANONICAL_BOOKS: &[&str] = &[
    "Genesis",
    "Exodus",
    "Leviticus",
    "Numbers",
    "Deuteronomy",
    "Joshua",
    "Judges",
    "Ruth",
    "1 Samuel",
    "2 Samuel",
    "1 Kings",
    "2 Kings",
    "1 Chronicles",
    "2 Chronicles",
    "Ezra",
    "Nehemiah",
    "Esther",
    "Job",
    "Psalms",
    "Proverbs",
    "Ecclesiastes",
    "Song of Solomon",
    "Isaiah",
    "Jeremiah",
    "Lamentations",
    "Ezekiel",
    "Daniel",
    "Hosea",
    "Joel",
    "Amos",
    "Obadiah",
    "Jonah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Matthew",
    "Mark",
    "Luke",
    "John",
    "Acts",
    "Romans",
    "1 Corinthians",
    "2 Corinthians",
    "Galatians",
    "Ephesians",
    "Philippians",
    "Colossians",
    "1 Thessalonians",
    "2 Thessalonians",
    "1 Timothy",
    "2 Timothy",
    "Titus",
    "Philemon",
    "Hebrews",
    "James",
    "1 Peter",
    "2 Peter",
    "1 John",
    "2 John",
    "3 John",
    "Jude",
    "Revelation",
];

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct ExpectedReference {
    book: String,
    chapter: i32,
    verse: i32,
}

impl From<ScriptureReference> for ExpectedReference {
    fn from(reference: ScriptureReference) -> Self {
        Self {
            book: reference.book,
            chapter: reference.chapter,
            verse: reference.verse,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Fixture {
    Reference {
        id: String,
        transcript: String,
        expected: Option<ExpectedReference>,
    },
    Quote {
        id: String,
        transcript: String,
        candidates: Vec<QuoteCandidate>,
        expected: Option<ExpectedReference>,
    },
}

#[derive(Debug, Deserialize)]
struct QuoteCandidate {
    book: String,
    chapter: i32,
    verse: i32,
    text: String,
}

impl QuoteCandidate {
    fn reference(&self) -> ExpectedReference {
        ExpectedReference {
            book: self.book.clone(),
            chapter: self.chapter,
            verse: self.verse,
        }
    }
}

#[derive(Default)]
struct Metrics {
    total: usize,
    correct: usize,
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
    latencies: Vec<Duration>,
}

impl Metrics {
    fn observe(
        &mut self,
        id: &str,
        expected: Option<&ExpectedReference>,
        predicted: Option<&ExpectedReference>,
        latency: Duration,
    ) {
        self.total += 1;
        self.latencies.push(latency);
        match (expected, predicted) {
            (Some(expected), Some(predicted)) if expected == predicted => {
                self.correct += 1;
                self.true_positive += 1;
            }
            (None, None) => self.correct += 1,
            (Some(expected), Some(predicted)) => {
                self.false_positive += 1;
                self.false_negative += 1;
                eprintln!(
                    "MISS {id}: expected {}, predicted {}",
                    format_reference(expected),
                    format_reference(predicted)
                );
            }
            (Some(expected), None) => {
                self.false_negative += 1;
                eprintln!(
                    "MISS {id}: expected {}, predicted none",
                    format_reference(expected)
                );
            }
            (None, Some(predicted)) => {
                self.false_positive += 1;
                eprintln!(
                    "FALSE POSITIVE {id}: predicted {}",
                    format_reference(predicted)
                );
            }
        }
    }

    fn precision(&self) -> f64 {
        ratio(self.true_positive, self.true_positive + self.false_positive)
    }

    fn recall(&self) -> f64 {
        ratio(self.true_positive, self.true_positive + self.false_negative)
    }

    fn f1(&self) -> f64 {
        let precision = self.precision();
        let recall = self.recall();
        if precision + recall == 0.0 {
            0.0
        } else {
            2.0 * precision * recall / (precision + recall)
        }
    }

    fn accuracy(&self) -> f64 {
        ratio(self.correct, self.total)
    }

    fn p95_ms(&self) -> f64 {
        if self.latencies.is_empty() {
            return 0.0;
        }
        let mut samples = self.latencies.clone();
        samples.sort_unstable();
        let index = ((samples.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len() - 1);
        samples[index].as_secs_f64() * 1_000.0
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn format_reference(reference: &ExpectedReference) -> String {
    format!(
        "{} {}:{}",
        reference.book, reference.chapter, reference.verse
    )
}

fn best_quote_candidate(
    transcript: &str,
    candidates: &[QuoteCandidate],
) -> Option<ExpectedReference> {
    candidates
        .iter()
        .filter_map(|candidate| {
            direct_quote_match_score(transcript, &candidate.text).map(|score| (candidate, score))
        })
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(candidate, _)| candidate.reference())
}

fn print_metrics(label: &str, metrics: &Metrics) {
    println!(
        "{label:<11} fixtures={:<3} precision={:.3} recall={:.3} f1={:.3} exact={:.3} detector_p95_ms={:.3}",
        metrics.total,
        metrics.precision(),
        metrics.recall(),
        metrics.f1(),
        metrics.accuracy(),
        metrics.p95_ms(),
    );
}

fn main() -> anyhow::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("evaluation/ai-scripture/synthetic.jsonl"));
    let file = File::open(&path)
        .map_err(|error| anyhow::anyhow!("Could not open {}: {error}", path.display()))?;
    let books = CANONICAL_BOOKS
        .iter()
        .map(|book| (*book).to_string())
        .collect::<Vec<_>>();
    let mut references = Metrics::default();
    let mut quotes = Metrics::default();

    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let fixture: Fixture = serde_json::from_str(trimmed).map_err(|error| {
            anyhow::anyhow!(
                "Invalid fixture at {}:{}: {error}",
                path.display(),
                index + 1
            )
        })?;
        match fixture {
            Fixture::Reference {
                id,
                transcript,
                expected,
            } => {
                let started = Instant::now();
                let predicted = detect_reference(&transcript, &books).map(ExpectedReference::from);
                references.observe(
                    &id,
                    expected.as_ref(),
                    predicted.as_ref(),
                    started.elapsed(),
                );
            }
            Fixture::Quote {
                id,
                transcript,
                candidates,
                expected,
            } => {
                let started = Instant::now();
                let predicted = best_quote_candidate(&transcript, &candidates);
                quotes.observe(
                    &id,
                    expected.as_ref(),
                    predicted.as_ref(),
                    started.elapsed(),
                );
            }
        }
    }

    println!("AI Scripture evaluation: {}", path.display());
    print_metrics("references", &references);
    print_metrics("quotes", &quotes);

    let passed = references.precision() >= MIN_REFERENCE_PRECISION
        && references.recall() >= MIN_REFERENCE_RECALL
        && quotes.precision() >= MIN_QUOTE_PRECISION
        && quotes.recall() >= MIN_QUOTE_RECALL;
    if !passed {
        anyhow::bail!(
            "Evaluation thresholds failed (reference precision/recall >= {MIN_REFERENCE_PRECISION:.2}/{MIN_REFERENCE_RECALL:.2}; quote precision/recall >= {MIN_QUOTE_PRECISION:.2}/{MIN_QUOTE_RECALL:.2})"
        );
    }
    println!("Evaluation thresholds passed.");
    Ok(())
}
