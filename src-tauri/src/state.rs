use crate::audio;
use crate::engine;
use crate::store;
use crate::events::TranscriptSegment;
use engine::model_manager::TranscriptionConfig;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use store::log_msg;

#[derive(Clone)]
pub struct AudioState {
    pub operator: Arc<Mutex<audio::AudioEngine>>,
    pub preacher: Arc<Mutex<audio::AudioEngine>>,
    pub studio: Arc<Mutex<audio::AudioEngine>>,
    pub operator_ptt_active: Arc<AtomicBool>,
    pub operator_muted: Arc<AtomicBool>,
    pub preacher_muted: Arc<AtomicBool>,
    pub operator_is_active: Arc<AtomicBool>,
    pub preacher_is_active: Arc<AtomicBool>,
    pub studio_is_active: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct ModelState {
    pub engine: Arc<Mutex<Option<Arc<engine::TranscriptionEngine>>>>,
    pub whisper_path: Arc<Mutex<Option<PathBuf>>>,
    pub embedding_model_path: PathBuf,
    pub tokenizer_path: PathBuf,
    pub reranker_model_path: PathBuf,
    pub reranker_tokenizer_path: PathBuf,
}

#[derive(Clone)]
pub struct PresentationState {
    pub live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub settings: Arc<Mutex<store::PresentationSettings>>,
    pub lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
}

#[derive(Clone)]
pub struct PipelineState {
    pub is_running: Arc<Mutex<bool>>,
    pub transcription_window: Arc<Mutex<usize>>,
    pub transcription_paused: Arc<AtomicBool>,
    pub inference_semaphore: Arc<tokio::sync::Semaphore>,
    pub session_transcript: Arc<Mutex<Vec<TranscriptSegment>>>,
    pub context_buffer: Arc<Mutex<Vec<String>>>,
    pub session_start_ms: Arc<Mutex<u64>>,
    pub operator_cloud_stream: Arc<Mutex<Option<engine::cloud_stream::CloudStreamHandle>>>,
    pub preacher_cloud_stream: Arc<Mutex<Option<engine::cloud_stream::CloudStreamHandle>>>,
}

#[derive(Clone)]
pub struct AppState {
    pub audio: AudioState,
    pub model: ModelState,
    pub presentation: PresentationState,
    pub pipeline: PipelineState,
    pub store: Arc<store::BibleStore>,
    pub media_schedule: Arc<store::MediaScheduleStore>,
    pub transcription_config: Arc<Mutex<TranscriptionConfig>>,
    pub app_data_dir: PathBuf,
    pub download_in_progress: Arc<AtomicBool>,
}

pub fn is_hallucination(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    if lower.is_empty() { return true; }
    const GARBAGE: &[&str] = &[
        "[blank_audio]", "[silence]", "[music]",
        "[inaudible]", "(silence)", "[ silence ]",
    ];
    if GARBAGE.iter().any(|g| lower.contains(g)) { return true; }
    if lower == "thank you." || lower == "thank you" || lower.starts_with("subtitles by") || lower.contains("amara.org") {
        return true;
    }
    let words: Vec<&str> = lower.split_whitespace().collect();
    let total_words = words.len();
    if total_words >= 6 {
        const RELIGIOUS_WHITELIST: &[&str] = &["amen", "hallelujah", "holy", "jesus", "lord"];
        let mut word_counts = std::collections::HashMap::new();
        for word in &words {
            let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
            if !RELIGIOUS_WHITELIST.contains(&clean) {
                *word_counts.entry(clean).or_insert(0) += 1;
            }
        }
        for count in word_counts.values() {
            if *count > total_words / 2 { return true; }
        }
        for seq_len in 1..=4 {
            if total_words >= seq_len * 3 {
                let seq = &words[0..seq_len];
                let mut all_match = true;
                for i in 1..3 {
                    if &words[i*seq_len..(i+1)*seq_len] != seq {
                        all_match = false;
                        break;
                    }
                }
                if all_match {
                    let first_word = seq[0].trim_matches(|c: char| !c.is_alphanumeric());
                    if !RELIGIOUS_WHITELIST.contains(&first_word) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

impl AppState {
    pub async fn get_or_init_engine(&self, app: &tauri::AppHandle) -> Result<Arc<engine::TranscriptionEngine>, String> {
        let engine = { self.model.engine.lock().clone() };
        if let Some(e) = engine { return Ok(e); }

        let whisper_path_opt = self.model.whisper_path.lock().clone();
        let use_gpu = self.transcription_config.lock().use_gpu;
        let embedding_path = self.model.embedding_model_path.to_str().unwrap_or("").to_string();
        let tokenizer_path = self.model.tokenizer_path.to_str().unwrap_or("").to_string();
        let reranker_model_path = self.model.reranker_model_path.to_str().unwrap_or("").to_string();
        let reranker_tokenizer_path = self.model.reranker_tokenizer_path.to_str().unwrap_or("").to_string();

        let whisper_str: Option<String> = whisper_path_opt.map(|p| p.to_str().unwrap_or("").to_string());
        let engine_mutex = self.model.engine.clone();

        log_msg(app, "Lazy-loading AI engine for semantic search...");

        match tokio::task::spawn_blocking(move || {
            engine::TranscriptionEngine::new(
                whisper_str.as_deref(),
                &embedding_path,
                &tokenizer_path,
                &reranker_model_path,
                &reranker_tokenizer_path,
                use_gpu,
            )
        }).await {
            Ok(Ok(e)) => {
                let e = Arc::new(e);
                *engine_mutex.lock() = Some(e.clone());
                log_msg(app, "AI engine loaded successfully.");
                Ok(e)
            }
            Ok(Err(e)) => {
                log_msg(app, &format!("AI engine failed to load: {}", e));
                Err(format!("AI models failed to load: {}", e))
            }
            Err(e) => {
                log_msg(app, &format!("AI engine loading task panicked: {}", e));
                Err(format!("Model loading task panicked: {}", e))
            }
        }
    }

    pub async fn search_bible(&self, app: &tauri::AppHandle, query: &str) -> Result<store::SearchResponse, String> {
        let ref_results = self.store.detect_verses_by_ref(query);
        if !ref_results.is_empty() {
            return Ok(store::SearchResponse { results: ref_results, method: "reference".to_string() });
        }

        let fts_results = self.store.search_manual_all_versions(query).unwrap_or_default();
        let mut semantic_results = Vec::new();

        match self.get_or_init_engine(app).await {
            Ok(engine) => {
                log_msg(app, &format!("Generating embedding for query: '{}'...", query));
                match engine.embed(query) {
                    Ok(embedding) => {
                        log_msg(app, "Embedding generated. Searching USearch index...");
                        semantic_results = self.store.search_top_n_semantic(app, &embedding, 50);
                    }
                    Err(e) => log_msg(app, &format!("Embedding error: {}", e)),
                }
            }
            Err(e) => log_msg(app, &format!("Failed to lazy-load engine for semantic search: {}", e)),
        }

        if semantic_results.is_empty() && fts_results.is_empty() {
            return Ok(store::SearchResponse { results: Vec::new(), method: "hybrid".to_string() });
        }

        let mut rrf_scores: std::collections::HashMap<(String, i32, i32), (f32, store::Verse)> = std::collections::HashMap::new();
        let k = 60.0;

        for (rank, verse) in fts_results.into_iter().enumerate() {
            let key = (verse.book.clone(), verse.chapter, verse.verse);
            let score = 1.0 / (k + rank as f32 + 1.0);
            rrf_scores.insert(key, (score, verse));
        }

        for (rank, verse) in semantic_results.into_iter().enumerate() {
            let key = (verse.book.clone(), verse.chapter, verse.verse);
            let score = 1.0 / (k + rank as f32 + 1.0);
            let entry = rrf_scores.entry(key).or_insert((0.0, verse.clone()));
            entry.0 += score;
            if entry.1.score.is_none() || (verse.score.is_some() && verse.score > entry.1.score) {
                entry.1.score = verse.score;
            }
        }

        let mut final_results: Vec<(f32, store::Verse)> = rrf_scores.into_values().collect();
        final_results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let mut candidates: Vec<store::Verse> = final_results.into_iter().take(50).map(|(_, v)| v).collect();

        if !candidates.is_empty() {
            if let Ok(engine) = self.get_or_init_engine(app).await {
                log_msg(app, &format!("Reranking {} candidates...", candidates.len()));
                let passages: Vec<String> = candidates.iter().map(|v| v.text.clone()).collect();
                match engine.rerank(query, &passages) {
                    Ok(scores) => {
                        for (i, score) in scores.into_iter().enumerate() {
                            candidates[i].score = Some(score);
                        }
                        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                        log_msg(app, "Reranking complete.");
                    }
                    Err(e) => log_msg(app, &format!("Reranking error: {}", e)),
                }
            }
        }

        Ok(store::SearchResponse { results: candidates.into_iter().take(20).collect(), method: "hybrid".to_string() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hallucination_empty() {
        assert!(is_hallucination(""));
        assert!(is_hallucination(" "));
    }

    #[test]
    fn hallucination_garbage_markers() {
        assert!(is_hallucination("[blank_audio]"));
        assert!(is_hallucination("[silence]"));
        assert!(is_hallucination("[music]"));
    }

    #[test]
    fn hallucination_whisper_artifacts() {
        assert!(is_hallucination("Thank you."));
        assert!(is_hallucination("thank you"));
        assert!(is_hallucination("Subtitles by amara.org"));
    }

    #[test]
    fn hallucination_repeating() {
        assert!(is_hallucination("hello hello hello hello hello hello hello"));
    }

    #[test]
    fn not_hallucination_normal() {
        assert!(!is_hallucination("The Lord is my shepherd"));
        assert!(!is_hallucination("Jesus said love one another"));
    }

    #[test]
    fn not_hallucination_religious_repeat() {
        assert!(!is_hallucination("amen amen amen amen amen amen"));
    }
}
