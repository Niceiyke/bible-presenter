pub mod cloud;
pub mod cloud_stream;
pub mod model_manager;

use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;
use parking_lot::Mutex;


pub struct TranscriptionEngine {
    whisper: Option<WhisperContext>,   // None when cloud provider is active
    embedding_session: Mutex<Session>,
    tokenizer: Tokenizer,
    reranker_session: Mutex<Session>,
    reranker_tokenizer: Tokenizer,
}

impl TranscriptionEngine {
    pub fn new(
        whisper_path: Option<&str>,
        embedding_model_path: &str,
        tokenizer_path: &str,
        reranker_model_path: &str,
        reranker_tokenizer_path: &str,
        use_gpu: bool,
    ) -> anyhow::Result<Self> {
        let whisper = if let Some(path) = whisper_path {
            let mut params = WhisperContextParameters::default();
            params.use_gpu(use_gpu);
            Some(WhisperContext::new_with_params(path, params)?)
        } else {
            None
        };

        let embedding_session = Session::builder()?
            .with_intra_threads(2)?
            .commit_from_file(embedding_model_path)?;

        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        let reranker_session = Session::builder()?
            .with_intra_threads(4)?
            .commit_from_file(reranker_model_path)?;

        let reranker_tokenizer = Tokenizer::from_file(reranker_tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load reranker tokenizer: {}", e))?;

        Ok(Self { 
            whisper, 
            embedding_session: Mutex::new(embedding_session), 
            tokenizer,
            reranker_session: Mutex::new(reranker_session),
            reranker_tokenizer,
        })
    }

    pub fn transcribe(&self, audio_data: &[f32], language: Option<&str>) -> anyhow::Result<String> {
        let ctx = self.whisper.as_ref()
            .ok_or_else(|| anyhow::anyhow!("No local Whisper model (cloud mode active)"))?;

        let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: 0.1 });
        params.set_n_threads(num_cpus::get() as i32);
        params.set_language(Some(language.unwrap_or("en")));
        
        // Disable various prints to reduce console noise and minor CPU cycles
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        let mut state = ctx.create_state()?;
        state.full(params, audio_data)?;

        let mut transcript = String::new();
        for i in 0..state.full_n_segments()? {
            if let Ok(segment) = state.full_get_segment_text(i) {
                transcript.push_str(&segment);
            }
        }
        Ok(transcript.trim().to_string())
    }

    /// Generate 384-dim embedding vector for semantic search
    pub fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let encoding = self.tokenizer.encode(text, true)
            .map_err(|e| anyhow::anyhow!("Tokenization error: {}", e))?;

        let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> = encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
        let token_type_ids: Vec<i64> = encoding.get_type_ids().iter().map(|&i| i as i64).collect();

        let seq_len = input_ids.len();

        let inputs = ort::inputs![
            "input_ids" => Tensor::from_array(([1usize, seq_len], input_ids))?,
            "attention_mask" => Tensor::from_array(([1usize, seq_len], attention_mask.clone()))?,
            "token_type_ids" => Tensor::from_array(([1usize, seq_len], token_type_ids))?,
        ];

        let mut session = self.embedding_session.lock();
        let outputs = session.run(inputs)?;
        let (shape, data) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;

        // shape is [batch=1, seq_len, hidden_dim]
        let dim = shape[2] as usize;

        // Mean pooling over the sequence dimension, respecting the attention mask
        let mut mean = vec![0.0f32; dim];
        let mut non_padding_tokens = 0.0f32;
        for s in 0..seq_len {
            if attention_mask[s] == 1 {
                non_padding_tokens += 1.0;
                for d in 0..dim {
                    mean[d] += data[s * dim + d];
                }
            }
        }
        if non_padding_tokens > 0.0 {
            for d in 0..dim {
                mean[d] /= non_padding_tokens;
            }
        }

        // L2 Normalization for Cosine Similarity
        let norm: f32 = mean.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut mean {
                *x /= norm;
            }
        }

        Ok(mean)
    }

    /// Rerank candidates using Cross-Encoder model.
    /// Returns a vector of scores corresponding to each passage.
    pub fn rerank(&self, query: &str, passages: &[String]) -> anyhow::Result<Vec<f32>> {
        let mut scores = Vec::with_capacity(passages.len());
        let mut session = self.reranker_session.lock();

        for passage in passages {
            let encoding = self.reranker_tokenizer.encode((query.to_string(), passage.to_string()), true)
                .map_err(|e| anyhow::anyhow!("Reranker tokenization error: {}", e))?;

            let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
            let attention_mask: Vec<i64> = encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
            let token_type_ids: Vec<i64> = encoding.get_type_ids().iter().map(|&i| i as i64).collect();
            let seq_len = input_ids.len();

            let inputs = ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, seq_len], input_ids))?,
                "attention_mask" => Tensor::from_array(([1usize, seq_len], attention_mask))?,
                "token_type_ids" => Tensor::from_array(([1usize, seq_len], token_type_ids))?,
            ];

            let outputs = session.run(inputs)?;
            let (_shape, data) = outputs["logits"].try_extract_tensor::<f32>()?;
            scores.push(data[0]);
        }

        Ok(scores)
    }
}
