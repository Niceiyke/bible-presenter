use crate::ai_detection::has_repeated_phrase;
use crate::store::{BibleStore, SemanticCorpusVerse, Verse};
use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use hf_hub::{Repo, RepoType};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read};
#[cfg(test)]
use std::io::{BufWriter, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const INDEX_MAGIC: &[u8; 8] = b"WLYSEM02";
const INDEX_FILE: &str = "bible-semantic-bge-v1.index";
const INDEX_SHA256: &str = "a541018334369d5a41212e4bbccc8738dad472f64345d8c95e6bc7e0a22db4ec";
const READY_MARKER: &str = "prepared-v1";
const MODEL_ID: &str = "BAAI/bge-small-en-v1.5-quantized";
const MODEL_REPOSITORY: &str = "Xenova/bge-small-en-v1.5";
const MODEL_REVISION: &str = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
const MODEL_FILES: &[(&str, &str)] = &[
    (
        "onnx/model_quantized.onnx",
        "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
    ),
    (
        "tokenizer.json",
        "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    ),
    (
        "config.json",
        "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
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
const EMBEDDING_DIMENSION: usize = 384;
const MIN_QUERY_WORDS: usize = 5;
pub const MIN_SIMILARITY: f32 = 0.70;
pub const MIN_MARGIN: f32 = 0.025;
const MAX_SEMANTIC_SUGGESTIONS: usize = 3;
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
}

struct SemanticIndex {
    fingerprint: [u8; 32],
    dimension: usize,
    entries: Vec<IndexEntry>,
    vectors: Vec<i8>,
}

impl SemanticIndex {
    fn ranked(&self, query: &[f32], limit: usize) -> Vec<(usize, f32)> {
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
        let mut ranked: Vec<(usize, f32)> = Vec::with_capacity(limit);
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
                if neighbor.book == entry.book
                    && neighbor.chapter == entry.chapter
                    && (neighbor.verse - entry.verse).abs() == 1
                {
                    score += raw_scores[neighbor_index] * PASSAGE_CONTEXT_WEIGHT;
                    context_count += PASSAGE_CONTEXT_WEIGHT;
                }
            }
            score -= raw_score * context_count;
            let position = ranked
                .binary_search_by(|(_, current)| current.total_cmp(&score).reverse())
                .unwrap_or_else(|position| position);
            if position < limit {
                ranked.insert(position, (index, score));
                if ranked.len() > limit {
                    ranked.pop();
                }
            }
        }
        ranked
    }
}

pub struct SemanticScripture {
    root: PathBuf,
    preparing: AtomicBool,
    cancel_requested: AtomicBool,
    status: Mutex<SemanticStatus>,
    model: Mutex<Option<TextEmbedding>>,
    index: Mutex<Option<SemanticIndex>>,
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
            index: Mutex::new(None),
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

    fn prepare(
        &self,
        app: &AppHandle,
        bible: &BibleStore,
        bundled_index: &Path,
    ) -> Result<(), String> {
        self.update_status(
            app,
            "preparing",
            "Reading installed English Bible translations…",
            0,
            0,
        );
        let corpus = bible.semantic_corpus().map_err(|error| error.to_string())?;
        if corpus.is_empty() {
            return Err("No installed English Bible translations are available.".into());
        }
        let fingerprint = corpus_fingerprint(&corpus);
        let total = corpus.len();

        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        self.update_status(
            app,
            "preparing",
            "Loading the local paraphrase model. First preparation may download about 35 MB…",
            0,
            total,
        );
        let mut model = load_pinned_model(&self.root, |completed, total, file| {
            if self.cancel_requested.load(Ordering::Acquire) {
                return Err(PREPARATION_CANCELLED.to_string());
            }
            self.update_status(
                app,
                "preparing",
                format!("Preparing model files… {completed}/{total} verified ({file})"),
                completed,
                total,
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
            MODEL_FILES.len(),
        );
        let warmup = format!("{QUERY_PREFIX}local Bible passage retrieval");
        model
            .embed(vec![warmup.as_str()], Some(1))
            .map_err(|error| format!("Could not warm the local paraphrase model: {error}"))?;

        self.update_status(
            app,
            "preparing",
            "Loading the compact local Bible meaning index…",
            0,
            total,
        );
        let local_index = self.root.join(INDEX_FILE);
        let index = [local_index.as_path(), bundled_index]
            .into_iter()
            .find_map(|path| load_verified_index(path).ok())
            .filter(|index| {
                index.fingerprint == fingerprint
                    && index.dimension == EMBEDDING_DIMENSION
                    && index.entries.len() == total
            })
            .ok_or_else(|| {
                "The bundled paraphrase index does not match the installed Bible data. Update Wordlyte or reinstall the supported Bible asset.".to_string()
            })?;
        *self.model.lock() = Some(model);
        *self.index.lock() = Some(index);
        let _ = fs::write(self.root.join(READY_MARKER), MODEL_REVISION);
        self.update_status(
            app,
            "ready",
            "Local paraphrase matching is ready.",
            total,
            total,
        );
        Ok(())
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
                minimum_similarity: MIN_SIMILARITY,
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

        let index = self.index.lock();
        let Some(index) = index.as_ref() else {
            return Err("Local paraphrase index is not loaded.".into());
        };
        let ranked = index.ranked(&query_vector, RANKING_POOL_SIZE);
        let Some(&(winner_index, similarity)) = ranked.first() else {
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
        };
        let winner = &index.entries[winner_index];
        let distinct_runner = ranked.iter().skip(1).find(|(candidate_index, _)| {
            !same_passage_neighborhood(winner, &index.entries[*candidate_index])
        });
        let margin = distinct_runner
            .map(|(_, score)| similarity - score)
            .unwrap_or(similarity);

        let mut diagnostic_candidates = Vec::new();
        let mut matches = Vec::new();
        let mut consumed = std::collections::HashSet::new();
        for &(candidate_index, candidate_similarity) in &ranked {
            if matches.len() >= MAX_SEMANTIC_SUGGESTIONS
                || similarity - candidate_similarity > MAX_ALTERNATIVE_DELTA
                || candidate_similarity < MIN_SIMILARITY
            {
                break;
            }
            if consumed.contains(&candidate_index) {
                continue;
            }
            let entry = &index.entries[candidate_index];
            let mut passage_start = entry.verse;
            let mut passage_end = entry.verse;
            for &(neighbor_index, neighbor_similarity) in &ranked {
                let neighbor = &index.entries[neighbor_index];
                if same_passage_neighborhood(entry, neighbor)
                    && candidate_similarity - neighbor_similarity <= MAX_PASSAGE_NEIGHBOR_DELTA
                {
                    consumed.insert(neighbor_index);
                    passage_start = passage_start.min(neighbor.verse);
                    passage_end = passage_end.max(neighbor.verse);
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
                (0.55 + (candidate_similarity - MIN_SIMILARITY) * 0.65 + margin * 0.35
                    - (rank.saturating_sub(1) as f32 * 0.04))
                    .clamp(0.55, MAX_PARAPHRASE_CONFIDENCE);
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

        let accepted = accepts_semantic_candidates(similarity, margin, matches.len());
        let (state, reason) = if similarity < MIN_SIMILARITY {
            matches.clear();
            (
                "rejected",
                "Best candidate was below the minimum similarity threshold.",
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
                MODEL_FILES.len(),
            );
        }
        self.status()
    }

    pub fn remove_local_model(&self, app: &AppHandle) -> Result<SemanticStatus, String> {
        if self.preparing.load(Ordering::Acquire) {
            return Err("Cancel paraphrase preparation before removing local files.".into());
        }
        *self.model.lock() = None;
        *self.index.lock() = None;
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

fn same_passage_neighborhood(left: &IndexEntry, right: &IndexEntry) -> bool {
    left.book == right.book
        && left.chapter == right.chapter
        && (left.verse - right.verse).abs() <= 1
}

fn accepts_semantic_candidates(similarity: f32, margin: f32, candidate_count: usize) -> bool {
    similarity >= MIN_SIMILARITY && (margin >= MIN_MARGIN || candidate_count >= 2)
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
    let bundled_index = app
        .path()
        .resource_dir()
        .map(|directory| directory.join("bible_data").join(INDEX_FILE))
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("bible_data")
                .join(INDEX_FILE)
        });
    tauri::async_runtime::spawn_blocking(move || {
        match catch_unwind(AssertUnwindSafe(|| {
            worker_engine.prepare(&app, &bible, &bundled_index)
        })) {
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

fn prepared_marker_matches(root: &Path) -> bool {
    fs::read_to_string(root.join(READY_MARKER))
        .is_ok_and(|revision| revision.trim() == MODEL_REVISION)
}

fn load_pinned_model(
    root: &Path,
    mut progress: impl FnMut(usize, usize, &str) -> Result<(), String>,
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
        progress(index, MODEL_FILES.len(), name)?;
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
        progress(index + 1, MODEL_FILES.len(), name)?;
    }

    create_model(files)
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

#[cfg(test)]
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
    let mut reader = BufReader::new(file);
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
    if dimension != EMBEDDING_DIMENSION || count == 0 || count > 40_000 {
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
        entries.push(IndexEntry {
            book,
            chapter,
            verse,
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

fn load_verified_index(path: &Path) -> Result<SemanticIndex, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_hash != INDEX_SHA256 {
        return Err(format!(
            "Bible meaning index integrity check failed at {}.",
            path.display()
        ));
    }
    load_index(path)
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
                },
                IndexEntry {
                    book: "Psalms".into(),
                    chapter: 23,
                    verse: 1,
                },
                IndexEntry {
                    book: "Isaiah".into(),
                    chapter: 40,
                    verse: 31,
                },
            ],
            vectors: vec![127, 0, 0, 0, 127, 0, 102, 25, 0],
        };
        let ranked = index.ranked(&[1.0, 0.0, 0.0], 2);
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
        assert_eq!(loaded.vectors, index.vectors);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn paraphrase_confidence_cannot_reach_auto_stage_threshold() {
        let confidence = (0.55 + (1.0 - MIN_SIMILARITY) * 0.65 + 1.0 * 0.35)
            .clamp(0.55, MAX_PARAPHRASE_CONFIDENCE);
        assert_eq!(confidence, 0.89);
        assert!(confidence < 0.90);
    }

    #[test]
    fn close_semantic_candidates_require_manual_alternatives() {
        assert!(!accepts_semantic_candidates(0.75, 0.01, 1));
        assert!(accepts_semantic_candidates(0.75, 0.01, 2));
        assert!(accepts_semantic_candidates(0.70, 0.01, 3));
        assert!(!accepts_semantic_candidates(0.69, 0.10, 3));
    }

    #[test]
    fn bundled_index_has_pinned_integrity() {
        let index = load_verified_index(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("bible_data")
                .join(INDEX_FILE),
        )
        .unwrap();
        assert_eq!(index.dimension, EMBEDDING_DIMENSION);
        assert_eq!(index.entries.len(), 31_105);
    }

    #[test]
    fn prepared_marker_must_match_model_revision() {
        let root = std::env::temp_dir().join(format!("wordlyte-marker-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(READY_MARKER), "old-model-revision").unwrap();
        assert!(!prepared_marker_matches(&root));
        fs::write(root.join(READY_MARKER), format!("{MODEL_REVISION}\n")).unwrap();
        assert!(prepared_marker_matches(&root));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "downloads the pinned local embedding model"]
    fn pinned_model_loads_and_embeds_offline_query() {
        let root = std::env::temp_dir().join(format!("wordlyte-model-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut model = load_pinned_model(&root, |_, _, _| Ok(())).unwrap();
        let embeddings = model
            .embed(vec!["God gives strength to the weak"], Some(1))
            .unwrap();
        assert_eq!(embeddings.len(), 1);
        assert_eq!(embeddings[0].len(), EMBEDDING_DIMENSION);
        let _ = fs::remove_dir_all(root);
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
            .unwrap_or_else(|| std::env::temp_dir().join("opencode").join("bge-pin"));
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
                .join(INDEX_FILE),
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
            let ranked = index.ranked(&vector, RANKING_POOL_SIZE);
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
            let accepted = accepts_semantic_candidates(first.1, margin, distinct.len());
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
                "fixture={} accepted={} top1={} top3={} winner={} {}:{} score={:.3} runner={} {}:{} margin={:.3} elapsed_ms={:.1}",
                fixture.id,
                accepted,
                expected_top_one,
                expected_top_three,
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
    }
}
