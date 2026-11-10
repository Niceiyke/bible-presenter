use crate::ai_detection::has_repeated_phrase;
use crate::store::{BibleStore, SemanticCorpusVerse, Verse};
use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, RerankInitOptionsUserDefined, TextEmbedding,
    TextRerank, TokenizerFiles, UserDefinedEmbeddingModel, UserDefinedRerankingModel,
};
use hf_hub::{Repo, RepoType};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};

const INDEX_MAGIC: &[u8; 8] = b"WLYSEM04";
const INDEX_FILE_BASE: &str = "bible-semantic-bge-base-v1";
/// Superseded aggregate index that concatenated every installed translation
/// into one document per verse (truncated at the model's token limit). It is
/// removed during preparation now that each translation owns an index.
const LEGACY_INDEX_FILE: &str = "bible-semantic-bge-v1.index";
/// Release asset with pre-built per-version indexes produced by
/// tools/semantic-index-builder (Google Colab). Preparation downloads it
/// first and falls back to embedding each version locally when the bundle is
/// unavailable or any version's fingerprint does not match the installed
/// Bible text.
const PREBUILT_BUNDLE_URL: &str = "https://github.com/Niceiyke/bible-presenter/releases/latest/download/bible-semantic-bge-base-v1.zip";
const PREBUILT_BUNDLE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const READY_MARKER: &str = "prepared-v1";
const MODEL_ID: &str = "BAAI/bge-base-en-v1.5-quantized";
const MODEL_REPOSITORY: &str = "Xenova/bge-base-en-v1.5";
const MODEL_REVISION: &str = "4d6cd88e18e51a5e020c2c305726d76ada9c03cf";
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
const MODEL_FILES: &[(&str, &str)] = &[
    (
        "onnx/model_quantized.onnx",
        "c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d",
    ),
    (
        "tokenizer.json",
        "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    ),
    (
        "config.json",
        "d83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e",
    ),
    (
        "special_tokens_map.json",
        "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    ),
    (
        "tokenizer_config.json",
        "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    ),
];
/// Translations that get their own paraphrase index. Matching runs against the
/// translation the operator is projecting, so the spoken paraphrase and the
/// indexed text share one language register.
const SEMANTIC_INDEX_VERSIONS: &[&str] = &["NKJV", "ASV", "WEB", "NIV", "AMP"];
const EMBEDDING_DIMENSION: usize = 768;
const MIN_QUERY_WORDS: usize = 5;
/// Minimum cosine similarity for the *dense* retrieval health probe. Ranking
/// in production is decided by a cross-encoder, so raw cosine is now only a
/// diagnostic (and a guard against an index/model mismatch).
pub const MIN_SIMILARITY: f32 = 0.62;
pub const MIN_MARGIN: f32 = 0.025;
/// Cross-encoder that re-ranks the hybrid candidate pool. A dedicated
/// reranker separates near-paraphrases far better than cosine does: on the
/// paraphrase fixture the weakest correct top-1 scores 0.331 after the switch
/// while the strongest real negative scores 0.005 (before: 0.615 vs 0.606).
const RERANKER_REPOSITORY: &str = "Xenova/ms-marco-MiniLM-L-6-v2";
const RERANKER_REVISION: &str = "a09144355adeed5f58c8ed011d209bf8ee5a1fec";
const RERANKER_DIRECTORY: &str = "reranker";
const RERANKER_FILES: &[(&str, &str)] = &[
    (
        "onnx/model_quantized.onnx",
        "e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe",
    ),
    (
        "tokenizer.json",
        "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    ),
    (
        "config.json",
        "d827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e",
    ),
    (
        "special_tokens_map.json",
        "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    ),
    (
        "tokenizer_config.json",
        "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
    ),
];
const RERANK_MAX_LENGTH: usize = 256;
/// Accept when the winning logit maps to at least this probability.
/// The weakest correct top-1 pair scores 0.331 and the strongest real
/// negative 0.005; repeated-speech noise (0.506) is already filtered by
/// `has_repeated_phrase` before ranking.
pub const MIN_RERANK_SIMILARITY: f32 = 0.25;
/// Dense candidates fed to the reranker, plus lexical FTS candidates that the
/// dense retriever misses entirely.
const RERANK_POOL_SIZE: usize = 24;
const LEXICAL_CANDIDATE_LIMIT: usize = 12;
/// Blend weight for the normalized dense score; the rest comes from the
/// cross-encoder. Dense-only is 1.0, reranker-only 0.0. Measured top-1 is
/// stable between 0.25 and 0.60, so the midpoint of that plateau is safe.
const BLEND_DENSE_WEIGHT: f32 = 0.25;
const MAX_SEMANTIC_SUGGESTIONS: usize = 3;
#[cfg(test)]
const RANKING_POOL_SIZE: usize = 24;
const MAX_ALTERNATIVE_DELTA: f32 = 0.10;
const MAX_PASSAGE_NEIGHBOR_DELTA: f32 = 0.05;
const PASSAGE_CONTEXT_WEIGHT: f32 = 0.10;
pub const MAX_PARAPHRASE_CONFIDENCE: f32 = 0.89;
const PREPARATION_CANCELLED: &str = "Local paraphrase preparation was cancelled.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    pub state: String,
    pub message: String,
    pub indexed: usize,
    pub total: usize,
    pub model: String,
    pub disk_bytes: u64,
    pub verified: bool,
}

#[derive(Debug, Clone)]
pub struct SemanticMatch {
    pub verse: Verse,
    pub confidence: f32,
    pub similarity: f32,
    pub margin: f32,
    pub rank: usize,
    pub passage_start: i32,
    pub passage_end: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDiagnosticCandidate {
    pub reference: String,
    pub similarity: f32,
    pub passage_start: i32,
    pub passage_end: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticDiagnostic {
    pub state: String,
    pub reason: String,
    pub query_words: usize,
    pub context_segments: usize,
    pub similarity: Option<f32>,
    pub margin: Option<f32>,
    pub minimum_similarity: f32,
    pub minimum_margin: f32,
    pub latency_ms: f64,
    pub candidates: Vec<SemanticDiagnosticCandidate>,
}

pub struct SemanticSearchOutcome {
    pub matches: Vec<SemanticMatch>,
    pub diagnostic: SemanticDiagnostic,
}

#[derive(Debug, Clone)]
struct IndexEntry {
    book: String,
    chapter: i32,
    verse: i32,
    verse_end: i32,
}

struct SemanticDocument {
    entry: IndexEntry,
    text: String,
}

struct SemanticIndex {
    fingerprint: [u8; 32],
    dimension: usize,
    entries: Vec<IndexEntry>,
    vectors: Vec<i8>,
}

impl SemanticIndex {
    /// Context-blended similarity for every entry, in entry order. Exposed so
    /// retrieval can score a lexically recalled candidate without rescanning
    /// the whole index, and so the probe can report where a known verse landed.
    fn scores(&self, query: &[f32]) -> Vec<f32> {
        if query.len() != self.dimension || self.entries.is_empty() {
            return Vec::new();
        }
        let raw_scores = self
            .vectors
            .chunks_exact(self.dimension)
            .map(|vector| {
                let (dot, vector_magnitude_squared) = query.iter().zip(vector).fold(
                    (0.0_f32, 0.0_f32),
                    |(dot, magnitude), (left, right)| {
                        let right = *right as f32 / 127.0;
                        (dot + left * right, magnitude + right * right)
                    },
                );
                // Quantization slightly changes vector length. Divide it back out
                // so ranking remains normalized cosine rather than raw dot product.
                if vector_magnitude_squared > f32::EPSILON {
                    dot / vector_magnitude_squared.sqrt()
                } else {
                    f32::NEG_INFINITY
                }
            })
            .collect::<Vec<_>>();
        let mut scores = Vec::with_capacity(raw_scores.len());
        for (index, &raw_score) in raw_scores.iter().enumerate() {
            let entry = &self.entries[index];
            let mut score = raw_score;
            let mut context_count = 0.0_f32;
            for neighbor_index in [index.checked_sub(1), index.checked_add(1)]
                .into_iter()
                .flatten()
                .filter(|neighbor| *neighbor < self.entries.len())
            {
                let neighbor = &self.entries[neighbor_index];
                if entry.verse == entry.verse_end
                    && neighbor.verse == neighbor.verse_end
                    && neighbor.book == entry.book
                    && neighbor.chapter == entry.chapter
                    && (neighbor.verse - entry.verse).abs() == 1
                {
                    score += raw_scores[neighbor_index] * PASSAGE_CONTEXT_WEIGHT;
                    context_count += PASSAGE_CONTEXT_WEIGHT;
                }
            }
            scores.push(score - raw_score * context_count);
        }
        scores
    }

    fn ranked_from(scores: &[f32], limit: usize) -> Vec<(usize, f32)> {
        if limit == 0 || scores.is_empty() {
            return Vec::new();
        }
        let mut ranked = scores
            .iter()
            .copied()
            .enumerate()
            .collect::<Vec<(usize, f32)>>();
        if ranked.len() > limit {
            ranked.select_nth_unstable_by(limit, |left, right| right.1.total_cmp(&left.1));
            ranked.truncate(limit);
        }
        ranked.sort_unstable_by(|left, right| right.1.total_cmp(&left.1));
        ranked
    }
}

pub struct SemanticScripture {
    root: PathBuf,
    preparing: AtomicBool,
    cancel_requested: AtomicBool,
    status: Mutex<SemanticStatus>,
    model: Mutex<Option<TextEmbedding>>,
    reranker: Mutex<Option<TextRerank>>,
    indexes: Mutex<IndexCache>,
}

/// Per-translation indexes loaded on demand. Keeping every index resident
/// would cost roughly 40 MB per translation, so at most two stay cached; a
/// long session that switches translations often still evicts the oldest one.
struct IndexCache {
    loaded: Vec<(String, SemanticIndex)>,
}

impl IndexCache {
    /// Ensures the version's index is resident, loading (and validating) it
    /// from disk on first use. Evicts the oldest entry beyond two caches.
    fn load(&mut self, root: &Path, version: &str) -> Result<(), String> {
        if self.loaded.iter().any(|(cached, _)| cached == version) {
            return Ok(());
        }
        let index = load_index(&root.join(index_file(version)))?;
        if index.dimension != EMBEDDING_DIMENSION {
            return Err(format!(
                "The {version} paraphrase index was built with a different model. Run preparation again."
            ));
        }
        self.loaded.push((version.to_string(), index));
        while self.loaded.len() > 2 {
            self.loaded.remove(0);
        }
        Ok(())
    }

    /// Caller must have run `load` for this version first.
    fn get(&self, version: &str) -> &SemanticIndex {
        &self
            .loaded
            .iter()
            .find(|(cached, _)| cached == version)
            .expect("index must be loaded before get")
            .1
    }
}

impl SemanticScripture {
    fn new(app_data_dir: &Path) -> Self {
        let root = app_data_dir.join("ai").join("semantic");
        let has_index = prepared_marker_matches(&root);
        let disk_bytes = directory_size(&root);
        Self {
            root,
            preparing: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            status: Mutex::new(SemanticStatus {
                state: "notPrepared".into(),
                message: if has_index {
                    "Local paraphrase index is prepared and can be loaded.".into()
                } else {
                    "Prepare the local model and Bible index to enable paraphrase suggestions."
                        .into()
                },
                indexed: 0,
                total: 0,
                model: MODEL_ID.into(),
                disk_bytes,
                verified: false,
            }),
            model: Mutex::new(None),
            reranker: Mutex::new(None),
            indexes: Mutex::new(IndexCache { loaded: Vec::new() }),
        }
    }

    pub fn status(&self) -> SemanticStatus {
        let mut status = self.status.lock().clone();
        status.disk_bytes = directory_size(&self.root);
        status
    }

    pub fn is_ready(&self) -> bool {
        self.status.lock().state == "ready"
    }

    pub fn was_prepared(&self) -> bool {
        prepared_marker_matches(&self.root)
    }

    fn update_status(
        &self,
        app: &AppHandle,
        state: &str,
        message: impl Into<String>,
        indexed: usize,
        total: usize,
    ) {
        let status = SemanticStatus {
            state: state.into(),
            message: message.into(),
            indexed,
            total,
            model: MODEL_ID.into(),
            disk_bytes: directory_size(&self.root),
            verified: state == "ready",
        };
        *self.status.lock() = status.clone();
        let _ = app.emit("ai-semantic-status", status);
    }

    fn prepare(&self, app: &AppHandle, bible: &BibleStore) -> Result<(), String> {
        // The per-version index files supersede the aggregate index; leaving
        // the old file behind would only inflate the reported disk usage.
        let _ = fs::remove_file(self.root.join(LEGACY_INDEX_FILE));

        // Collect every supported translation that is actually installed so
        // the progress totals cover the real work, and preparation fails with
        // a clear message when none is present.
        let mut jobs = Vec::new();
        for version in SEMANTIC_INDEX_VERSIONS {
            let Ok(corpus) = bible.semantic_corpus(version) else {
                continue;
            };
            if corpus.is_empty() {
                continue;
            }
            let fingerprint = corpus_fingerprint(&corpus);
            let documents = semantic_documents(&corpus);
            let total = documents.len();
            jobs.push(((*version).to_string(), documents, fingerprint, total));
        }
        if jobs.is_empty() {
            return Err("Install one of the modern Bible translations (NKJV, ASV, WEB, NIV, or AMP) to enable paraphrase suggestions.".into());
        }
        let grand_total: usize = jobs.iter().map(|(_, _, _, total)| total).sum();

        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let file_total = MODEL_FILES.len() + RERANKER_FILES.len();
        self.update_status(
            app,
            "preparing",
            "Loading the local paraphrase models. First preparation may download about 145 MB…",
            0,
            file_total,
        );
        let mut model = load_pinned_model(&self.root, |completed, file| {
            if self.cancel_requested.load(Ordering::Acquire) {
                return Err(PREPARATION_CANCELLED.to_string());
            }
            self.update_status(
                app,
                "preparing",
                format!("Preparing embedding files… {completed}/{file_total} verified ({file})"),
                completed,
                file_total,
            );
            Ok(())
        })?;
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(PREPARATION_CANCELLED.into());
        }

        self.update_status(
            app,
            "preparing",
            "Warming the local paraphrase model…",
            MODEL_FILES.len(),
            file_total,
        );
        let warmup = format!("{QUERY_PREFIX}local Bible passage retrieval");
        model
            .embed(vec![warmup.as_str()], Some(1))
            .map_err(|error| format!("Could not warm the local paraphrase model: {error}"))?;

        let mut reranker = load_pinned_reranker(&self.root, |completed, file| {
            if self.cancel_requested.load(Ordering::Acquire) {
                return Err(PREPARATION_CANCELLED.to_string());
            }
            self.update_status(
                app,
                "preparing",
                format!("Preparing reranker files… {completed}/{file_total} verified ({file})"),
                MODEL_FILES.len() + completed,
                file_total,
            );
            Ok(())
        })?;
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(PREPARATION_CANCELLED.into());
        }
        // Warm the reranker once so the first operator query does not pay the
        // ONNX session initialization cost.
        reranker
            .rerank("warmup", ["warmup passage"], false, Some(1))
            .map_err(|error| format!("Could not warm the local reranker: {error}"))?;

        // Prefer the release bundle of pre-built indexes: it turns hours of
        // CPU embedding on the operator's machine into one download. Versions
        // missing from the bundle (or whose fingerprint differs from the
        // installed Bible text) still build locally below.
        match self.try_prebuilt_bundle(app, &jobs) {
            Ok(installed) if installed > 0 => {
                self.update_status(
                    app,
                    "preparing",
                    format!(
                        "Using {installed}/{job_total} pre-built meaning indexes…",
                        job_total = jobs.len()
                    ),
                    0,
                    grand_total,
                );
            }
            Ok(_) => {}
            Err(message) if message == PREPARATION_CANCELLED => return Err(message),
            Err(message) => {
                self.update_status(
                    app,
                    "preparing",
                    format!("Pre-built indexes unavailable ({message}); building locally…"),
                    0,
                    grand_total,
                );
            }
        }

        let mut indexed_before = 0_usize;
        let job_count = jobs.len();
        for (job_index, (version, documents, fingerprint, total)) in jobs.iter().enumerate() {
            let label = format!("{version} ({}/{job_count})", job_index + 1);
            self.update_status(
                app,
                "preparing",
                format!("Checking the {label} meaning index…"),
                indexed_before,
                grand_total,
            );
            let local_index = self.root.join(index_file(version));
            let _ = match load_index(&local_index) {
                Ok(index)
                    if index.fingerprint == *fingerprint
                        && index.dimension == EMBEDDING_DIMENSION
                        && index.entries.len() == *total =>
                {
                    index
                }
                _ => {
                    let index = build_index(&mut model, documents, *fingerprint, |indexed| {
                        if self.cancel_requested.load(Ordering::Acquire) {
                            return Err(PREPARATION_CANCELLED.to_string());
                        }
                        self.update_status(
                            app,
                            "preparing",
                            format!("Indexing {label} Bible passages… {indexed}/{total}"),
                            indexed_before + indexed,
                            grand_total,
                        );
                        Ok(())
                    })?;
                    save_index(&local_index, &index)?;
                    index
                }
            };
            indexed_before += *total;
        }
        *self.model.lock() = Some(model);
        *self.reranker.lock() = Some(reranker);
        let ready_versions = jobs
            .iter()
            .map(|(version, _, _, _)| version.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let _ = fs::write(self.root.join(READY_MARKER), prepared_marker());
        self.update_status(
            app,
            "ready",
            format!("Local paraphrase matching is ready for {ready_versions}."),
            grand_total,
            grand_total,
        );
        Ok(())
    }

    /// Downloads the pre-built per-version index bundle from the project's
    /// GitHub releases and installs every entry whose fingerprint matches the
    /// local corpus. Returns how many versions were installed; any download,
    /// parse, or verification failure yields the reason so preparation can
    /// build those versions locally instead.
    fn try_prebuilt_bundle(
        &self,
        app: &AppHandle,
        jobs: &[(String, Vec<SemanticDocument>, [u8; 32], usize)],
    ) -> Result<usize, String> {
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(PREPARATION_CANCELLED.into());
        }
        // Skip the download entirely when every version already has a valid
        // local index — the common re-preparation case.
        let needed: Vec<(String, [u8; 32], usize)> = jobs
            .iter()
            .filter(|job| {
                let (version, _, fingerprint, total) = *job;
                match load_index(&self.root.join(index_file(version))) {
                    Ok(index) => {
                        !(index.fingerprint == *fingerprint
                            && index.dimension == EMBEDDING_DIMENSION
                            && index.entries.len() == *total)
                    }
                    Err(_) => true,
                }
            })
            .map(|(version, _, fingerprint, total)| (version.clone(), *fingerprint, *total))
            .collect();
        if needed.is_empty() {
            return Ok(0);
        }
        self.update_status(
            app,
            "preparing",
            "Checking for pre-built meaning indexes…",
            0,
            0,
        );
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let mut response = client
            .get(PREBUILT_BUNDLE_URL)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("release asset returned HTTP {}", response.status()));
        }
        if response.content_length().unwrap_or(0) > PREBUILT_BUNDLE_MAX_BYTES {
            return Err("the pre-built bundle exceeds the size limit".into());
        }

        let temp = self.root.join("prebuilt-bundle.zip.part");
        let mut file = File::create(&temp).map_err(|error| error.to_string())?;
        let mut downloaded = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            if self.cancel_requested.load(Ordering::Acquire) {
                drop(file);
                let _ = fs::remove_file(&temp);
                return Err(PREPARATION_CANCELLED.into());
            }
            // blocking::Response streams through its std::io::Read impl.
            let count = response
                .read(&mut buffer)
                .map_err(|error| format!("The pre-built bundle download failed: {error}"))?;
            if count == 0 {
                break;
            }
            downloaded += count as u64;
            if downloaded > PREBUILT_BUNDLE_MAX_BYTES {
                drop(file);
                let _ = fs::remove_file(&temp);
                return Err("the pre-built bundle exceeds the size limit".into());
            }
            file.write_all(&buffer[..count])
                .map_err(|error| format!("Could not save the pre-built bundle: {error}"))?;
            self.update_status(
                app,
                "preparing",
                format!(
                    "Downloading pre-built meaning indexes… {:.0} MB",
                    downloaded as f64 / (1024.0 * 1024.0)
                ),
                0,
                0,
            );
        }
        drop(file);

        let archive_file = File::open(&temp).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipArchive::new(BufReader::new(archive_file))
            .map_err(|error| format!("The pre-built bundle could not be opened: {error}"))?;
        let mut installed = 0_usize;
        for (version, fingerprint, total) in &needed {
            let Ok(mut entry) = archive.by_name(&index_file(version)) else {
                continue;
            };
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_err() {
                continue;
            }
            let Ok(index) = parse_index(bytes.as_slice()) else {
                continue;
            };
            if index.fingerprint != *fingerprint
                || index.dimension != EMBEDDING_DIMENSION
                || index.entries.len() != *total
            {
                continue;
            }
            // Install atomically the same way save_index does, so a failed
            // copy never leaves a truncated index behind for the cache to load.
            let local_index = self.root.join(index_file(version));
            let part = local_index.with_extension("index.part");
            let install = || -> std::io::Result<()> {
                fs::write(&part, &bytes)?;
                if local_index.exists() {
                    fs::remove_file(&local_index)?;
                }
                fs::rename(&part, &local_index)
            };
            if install().is_ok() {
                installed += 1;
            }
        }
        let _ = fs::remove_file(&temp);
        Ok(installed)
    }

    pub fn search(
        &self,
        query: &str,
        output_version: &str,
        bible: &BibleStore,
    ) -> Result<SemanticSearchOutcome, String> {
        let started = std::time::Instant::now();
        let query_words = query.split_whitespace().count();
        let diagnostic = |state: &str,
                          reason: &str,
                          similarity: Option<f32>,
                          margin: Option<f32>,
                          candidates: Vec<SemanticDiagnosticCandidate>| {
            SemanticDiagnostic {
                state: state.into(),
                reason: reason.into(),
                query_words,
                context_segments: 0,
                similarity,
                margin,
                minimum_similarity: MIN_RERANK_SIMILARITY,
                minimum_margin: MIN_MARGIN,
                latency_ms: started.elapsed().as_secs_f64() * 1_000.0,
                candidates,
            }
        };
        if query_words < MIN_QUERY_WORDS {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "skipped",
                    "Waiting for at least five words in the current thought.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        }
        if has_repeated_phrase(query) {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "skipped",
                    "Waiting for a stable thought after repeated speech.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        }
        if !self.is_ready() {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "skipped",
                    "Local paraphrase matching is not ready.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        }
        let query_input = format!("{QUERY_PREFIX}{query}");
        let mut embeddings = self
            .model
            .lock()
            .as_mut()
            .ok_or_else(|| "Local paraphrase model is not loaded.".to_string())?
            .embed(vec![query_input.as_str()], Some(1))
            .map_err(|error| format!("Could not embed sermon context: {error}"))?;
        let mut query_vector = embeddings
            .pop()
            .ok_or_else(|| "The local paraphrase model returned no query vector.".to_string())?;
        normalize(&mut query_vector);

        // Paraphrase ranking runs against the output version's own text so
        // the spoken paraphrase and the indexed document share a register.
        // KJV reuses the NKJV index (closest register, matching verse
        // numbering); every verse is still rendered from the operator's
        // chosen translation below. Other translations simply skip semantic
        // matching — references and quotations keep working.
        let Some(index_version) = resolve_index_version(output_version) else {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "skipped",
                    "Paraphrase matching covers NKJV, ASV, WEB, NIV, and AMP; explicit references and quotations still work.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        };
        let mut indexes = self.indexes.lock();
        if indexes.load(&self.root, index_version).is_err() {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "skipped",
                    "The local paraphrase index for this translation could not be loaded. Run preparation again.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        }
        let index = indexes.get(index_version);
        let scores = index.scores(&query_vector);
        let ranked = SemanticIndex::ranked_from(&scores, RERANK_POOL_SIZE);

        // Candidate text comes from the *indexed* translation so the
        // cross-encoder reads the same register the vectors were built from.
        let mut candidates: Vec<RerankCandidate> = Vec::new();
        for &(position, score) in &ranked {
            let entry = &index.entries[position];
            let Some(text) = passage_text(
                bible,
                &entry.book,
                entry.chapter,
                entry.verse,
                entry.verse_end,
                index_version,
            ) else {
                continue;
            };
            candidates.push(RerankCandidate {
                book: entry.book.clone(),
                chapter: entry.chapter,
                verse: entry.verse,
                verse_end: entry.verse_end,
                text,
                dense: Some(score),
            });
        }

        // Lexical candidates: spoken paraphrases often share a rare word
        // ("lamp", "doers", "truth") with a verse dense retrieval never
        // surfaces. Add the FTS winners to the pool and let the reranker judge.
        if let Ok(lexical) = bible.search_quote_candidates(query) {
            for verse in lexical {
                if candidates.len() >= RERANK_POOL_SIZE + LEXICAL_CANDIDATE_LIMIT {
                    break;
                }
                if candidates.iter().any(|candidate| {
                    candidate.book == verse.book
                        && candidate.chapter == verse.chapter
                        && verse.verse >= candidate.verse
                        && verse.verse <= candidate.verse_end
                }) {
                    continue;
                }
                let Some(text) = passage_text(
                    bible,
                    &verse.book,
                    verse.chapter,
                    verse.verse,
                    verse.verse,
                    index_version,
                ) else {
                    continue;
                };
                candidates.push(RerankCandidate {
                    book: verse.book,
                    chapter: verse.chapter,
                    verse: verse.verse,
                    verse_end: verse.verse,
                    text,
                    dense: None,
                });
            }
        }
        if candidates.is_empty() {
            return Ok(SemanticSearchOutcome {
                matches: Vec::new(),
                diagnostic: diagnostic(
                    "rejected",
                    "The local index returned no candidates.",
                    None,
                    None,
                    Vec::new(),
                ),
            });
        }

        let (logits, order) = {
            let mut guard = self.reranker.lock();
            let Some(reranker) = guard.as_mut() else {
                return Ok(SemanticSearchOutcome {
                    matches: Vec::new(),
                    diagnostic: diagnostic(
                        "skipped",
                        "Local paraphrase matching is not ready.",
                        None,
                        None,
                        Vec::new(),
                    ),
                });
            };
            let documents = candidates
                .iter()
                .map(|candidate| candidate.text.as_str())
                .collect::<Vec<_>>();
            let reranked = reranker
                .rerank(query, &documents, false, Some(16))
                .map_err(|error| format!("Could not re-rank sermon context: {error}"))?;
            let mut logits = vec![f32::NEG_INFINITY; candidates.len()];
            for result in &reranked {
                logits[result.index] = result.score;
            }
            let order = blended_order(&candidates, &logits);
            (logits, order)
        };

        let similarity = sigmoid(logits[order[0]]);
        let winner = &candidates[order[0]];
        let distinct_runner = order
            .iter()
            .skip(1)
            .find(|&&position| !same_candidate_neighborhood(winner, &candidates[position]));
        let margin = distinct_runner
            .map(|&position| similarity - sigmoid(logits[position]))
            .unwrap_or(similarity);

        let mut diagnostic_candidates = Vec::new();
        let mut matches = Vec::new();
        let mut consumed = std::collections::HashSet::new();
        for &position in &order {
            let candidate_similarity = sigmoid(logits[position]);
            if matches.len() >= MAX_SEMANTIC_SUGGESTIONS
                || similarity - candidate_similarity > MAX_ALTERNATIVE_DELTA
                || candidate_similarity < MIN_RERANK_SIMILARITY
            {
                break;
            }
            if consumed.contains(&position) {
                continue;
            }
            let entry = &candidates[position];
            let mut passage_start = entry.verse;
            let mut passage_end = entry.verse_end;
            for &neighbor_position in &order {
                let neighbor = &candidates[neighbor_position];
                if same_candidate_neighborhood(entry, neighbor)
                    && candidate_similarity - sigmoid(logits[neighbor_position])
                        <= MAX_PASSAGE_NEIGHBOR_DELTA
                {
                    consumed.insert(neighbor_position);
                    passage_start = passage_start.min(neighbor.verse);
                    passage_end = passage_end.max(neighbor.verse_end);
                }
            }
            let reference = if passage_start == passage_end {
                format!("{} {}:{}", entry.book, entry.chapter, entry.verse)
            } else {
                format!(
                    "{} {}:{}-{}",
                    entry.book, entry.chapter, passage_start, passage_end
                )
            };
            diagnostic_candidates.push(SemanticDiagnosticCandidate {
                reference,
                similarity: candidate_similarity,
                passage_start,
                passage_end,
            });
            let Some(verse) = bible
                .get_verse(&entry.book, entry.chapter, entry.verse, output_version)
                .map_err(|error| error.to_string())?
            else {
                continue;
            };

            let rank = matches.len() + 1;
            let confidence =
                semantic_confidence(candidate_similarity, margin, rank, MIN_RERANK_SIMILARITY);
            matches.push(SemanticMatch {
                verse,
                confidence,
                similarity: candidate_similarity,
                margin,
                rank,
                passage_start,
                passage_end,
            });
        }

        let accepted =
            accepts_semantic_candidates(similarity, margin, matches.len(), MIN_RERANK_SIMILARITY);
        let (state, reason) = if similarity < MIN_RERANK_SIMILARITY {
            matches.clear();
            (
                "rejected",
                "Best candidate was below the minimum rerank threshold.",
            )
        } else if !accepted {
            matches.clear();
            (
                "rejected",
                "Top passages were too close and no qualified alternative could be shown.",
            )
        } else if margin < MIN_MARGIN {
            (
                "ambiguous",
                "Top passages are close; returned manual-only alternatives for operator review.",
            )
        } else {
            ("matched", "Returned manual-only possible-theme candidates.")
        };

        Ok(SemanticSearchOutcome {
            matches,
            diagnostic: diagnostic(
                state,
                reason,
                Some(similarity),
                Some(margin),
                diagnostic_candidates,
            ),
        })
    }

    pub fn cancel_preparation(&self, app: &AppHandle) -> SemanticStatus {
        if self.preparing.load(Ordering::Acquire) {
            self.cancel_requested.store(true, Ordering::Release);
            self.update_status(
                app,
                "preparing",
                "Cancelling after the current model file finishes…",
                0,
                MODEL_FILES.len() + RERANKER_FILES.len(),
            );
        }
        self.status()
    }

    pub fn remove_local_model(&self, app: &AppHandle) -> Result<SemanticStatus, String> {
        if self.preparing.load(Ordering::Acquire) {
            return Err("Cancel paraphrase preparation before removing local files.".into());
        }
        *self.model.lock() = None;
        *self.reranker.lock() = None;
        self.indexes.lock().loaded.clear();
        if self.root.exists() {
            if let Err(error) = fs::remove_dir_all(&self.root) {
                let message = format!("Could not remove the local AI model: {error}");
                self.update_status(app, "error", &message, 0, 0);
                return Err(message);
            }
        }
        self.update_status(
            app,
            "notPrepared",
            "Local paraphrase model removed. Normal Scripture features are unaffected.",
            0,
            0,
        );
        Ok(self.status())
    }
}

#[cfg(test)]
fn same_passage_neighborhood(left: &IndexEntry, right: &IndexEntry) -> bool {
    left.book == right.book
        && left.chapter == right.chapter
        && left.verse <= right.verse_end + 1
        && right.verse <= left.verse_end + 1
}

/// One unit of text offered to the cross-encoder: either an indexed passage
/// (verse or 4-verse window) or a single verse recovered by lexical search.
struct RerankCandidate {
    book: String,
    chapter: i32,
    verse: i32,
    verse_end: i32,
    text: String,
    dense: Option<f32>,
}

fn same_candidate_neighborhood(left: &RerankCandidate, right: &RerankCandidate) -> bool {
    left.book == right.book
        && left.chapter == right.chapter
        && left.verse <= right.verse_end + 1
        && right.verse <= left.verse_end + 1
}

/// Rebuilds an indexed document from the store. Missing verses are skipped so
/// a partially installed chapter never produces an empty candidate.
fn passage_text(
    bible: &BibleStore,
    book: &str,
    chapter: i32,
    start: i32,
    end: i32,
    version: &str,
) -> Option<String> {
    let mut parts = Vec::new();
    for verse in start..=end {
        if let Ok(Some(found)) = bible.get_verse(book, chapter, verse, version) {
            parts.push(found.text);
        }
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Maps a cross-encoder logit into (0, 1). The reranker emits unbounded
/// logits; this keeps the public `similarity` field a probability so the UI
/// and confidence formula keep their previous range.
fn sigmoid(logit: f32) -> f32 {
    1.0 / (1.0 + (-logit).exp())
}

fn min_max_normalized(values: &[f32]) -> Vec<f32> {
    let min = values.iter().copied().fold(f32::INFINITY, f32::min);
    let max = values.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let span = (max - min).max(f32::EPSILON);
    values.iter().map(|value| (value - min) / span).collect()
}

/// Orders candidates by a blend of normalized dense similarity and normalized
/// cross-encoder logit. Lexical-only candidates take the worst dense score, so
/// they still win when the reranker is confident.
fn blended_order(candidates: &[RerankCandidate], logits: &[f32]) -> Vec<usize> {
    let worst_dense = candidates
        .iter()
        .filter_map(|candidate| candidate.dense)
        .fold(f32::INFINITY, f32::min);
    let dense = candidates
        .iter()
        .map(|candidate| candidate.dense.unwrap_or(worst_dense))
        .collect::<Vec<_>>();
    let dense = min_max_normalized(&dense);
    let rerank = min_max_normalized(logits);
    let mut order = (0..candidates.len()).collect::<Vec<_>>();
    order.sort_unstable_by(|left, right| {
        let score = |index: usize| {
            BLEND_DENSE_WEIGHT * dense[index] + (1.0 - BLEND_DENSE_WEIGHT) * rerank[index]
        };
        score(*right).total_cmp(&score(*left))
    });
    order
}

/// Production confidence for a semantic match. Kept as one function so the
/// guarantee that paraphrase confidence stays below the auto-stage threshold
/// is enforced by an assertion on *this* formula, not on a re-typed copy.
fn semantic_confidence(similarity: f32, margin: f32, rank: usize, minimum: f32) -> f32 {
    (0.55 + (similarity - minimum) * 0.65 + margin * 0.35 - (rank.saturating_sub(1) as f32 * 0.04))
        .clamp(0.55, MAX_PARAPHRASE_CONFIDENCE)
}

fn accepts_semantic_candidates(
    similarity: f32,
    margin: f32,
    candidate_count: usize,
    minimum: f32,
) -> bool {
    similarity >= minimum && (margin >= MIN_MARGIN || candidate_count >= 2)
}

static ENGINE: OnceLock<Arc<SemanticScripture>> = OnceLock::new();

pub fn engine(app_data_dir: &Path) -> Arc<SemanticScripture> {
    ENGINE
        .get_or_init(|| Arc::new(SemanticScripture::new(app_data_dir)))
        .clone()
}

pub fn prepare_in_background(
    app: AppHandle,
    bible: Arc<BibleStore>,
    app_data_dir: PathBuf,
) -> SemanticStatus {
    let engine = engine(&app_data_dir);
    if engine.is_ready() || engine.preparing.swap(true, Ordering::AcqRel) {
        return engine.status();
    }
    engine.cancel_requested.store(false, Ordering::Release);
    engine.update_status(
        &app,
        "preparing",
        "Starting local paraphrase preparation…",
        0,
        0,
    );
    let worker_engine = engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match catch_unwind(AssertUnwindSafe(|| worker_engine.prepare(&app, &bible))) {
            Ok(Ok(())) => {}
            Ok(Err(error)) if error == PREPARATION_CANCELLED => worker_engine.update_status(
                &app,
                "notPrepared",
                "Preparation cancelled. Verified downloads remain cached for a faster retry.",
                0,
                0,
            ),
            Ok(Err(error)) => worker_engine.update_status(&app, "error", error, 0, 0),
            Err(_) => worker_engine.update_status(
                &app,
                "error",
                "Local paraphrase preparation stopped unexpectedly. Retry preparation.",
                0,
                0,
            ),
        }
        worker_engine.preparing.store(false, Ordering::Release);
    });
    engine.status()
}

fn normalize(vector: &mut [f32]) {
    let magnitude = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if magnitude > f32::EPSILON {
        for value in vector {
            *value /= magnitude;
        }
    }
}

/// Keeps precise verse retrieval while also representing sermon-sized thoughts.
/// Four-verse windows overlap by two verses and never cross a chapter boundary.
fn semantic_documents(corpus: &[SemanticCorpusVerse]) -> Vec<SemanticDocument> {
    let mut documents = corpus
        .iter()
        .map(|verse| SemanticDocument {
            entry: IndexEntry {
                book: verse.book.clone(),
                chapter: verse.chapter,
                verse: verse.verse,
                verse_end: verse.verse,
            },
            text: verse.text.clone(),
        })
        .collect::<Vec<_>>();

    let mut chapter_start = 0;
    while chapter_start < corpus.len() {
        let first = &corpus[chapter_start];
        let mut chapter_end = chapter_start + 1;
        while chapter_end < corpus.len()
            && corpus[chapter_end].book == first.book
            && corpus[chapter_end].chapter == first.chapter
        {
            chapter_end += 1;
        }
        let chapter = &corpus[chapter_start..chapter_end];
        for start in (0..chapter.len()).step_by(2) {
            let end = (start + 4).min(chapter.len());
            let window = &chapter[start..end];
            if window.len() < 2
                || !window
                    .iter()
                    .enumerate()
                    .all(|(offset, verse)| verse.verse == window[0].verse + offset as i32)
            {
                continue;
            }
            documents.push(SemanticDocument {
                entry: IndexEntry {
                    book: first.book.clone(),
                    chapter: first.chapter,
                    verse: window[0].verse,
                    verse_end: window
                        .last()
                        .map(|verse| verse.verse)
                        .unwrap_or(window[0].verse),
                },
                text: window
                    .iter()
                    .map(|verse| verse.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
        chapter_start = chapter_end;
    }
    documents
}

fn build_index(
    model: &mut TextEmbedding,
    documents: &[SemanticDocument],
    fingerprint: [u8; 32],
    mut progress: impl FnMut(usize) -> Result<(), String>,
) -> Result<SemanticIndex, String> {
    const BATCH_SIZE: usize = 32;
    let mut entries = Vec::with_capacity(documents.len());
    let mut vectors = Vec::with_capacity(documents.len() * EMBEDDING_DIMENSION);
    for batch in documents.chunks(BATCH_SIZE) {
        let inputs = batch
            .iter()
            .map(|document| document.text.as_str())
            .collect::<Vec<_>>();
        let mut embeddings = model
            .embed(inputs, Some(BATCH_SIZE))
            .map_err(|error| format!("Could not index canonical Bible passages: {error}"))?;
        if embeddings.len() != batch.len() {
            return Err(
                "The local embedding model returned an incomplete Bible index batch.".into(),
            );
        }
        for (document, mut embedding) in batch.iter().zip(embeddings.drain(..)) {
            if embedding.len() != EMBEDDING_DIMENSION {
                return Err(
                    "The local embedding model returned an unsupported vector dimension.".into(),
                );
            }
            normalize(&mut embedding);
            entries.push(document.entry.clone());
            vectors.extend(
                embedding
                    .into_iter()
                    .map(|value| (value * 127.0).round().clamp(-127.0, 127.0) as i8),
            );
        }
        progress(entries.len())?;
    }
    Ok(SemanticIndex {
        fingerprint,
        dimension: EMBEDDING_DIMENSION,
        entries,
        vectors,
    })
}

/// File name of the paraphrase index for one translation. Version labels are
/// short alphanumerics ("NKJV", "WEB"), but sanitize anyway so any future
/// version label cannot escape the index directory.
fn index_file(version: &str) -> String {
    let sanitized: String = version
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    format!("{INDEX_FILE_BASE}-{sanitized}.index")
}

/// Resolves the semantic index used to rank paraphrases for an output
/// version. Only modern-English translations are indexed; KJV reuses the NKJV
/// index because its register is closest and its verse numbering aligns with
/// the canonical corpus, while unmatched versions skip semantic matching.
fn resolve_index_version(output_version: &str) -> Option<&'static str> {
    SEMANTIC_INDEX_VERSIONS
        .iter()
        .copied()
        .find(|version| version.eq_ignore_ascii_case(output_version))
        .or_else(|| output_version.eq_ignore_ascii_case("KJV").then_some("NKJV"))
}

fn prepared_marker() -> String {
    format!("{MODEL_REVISION}\n{RERANKER_REVISION}")
}

fn prepared_marker_matches(root: &Path) -> bool {
    fs::read_to_string(root.join(READY_MARKER))
        .is_ok_and(|revision| revision.trim() == prepared_marker())
}

fn load_pinned_model(
    root: &Path,
    mut progress: impl FnMut(usize, &str) -> Result<(), String>,
) -> Result<TextEmbedding, String> {
    let api = hf_hub::api::sync::ApiBuilder::new()
        .with_cache_dir(root.join("model"))
        .with_progress(false)
        .with_retries(3)
        .build()
        .map_err(|error| format!("Could not initialize the model downloader: {error}"))?;
    let repository = api.repo(Repo::with_revision(
        MODEL_REPOSITORY.into(),
        RepoType::Model,
        MODEL_REVISION.into(),
    ));
    let mut files = std::collections::HashMap::new();
    for (index, (name, expected_hash)) in MODEL_FILES.iter().enumerate() {
        progress(index, name)?;
        let path = repository
            .get(name)
            .map_err(|error| format!("Could not download {name}: {error}"))?;
        let bytes = fs::read(&path).map_err(|error| format!("Could not read {name}: {error}"))?;
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        if actual_hash != *expected_hash {
            let _ = fs::remove_file(path);
            return Err(format!(
                "Local model integrity check failed for {name}; the cached file was removed. Retry preparation."
            ));
        }
        files.insert(*name, bytes);
        progress(index + 1, name)?;
    }

    create_model(files)
}

fn load_pinned_reranker(
    root: &Path,
    mut progress: impl FnMut(usize, &str) -> Result<(), String>,
) -> Result<TextRerank, String> {
    let api = hf_hub::api::sync::ApiBuilder::new()
        .with_cache_dir(root.join(RERANKER_DIRECTORY))
        .with_progress(false)
        .with_retries(3)
        .build()
        .map_err(|error| format!("Could not initialize the reranker downloader: {error}"))?;
    let repository = api.repo(Repo::with_revision(
        RERANKER_REPOSITORY.into(),
        RepoType::Model,
        RERANKER_REVISION.into(),
    ));
    let mut files = std::collections::HashMap::new();
    for (index, (name, expected_hash)) in RERANKER_FILES.iter().enumerate() {
        progress(index, name)?;
        let path = repository
            .get(name)
            .map_err(|error| format!("Could not download {name}: {error}"))?;
        let bytes = fs::read(&path).map_err(|error| format!("Could not read {name}: {error}"))?;
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        if actual_hash != *expected_hash {
            let _ = fs::remove_file(path);
            return Err(format!(
                "Local reranker integrity check failed for {name}; the cached file was removed. Retry preparation."
            ));
        }
        files.insert(*name, bytes);
        progress(index + 1, name)?;
    }

    create_reranker(files)
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            entry
                .metadata()
                .map(|metadata| {
                    if metadata.is_dir() {
                        directory_size(&entry.path())
                    } else {
                        metadata.len()
                    }
                })
                .unwrap_or(0)
        })
        .sum()
}

fn create_model(
    mut files: std::collections::HashMap<&str, Vec<u8>>,
) -> Result<TextEmbedding, String> {
    let inference_threads = std::thread::available_parallelism()
        .map(|count| count.get().min(4))
        .unwrap_or(2);
    let take = |files: &mut std::collections::HashMap<&str, Vec<u8>>, name: &str| {
        files
            .remove(name)
            .ok_or_else(|| format!("Pinned model is missing {name}."))
    };
    let model = UserDefinedEmbeddingModel::new(
        take(&mut files, "onnx/model_quantized.onnx")?,
        TokenizerFiles {
            tokenizer_file: take(&mut files, "tokenizer.json")?,
            config_file: take(&mut files, "config.json")?,
            special_tokens_map_file: take(&mut files, "special_tokens_map.json")?,
            tokenizer_config_file: take(&mut files, "tokenizer_config.json")?,
        },
    )
    .with_pooling(Pooling::Cls)
    .with_quantization(QuantizationMode::Dynamic);
    TextEmbedding::try_new_from_user_defined(
        model,
        InitOptionsUserDefined::new()
            .with_intra_threads(inference_threads)
            .with_max_length(256),
    )
    .map_err(|error| format!("Could not load the local paraphrase model: {error}"))
}

fn create_reranker(
    mut files: std::collections::HashMap<&str, Vec<u8>>,
) -> Result<TextRerank, String> {
    let inference_threads = std::thread::available_parallelism()
        .map(|count| count.get().min(4))
        .unwrap_or(2);
    let take = |files: &mut std::collections::HashMap<&str, Vec<u8>>, name: &str| {
        files
            .remove(name)
            .ok_or_else(|| format!("Pinned reranker is missing {name}."))
    };
    let model = UserDefinedRerankingModel::new(
        take(&mut files, "onnx/model_quantized.onnx")?,
        TokenizerFiles {
            tokenizer_file: take(&mut files, "tokenizer.json")?,
            config_file: take(&mut files, "config.json")?,
            special_tokens_map_file: take(&mut files, "special_tokens_map.json")?,
            tokenizer_config_file: take(&mut files, "tokenizer_config.json")?,
        },
    );
    TextRerank::try_new_from_user_defined(
        model,
        RerankInitOptionsUserDefined::new()
            .with_intra_threads(inference_threads)
            .with_max_length(RERANK_MAX_LENGTH),
    )
    .map_err(|error| format!("Could not load the local reranker: {error}"))
}

fn corpus_fingerprint(corpus: &[SemanticCorpusVerse]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    // Changing the model revision must invalidate vectors even when the Bible
    // text itself has not changed.
    hasher.update(MODEL_REVISION.as_bytes());
    hasher.update([0xfe]);
    for item in corpus {
        hasher.update(item.book.as_bytes());
        hasher.update([0]);
        hasher.update(item.chapter.to_le_bytes());
        hasher.update(item.verse.to_le_bytes());
        hasher.update(item.text.as_bytes());
        hasher.update([0xff]);
    }
    hasher.finalize().into()
}

fn save_index(path: &Path, index: &SemanticIndex) -> Result<(), String> {
    let temp = path.with_extension("index.part");
    let file = File::create(&temp).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(INDEX_MAGIC)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&index.fingerprint)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&(index.dimension as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&(index.entries.len() as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    for (entry, vector) in index
        .entries
        .iter()
        .zip(index.vectors.chunks_exact(index.dimension))
    {
        let book = entry.book.as_bytes();
        let book_len = u16::try_from(book.len()).map_err(|_| "Bible book name is too long.")?;
        writer
            .write_all(&book_len.to_le_bytes())
            .and_then(|_| writer.write_all(book))
            .and_then(|_| writer.write_all(&entry.chapter.to_le_bytes()))
            .and_then(|_| writer.write_all(&entry.verse.to_le_bytes()))
            .and_then(|_| writer.write_all(&entry.verse_end.to_le_bytes()))
            .map_err(|error| error.to_string())?;
        for value in vector {
            writer
                .write_all(&value.to_le_bytes())
                .map_err(|error| error.to_string())?;
        }
    }
    writer.flush().map_err(|error| error.to_string())?;
    drop(writer);
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn load_index(path: &Path) -> Result<SemanticIndex, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    parse_index(file)
}

/// Parses an index from any reader — the on-disk file or a pre-built bundle
/// entry — so both sources share the same validation rules.
fn parse_index(reader: impl Read) -> Result<SemanticIndex, String> {
    let mut reader = BufReader::new(reader);
    let mut magic = [0u8; 8];
    reader
        .read_exact(&mut magic)
        .map_err(|error| error.to_string())?;
    if &magic != INDEX_MAGIC {
        return Err("Unsupported semantic index format.".into());
    }
    let mut fingerprint = [0u8; 32];
    reader
        .read_exact(&mut fingerprint)
        .map_err(|error| error.to_string())?;
    let dimension = read_u32(&mut reader)? as usize;
    let count = read_u32(&mut reader)? as usize;
    if dimension != EMBEDDING_DIMENSION || count == 0 || count > 80_000 {
        return Err("Semantic index header is invalid.".into());
    }
    let mut entries = Vec::with_capacity(count);
    let mut vectors = Vec::with_capacity(count * dimension);
    for _ in 0..count {
        let mut length = [0u8; 2];
        reader
            .read_exact(&mut length)
            .map_err(|error| error.to_string())?;
        let length = u16::from_le_bytes(length) as usize;
        if length == 0 || length > 128 {
            return Err("Semantic index contains an invalid book name.".into());
        }
        let mut book = vec![0u8; length];
        reader
            .read_exact(&mut book)
            .map_err(|error| error.to_string())?;
        let book = String::from_utf8(book).map_err(|error| error.to_string())?;
        let chapter = read_i32(&mut reader)?;
        let verse = read_i32(&mut reader)?;
        let verse_end = read_i32(&mut reader)?;
        if verse <= 0 || verse_end < verse {
            return Err("Semantic index contains an invalid passage range.".into());
        }
        entries.push(IndexEntry {
            book,
            chapter,
            verse,
            verse_end,
        });
        for _ in 0..dimension {
            let mut bytes = [0u8; 1];
            reader
                .read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
            vectors.push(i8::from_le_bytes(bytes));
        }
    }
    Ok(SemanticIndex {
        fingerprint,
        dimension,
        entries,
        vectors,
    })
}

fn read_u32(reader: &mut impl Read) -> Result<u32, String> {
    let mut bytes = [0u8; 4];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_i32(reader: &mut impl Read) -> Result<i32, String> {
    let mut bytes = [0u8; 4];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(i32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Translation used to calibrate the paraphrase recall floors. The
    /// fixture index is built from an installed WEB database by
    /// `builds_probe_index_fixture` and lives in gitignored
    /// `src-tauri/bible_data/`.
    const PROBE_INDEX_VERSION: &str = "WEB";

    #[test]
    fn repeated_self_corrections_are_not_semantic_queries() {
        assert!(has_repeated_phrase(
            "Daddy, look at that. I put my hand, I put my hand in my teeth."
        ));
        assert!(!has_repeated_phrase(
            "Do not merely hear the word; put what it says into practice."
        ));
    }

    #[test]
    fn exact_search_ranks_normalized_vectors() {
        let index = SemanticIndex {
            fingerprint: [7; 32],
            dimension: 3,
            entries: vec![
                IndexEntry {
                    book: "John".into(),
                    chapter: 3,
                    verse: 16,
                    verse_end: 16,
                },
                IndexEntry {
                    book: "Psalms".into(),
                    chapter: 23,
                    verse: 1,
                    verse_end: 1,
                },
                IndexEntry {
                    book: "Isaiah".into(),
                    chapter: 40,
                    verse: 31,
                    verse_end: 31,
                },
            ],
            vectors: vec![127, 0, 0, 0, 127, 0, 102, 25, 0],
        };
        let ranked = SemanticIndex::ranked_from(&index.scores(&[1.0, 0.0, 0.0]), 2);
        assert_eq!(ranked[0].0, 0);
        assert_eq!(ranked[1].0, 2);
    }

    #[test]
    fn index_round_trip_preserves_metadata_and_vectors() {
        let root = std::env::temp_dir().join(format!("wordlyte-semantic-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("test.index");
        let index = SemanticIndex {
            fingerprint: [9; 32],
            dimension: EMBEDDING_DIMENSION,
            entries: vec![IndexEntry {
                book: "Romans".into(),
                chapter: 8,
                verse: 28,
                verse_end: 30,
            }],
            vectors: (0..EMBEDDING_DIMENSION)
                .map(|index| (index % 127) as i8)
                .collect(),
        };
        save_index(&path, &index).unwrap();
        let loaded = load_index(&path).unwrap();
        assert_eq!(loaded.fingerprint, [9; 32]);
        assert_eq!(loaded.entries[0].book, "Romans");
        assert_eq!(loaded.entries[0].chapter, 8);
        assert_eq!(loaded.entries[0].verse_end, 30);
        assert_eq!(loaded.vectors, index.vectors);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn paraphrase_confidence_cannot_reach_auto_stage_threshold() {
        // The ceiling must hold even for a perfect, unanimous rank-1 match.
        assert_eq!(
            semantic_confidence(1.0, 1.0, 1, MIN_RERANK_SIMILARITY),
            MAX_PARAPHRASE_CONFIDENCE,
            "semantic_confidence must stay capped below the auto-stage threshold"
        );
        // The floor holds at the minimum qualifying similarity with no margin.
        assert_eq!(
            semantic_confidence(MIN_RERANK_SIMILARITY, 0.0, 1, MIN_RERANK_SIMILARITY),
            0.55
        );
    }

    #[test]
    fn semantic_confidence_penalizes_lower_ranks() {
        let winner = semantic_confidence(0.80, 0.05, 1, MIN_RERANK_SIMILARITY);
        assert!(semantic_confidence(0.80, 0.05, 2, MIN_RERANK_SIMILARITY) < winner);
        assert!(
            semantic_confidence(0.80, 0.05, 3, MIN_RERANK_SIMILARITY)
                < semantic_confidence(0.80, 0.05, 2, MIN_RERANK_SIMILARITY)
        );
    }

    #[test]
    fn close_semantic_candidates_require_manual_alternatives() {
        assert!(!accepts_semantic_candidates(
            0.75,
            0.01,
            1,
            MIN_RERANK_SIMILARITY
        ));
        assert!(accepts_semantic_candidates(
            0.75,
            0.01,
            2,
            MIN_RERANK_SIMILARITY
        ));
        assert!(accepts_semantic_candidates(
            MIN_RERANK_SIMILARITY,
            0.01,
            3,
            MIN_RERANK_SIMILARITY
        ));
        assert!(!accepts_semantic_candidates(
            MIN_RERANK_SIMILARITY - 0.01,
            0.10,
            3,
            MIN_RERANK_SIMILARITY
        ));
    }

    #[test]
    fn sigmoid_maps_logits_to_probabilities() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-6);
        assert!(sigmoid(-5.381) < MIN_RERANK_SIMILARITY);
        assert!(sigmoid(-0.704) > MIN_RERANK_SIMILARITY);
        assert!((sigmoid(6.419) - 1.0).abs() < 1e-2);
    }

    #[test]
    fn blended_order_prefers_reranker_evidence_for_lexical_candidates() {
        let candidates = vec![
            RerankCandidate {
                book: "John".into(),
                chapter: 3,
                verse: 16,
                verse_end: 16,
                text: "a".into(),
                dense: Some(0.70),
            },
            RerankCandidate {
                book: "John".into(),
                chapter: 8,
                verse: 32,
                verse_end: 32,
                text: "b".into(),
                dense: None,
            },
        ];
        // Dense leads, but a confident reranker promotes the lexical-only verse.
        assert_eq!(blended_order(&candidates, &[0.0, 8.0]), vec![1, 0]);
        // Without reranker evidence the dense candidate stays first.
        assert_eq!(blended_order(&candidates, &[0.0, -8.0]), vec![0, 1]);
    }

    #[test]
    fn semantic_documents_include_overlapping_passages() {
        let corpus = (1..=5)
            .map(|verse| SemanticCorpusVerse {
                book: "Romans".into(),
                chapter: 8,
                verse,
                text: format!("Verse {verse}"),
            })
            .collect::<Vec<_>>();
        let documents = semantic_documents(&corpus);
        assert_eq!(documents.len(), 7); // five verses plus 1-4 and 3-5.
        assert!(documents
            .iter()
            .any(|document| { document.entry.verse == 1 && document.entry.verse_end == 4 }));
        assert!(documents
            .iter()
            .any(|document| { document.entry.verse == 3 && document.entry.verse_end == 5 }));
    }

    #[test]
    fn prepared_marker_must_match_model_revision() {
        let root = std::env::temp_dir().join(format!("wordlyte-marker-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(READY_MARKER), "old-model-revision").unwrap();
        assert!(!prepared_marker_matches(&root));
        fs::write(root.join(READY_MARKER), format!("{MODEL_REVISION}\n")).unwrap();
        assert!(!prepared_marker_matches(&root));
        fs::write(root.join(READY_MARKER), prepared_marker()).unwrap();
        assert!(prepared_marker_matches(&root));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "downloads the pinned local embedding model"]
    fn pinned_model_loads_and_embeds_offline_query() {
        let root = std::env::temp_dir().join(format!("wordlyte-model-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut model = load_pinned_model(&root, |_, _| Ok(())).unwrap();
        let embeddings = model
            .embed(vec!["God gives strength to the weak"], Some(1))
            .unwrap();
        assert_eq!(embeddings.len(), 1);
        assert_eq!(embeddings[0].len(), EMBEDDING_DIMENSION);
        let _ = fs::remove_dir_all(root);
    }

    /// Rebuilds the probe fixture index for `PROBE_INDEX_VERSION` from an
    /// installed Bible database. Point `WORDLYTE_TEST_BIBLE_DB` at the
    /// operator database (the default below is the usual Windows install) and
    /// `WORDLYTE_TEST_BGE_MODEL` at the flat pinned model files, then run:
    /// `cargo test --lib builds_probe_index_fixture -- --ignored --nocapture`
    #[test]
    #[ignore = "builds a local probe index fixture from an installed Bible database"]
    fn builds_probe_index_fixture() {
        let default_db = std::env::var_os("LOCALAPPDATA")
            .map(|local| {
                PathBuf::from(local)
                    .join("io.wordlyte.app")
                    .join("bible_data")
                    .join("wordlyte_bible.db")
            })
            .expect("LOCALAPPDATA is not set");
        let db_path = std::env::var_os("WORDLYTE_TEST_BIBLE_DB")
            .map(PathBuf::from)
            .unwrap_or(default_db);
        assert!(
            db_path.is_file(),
            "missing Bible database fixture at {}",
            db_path.display()
        );
        let bible = BibleStore::open_for_tests(&db_path)
            .expect("could not open the Bible database fixture");
        let corpus = bible
            .semantic_corpus(PROBE_INDEX_VERSION)
            .expect("could not read the semantic corpus");
        assert!(
            !corpus.is_empty(),
            "the {PROBE_INDEX_VERSION} corpus is not installed"
        );
        let model_dir = std::env::var_os("WORDLYTE_TEST_BGE_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("opencode").join("bge-base-pin"));
        let mut files = std::collections::HashMap::new();
        for (name, _) in MODEL_FILES {
            let local_name = if *name == "onnx/model_quantized.onnx" {
                "model_quantized.onnx"
            } else {
                name
            };
            files.insert(*name, fs::read(model_dir.join(local_name)).unwrap());
        }
        let mut model = create_model(files).unwrap();
        let documents = semantic_documents(&corpus);
        let indexed_total = documents.len();
        let started = std::time::Instant::now();
        let index = build_index(
            &mut model,
            &documents,
            corpus_fingerprint(&corpus),
            |indexed| {
                // bge-base over a full translation takes a long time; keep the
                // operator informed between batches.
                if indexed % (32 * 100) == 0 {
                    let elapsed = started.elapsed().as_secs_f64().max(1.0);
                    let rate = indexed as f64 / elapsed;
                    let remaining = (indexed_total - indexed) as f64 / rate.max(1.0);
                    eprintln!(
                    "fixture: {indexed}/{indexed_total} ({rate:.1} docs/s, ~{remaining:.0}s left)"
                );
                }
                Ok(())
            },
        )
        .expect("index build failed");
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bible_data")
            .join(index_file(PROBE_INDEX_VERSION));
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        save_index(&target, &index).unwrap();
        eprintln!(
            "probe fixture written: {} entries={} dimension={}",
            target.display(),
            index.entries.len(),
            index.dimension
        );
    }

    #[test]
    #[ignore = "uses a local model fixture to qualify semantic ranking"]
    fn bundled_index_quality_probe() {
        #[derive(serde::Deserialize)]
        struct ExpectedReference {
            book: String,
            chapter: i32,
            verse: i32,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            id: String,
            transcript: String,
            expected: Vec<ExpectedReference>,
        }

        let model_dir = std::env::var_os("WORDLYTE_TEST_BGE_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("opencode").join("bge-base-pin"));
        assert!(
            model_dir.is_dir(),
            "missing model fixture at {}",
            model_dir.display()
        );
        let mut files = std::collections::HashMap::new();
        for (name, _) in MODEL_FILES {
            let local_name = if *name == "onnx/model_quantized.onnx" {
                "model_quantized.onnx"
            } else {
                name
            };
            files.insert(*name, fs::read(model_dir.join(local_name)).unwrap());
        }
        let mut model = create_model(files).unwrap();
        let index = load_index(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("bible_data")
                .join(index_file(PROBE_INDEX_VERSION)),
        )
        .unwrap();
        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("evaluation")
            .join("ai-scripture")
            .join("paraphrase.jsonl");
        let fixtures = fs::read_to_string(fixture_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Fixture>(line).unwrap())
            .collect::<Vec<_>>();
        let mut top_one_hits = 0_usize;
        let mut top_three_hits = 0_usize;
        let mut accepted_negatives = Vec::new();
        let mut positives = 0_usize;
        let mut latencies = Vec::with_capacity(fixtures.len());
        for fixture in fixtures {
            positives += usize::from(!fixture.expected.is_empty());
            let started = std::time::Instant::now();
            let input = format!("{QUERY_PREFIX}{}", fixture.transcript);
            let mut vector = model.embed(vec![input], Some(1)).unwrap().remove(0);
            normalize(&mut vector);
            let scores = index.scores(&vector);
            let ranked = SemanticIndex::ranked_from(&scores, RANKING_POOL_SIZE);
            let first = ranked[0];
            let winner = &index.entries[first.0];
            let second = ranked
                .iter()
                .skip(1)
                .find(|(position, _)| !same_passage_neighborhood(winner, &index.entries[*position]))
                .copied()
                .unwrap();
            let runner = &index.entries[second.0];
            let margin = first.1 - second.1;
            let expected_top_one = fixture.expected.iter().any(|expected| {
                winner.book == expected.book
                    && winner.chapter == expected.chapter
                    && winner.verse == expected.verse
            });
            let mut distinct = Vec::new();
            for &(position, score) in &ranked {
                if distinct.len() >= MAX_SEMANTIC_SUGGESTIONS
                    || first.1 - score > MAX_ALTERNATIVE_DELTA
                    || score < MIN_SIMILARITY
                {
                    break;
                }
                let entry = &index.entries[position];
                if distinct.iter().all(|(existing, _)| {
                    !same_passage_neighborhood(entry, &index.entries[*existing])
                }) {
                    distinct.push((position, score));
                }
            }
            let expected_top_three = distinct.iter().any(|(position, _)| {
                let candidate = &index.entries[*position];
                fixture.expected.iter().any(|expected| {
                    candidate.book == expected.book
                        && candidate.chapter == expected.chapter
                        && candidate.verse == expected.verse
                })
            });
            let accepted =
                accepts_semantic_candidates(first.1, margin, distinct.len(), MIN_SIMILARITY);
            // Where the expected verse actually landed in the ranking pool.
            // `Some(1)` is a hit; `Some(n)` means a reranker could recover it;
            // `None` means retrieval never surfaced it and reranking cannot help.
            let expected_rank = ranked
                .iter()
                .position(|(position, _)| {
                    let candidate = &index.entries[*position];
                    fixture.expected.iter().any(|expected| {
                        candidate.book == expected.book
                            && candidate.chapter == expected.chapter
                            && candidate.verse == expected.verse
                    })
                })
                .map(|position| position + 1);
            // Best context-blended score of any entry covering an expected
            // verse, regardless of its rank. Distinguishes "crowded out of the
            // pool but would pass the gate" (hybrid recall fixes it) from "the
            // model never scored it" (needs a different retrieval approach).
            let expected_best = fixture
                .expected
                .iter()
                .fold(None::<f32>, |best, expected| {
                    let mut score = best.unwrap_or(f32::NEG_INFINITY);
                    for (position, entry) in index.entries.iter().enumerate() {
                        if entry.book == expected.book
                            && entry.chapter == expected.chapter
                            && entry.verse <= expected.verse
                            && expected.verse <= entry.verse_end
                        {
                            score = score.max(scores[position]);
                        }
                    }
                    Some(score)
                })
                .filter(|score| score.is_finite());
            if accepted && expected_top_one {
                top_one_hits += 1;
            }
            if accepted && expected_top_three {
                top_three_hits += 1;
            }
            if accepted && fixture.expected.is_empty() {
                accepted_negatives.push(fixture.id.clone());
            }
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            latencies.push(elapsed_ms);
            eprintln!(
                "fixture={} accepted={} top1={} top3={} expected_rank={:?} expected_best={} winner={} {}:{} score={:.3} runner={} {}:{} margin={:.3} elapsed_ms={:.1}",
                fixture.id,
                accepted,
                expected_top_one,
                expected_top_three,
                expected_rank,
                expected_best
                    .map(|score| format!("{score:.3}"))
                    .unwrap_or_else(|| "n/a".into()),
                winner.book,
                winner.chapter,
                winner.verse,
                first.1,
                runner.book,
                runner.chapter,
                runner.verse,
                margin,
                elapsed_ms,
            );
        }
        latencies.sort_by(f64::total_cmp);
        let p95 = latencies[((latencies.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(latencies.len() - 1)];
        eprintln!(
            "semantic fixture summary: top1={top_one_hits}/{positives} top3={top_three_hits}/{positives} accepted_negatives={} p95_ms={p95:.1}",
            accepted_negatives.len(),
        );
        assert!(
            accepted_negatives.is_empty(),
            "conservative gate emitted hard negatives: {accepted_negatives:?}"
        );
        assert!(p95 < 3_000.0, "semantic debug p95 exceeded 3 seconds");
        // Recalled-hit floors, calibrated on the pinned bge-base-en-v1.5 model
        // and bundled WEB index (top1=10/22, top3=12/22, zero accepted
        // negatives, Nov 2026). They sit one fixture below the calibrated
        // values so a ranking, model, or index change that degrades a single
        // fixture fails loudly, while small numeric drift does not.
        assert!(
            top_three_hits >= top_one_hits,
            "top-3 recall fell below top-1 recall"
        );
        assert!(
            top_one_hits >= 9,
            "semantic top-1 recall regressed: {top_one_hits}/{positives}"
        );
        assert!(
            top_three_hits >= 11,
            "semantic top-3 recall regressed: {top_three_hits}/{positives}"
        );
    }

    /// Calibration harness for the shipped hybrid retrieval path: dense top-N
    /// plus lexical FTS candidates, re-ranked by the pinned cross-encoder,
    /// blended with `blended_order`, then gated at `MIN_RERANK_SIMILARITY`.
    ///
    /// Requires the local index fixture (`builds_probe_index_fixture`), the
    /// flat pinned embedder (`WORDLYTE_TEST_BGE_MODEL`), the flat pinned
    /// reranker (`WORDLYTE_TEST_RERANKER_MODEL`), and the operator database
    /// (`WORDLYTE_TEST_BIBLE_DB`). Not a CI gate; run it after any model,
    /// index, blend-weight, or threshold change:
    /// `cargo test --lib evaluates_reranker_candidates -- --ignored --nocapture`
    #[test]
    #[ignore = "evaluates the hybrid retrieval pipeline against local model fixtures"]
    fn evaluates_reranker_candidates() {
        #[derive(serde::Deserialize)]
        struct ExpectedReference {
            book: String,
            chapter: i32,
            verse: i32,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            id: String,
            transcript: String,
            expected: Vec<ExpectedReference>,
        }

        let embed_dir: PathBuf = std::env::var_os("WORDLYTE_TEST_BGE_MODEL")
            .expect("set WORDLYTE_TEST_BGE_MODEL")
            .into();
        let rerank_dir: PathBuf = std::env::var_os("WORDLYTE_TEST_RERANKER_MODEL")
            .expect("set WORDLYTE_TEST_RERANKER_MODEL")
            .into();
        let default_db = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .expect("LOCALAPPDATA is not set")
            .join("io.wordlyte.app")
            .join("bible_data")
            .join("wordlyte_bible.db");
        let db_path = std::env::var_os("WORDLYTE_TEST_BIBLE_DB")
            .map(PathBuf::from)
            .unwrap_or(default_db);
        assert!(
            db_path.is_file(),
            "missing Bible database at {}",
            db_path.display()
        );

        let mut files = std::collections::HashMap::new();
        for (name, _) in MODEL_FILES {
            let local_name = if *name == "onnx/model_quantized.onnx" {
                "model_quantized.onnx"
            } else {
                name
            };
            files.insert(*name, fs::read(embed_dir.join(local_name)).unwrap());
        }
        let mut model = create_model(files).unwrap();
        let index = load_index(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("bible_data")
                .join(index_file(PROBE_INDEX_VERSION)),
        )
        .unwrap();
        let bible = BibleStore::open_for_tests(&db_path).expect("open Bible database");

        let mut reranker_files = std::collections::HashMap::new();
        for (name, _) in RERANKER_FILES {
            let local_name = if *name == "onnx/model_quantized.onnx" {
                "model_quantized.onnx"
            } else {
                name
            };
            reranker_files.insert(*name, fs::read(rerank_dir.join(local_name)).unwrap());
        }
        let mut reranker = create_reranker(reranker_files).unwrap();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("evaluation")
            .join("ai-scripture")
            .join("paraphrase.jsonl");
        let fixtures = fs::read_to_string(fixture_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Fixture>(line).unwrap())
            .collect::<Vec<_>>();

        let (mut positives, mut dense_top1, mut covered, mut hit_top1, mut hit_top3) =
            (0_usize, 0_usize, 0_usize, 0_usize, 0_usize);
        let (mut accepted_correct, mut accepted_wrong, mut false_accepts) =
            (0_usize, 0_usize, 0_usize);
        let (mut dense_accepted_correct, mut dense_accepted_wrong) = (0_usize, 0_usize);
        let mut dense_latency = Vec::new();
        let mut rerank_latency = Vec::new();

        for fixture in &fixtures {
            // Production returns before ranking for unstable repeated speech.
            if has_repeated_phrase(&fixture.transcript) {
                eprintln!("rerank fixture={} skipped=repeated-phrase", fixture.id);
                continue;
            }
            let started = std::time::Instant::now();
            let mut vector = model
                .embed(
                    vec![format!("{QUERY_PREFIX}{}", fixture.transcript)],
                    Some(1),
                )
                .unwrap()
                .remove(0);
            normalize(&mut vector);
            let scores = index.scores(&vector);
            let ranked = SemanticIndex::ranked_from(&scores, RERANK_POOL_SIZE);
            dense_latency.push(started.elapsed().as_secs_f64() * 1_000.0);

            let mut candidates: Vec<RerankCandidate> = Vec::new();
            for &(position, score) in &ranked {
                let entry = &index.entries[position];
                let Some(text) = passage_text(
                    &bible,
                    &entry.book,
                    entry.chapter,
                    entry.verse,
                    entry.verse_end,
                    PROBE_INDEX_VERSION,
                ) else {
                    continue;
                };
                candidates.push(RerankCandidate {
                    book: entry.book.clone(),
                    chapter: entry.chapter,
                    verse: entry.verse,
                    verse_end: entry.verse_end,
                    text,
                    dense: Some(score),
                });
            }
            let dense_count = candidates.len();
            if let Ok(lexical) = bible.search_quote_candidates(&fixture.transcript) {
                for verse in lexical {
                    if candidates.len() >= RERANK_POOL_SIZE + LEXICAL_CANDIDATE_LIMIT {
                        break;
                    }
                    if candidates.iter().any(|candidate| {
                        candidate.book == verse.book
                            && candidate.chapter == verse.chapter
                            && verse.verse >= candidate.verse
                            && verse.verse <= candidate.verse_end
                    }) {
                        continue;
                    }
                    let Some(text) = passage_text(
                        &bible,
                        &verse.book,
                        verse.chapter,
                        verse.verse,
                        verse.verse,
                        PROBE_INDEX_VERSION,
                    ) else {
                        continue;
                    };
                    candidates.push(RerankCandidate {
                        book: verse.book,
                        chapter: verse.chapter,
                        verse: verse.verse,
                        verse_end: verse.verse,
                        text,
                        dense: None,
                    });
                }
            }

            let covers = |candidate: &RerankCandidate| {
                fixture.expected.iter().any(|expected| {
                    expected.book == candidate.book
                        && expected.chapter == candidate.chapter
                        && expected.verse >= candidate.verse
                        && expected.verse <= candidate.verse_end
                })
            };
            let dense_rank = ranked
                .iter()
                .position(|&(position, _)| {
                    let entry = &index.entries[position];
                    fixture.expected.iter().any(|expected| {
                        expected.book == entry.book
                            && expected.chapter == entry.chapter
                            && expected.verse >= entry.verse
                            && expected.verse <= entry.verse_end
                    })
                })
                .map(|position| position + 1);

            let rerank_started = std::time::Instant::now();
            let documents = candidates
                .iter()
                .map(|candidate| candidate.text.as_str())
                .collect::<Vec<_>>();
            let reranked = reranker
                .rerank(fixture.transcript.as_str(), &documents, false, Some(16))
                .unwrap();
            rerank_latency.push(rerank_started.elapsed().as_secs_f64() * 1_000.0);

            let mut logits = vec![f32::NEG_INFINITY; candidates.len()];
            for result in &reranked {
                logits[result.index] = result.score;
            }
            let order = blended_order(&candidates, &logits);
            let top_similarity = sigmoid(logits[order[0]]);
            let runner = order
                .iter()
                .skip(1)
                .find(|&&position| {
                    !same_candidate_neighborhood(&candidates[order[0]], &candidates[position])
                })
                .copied();
            let margin = runner
                .map(|position| top_similarity - sigmoid(logits[position]))
                .unwrap_or(top_similarity);

            let is_covered = candidates.iter().any(covers);
            let expected_rank = order
                .iter()
                .position(|&position| covers(&candidates[position]));
            let top_correct = covers(&candidates[order[0]]);

            // Mirror the production match-building loop closely enough to
            // compare acceptance apples to apples: candidates within the
            // alternative delta stay eligible, which can bypass the margin
            // rule for close alternatives.
            let candidate_count = order
                .iter()
                .take_while(|&&position| {
                    let candidate_similarity = sigmoid(logits[position]);
                    top_similarity - candidate_similarity <= MAX_ALTERNATIVE_DELTA
                        && candidate_similarity >= MIN_RERANK_SIMILARITY
                })
                .count();
            let accepted = accepts_semantic_candidates(
                top_similarity,
                margin,
                candidate_count,
                MIN_RERANK_SIMILARITY,
            );

            // Dense-only baseline: what the shipped cosine gate would accept.
            let dense_top_similarity = ranked.first().map(|(_, score)| *score).unwrap_or(0.0);
            let dense_runner = ranked
                .iter()
                .skip(1)
                .find(|(position, _)| {
                    !same_passage_neighborhood(
                        &index.entries[ranked[0].0],
                        &index.entries[*position],
                    )
                })
                .map(|(_, score)| *score);
            let dense_margin = dense_runner
                .map(|score| dense_top_similarity - score)
                .unwrap_or(dense_top_similarity);
            let dense_accepted =
                accepts_semantic_candidates(dense_top_similarity, dense_margin, 1, MIN_SIMILARITY);

            if fixture.expected.is_empty() {
                if accepted {
                    false_accepts += 1;
                }
            } else {
                positives += 1;
                if dense_rank == Some(1) {
                    dense_top1 += 1;
                }
                if dense_accepted && dense_rank == Some(1) {
                    dense_accepted_correct += 1;
                }
                if dense_accepted && dense_rank != Some(1) {
                    dense_accepted_wrong += 1;
                }
                if is_covered {
                    covered += 1;
                }
                if expected_rank == Some(0) {
                    hit_top1 += 1;
                }
                if expected_rank.is_some_and(|position| position < 3) {
                    hit_top3 += 1;
                }
                if accepted && top_correct {
                    accepted_correct += 1;
                }
                if accepted && !top_correct {
                    accepted_wrong += 1;
                }
            }

            eprintln!(
                "rerank fixture={} dense_rank={:?} candidates={} covered={} expected_rank={:?} accepted={} top1_similarity={:.3}",
                fixture.id,
                dense_rank,
                dense_count,
                is_covered,
                expected_rank.map(|position| position + 1),
                accepted,
                top_similarity,
            );
        }

        dense_latency.sort_by(f64::total_cmp);
        rerank_latency.sort_by(f64::total_cmp);
        let p95 = |values: &[f64]| {
            values[((values.len() as f64 * 0.95).ceil() as usize)
                .saturating_sub(1)
                .min(values.len() - 1)]
        };
        eprintln!(
            "rerank summary: positives={positives} dense_top1={dense_top1} covered={covered} hit_top1={hit_top1} hit_top3={hit_top3} accepted_correct={accepted_correct} accepted_wrong={accepted_wrong} false_accepts={false_accepts} dense_accepted_correct={dense_accepted_correct} dense_accepted_wrong={dense_accepted_wrong} dense_p95_ms={:.1} rerank_p95_ms={:.1}",
            p95(&dense_latency),
            p95(&rerank_latency),
        );

        assert!(
            covered >= 20,
            "hybrid retrieval coverage regressed: {covered}/{positives}"
        );
        assert!(
            hit_top1 >= 15,
            "reranked top-1 regressed: {hit_top1}/{positives}"
        );
        assert_eq!(
            false_accepts, 0,
            "the rerank gate accepted non-scripture negatives"
        );
    }
}
