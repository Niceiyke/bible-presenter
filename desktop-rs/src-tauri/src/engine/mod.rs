use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};
use ort::{Session, SessionBuilder, Value};
use ndarray::{Array2, Axis};
use tokenizers::Tokenizer;
use std::sync::Arc;

pub struct TranscriptionEngine {
    whisper: WhisperContext,
    embedding_session: Session,
    tokenizer: Tokenizer,
}

impl TranscriptionEngine {
    pub fn new(whisper_path: &str, embedding_model_path: &str, tokenizer_path: &str) -> anyhow::Result<Self> {
        let whisper = WhisperContext::new_with_params(
            whisper_path,
            WhisperContextParameters::default()
        )?;

        let embedding_session = SessionBuilder::new()?
            .with_intra_threads(2)?
            .with_model_from_file(embedding_model_path)?;

        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        Ok(Self { whisper, embedding_session, tokenizer })
    }

    pub fn transcribe(&self, audio_data: &[f32]) -> anyhow::Result<String> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(num_cpus::get() as i32);
        params.set_language(Some("en"));
        
        let mut state = self.whisper.create_state()?;
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
        
        let input_ids = encoding.get_ids().iter().map(|&id| id as i64).collect::<Vec<_>>();
        let attention_mask = encoding.get_attention_mask().iter().map(|&m| m as i64).collect::<Vec<_>>();
        let token_type_ids = encoding.get_type_ids().iter().map(|&i| i as i64).collect::<Vec<_>>();
        
        let seq_len = input_ids.len();
        let input_ids_array = Array2::from_shape_vec((1, seq_len), input_ids)?;
        let attention_mask_array = Array2::from_shape_vec((1, seq_len), attention_mask)?;
        let token_type_ids_array = Array2::from_shape_vec((1, seq_len), token_type_ids)?;

        let inputs = ort::inputs![
            "input_ids" => input_ids_array,
            "attention_mask" => attention_mask_array,
            "token_type_ids" => token_type_ids_array,
        ]?;
        
        let outputs = self.embedding_session.run(inputs)?;
        let token_embeddings = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        
        // Mean pooling over the sequence dimension (dim 1)
        let mean_embedding = token_embeddings
            .view()
            .mean_axis(Axis(1))
            .ok_or_else(|| anyhow::anyhow!("Failed to compute mean pooling"))?;

        // L2 Normalization for Cosine Similarity
        let mut embedding = mean_embedding.to_owned();
        let norm = embedding.mapv(|x| x * x).sum().sqrt();
        if norm > 0.0 {
            embedding /= norm;
        }

        Ok(embedding.into_raw_vec())
    }
}
