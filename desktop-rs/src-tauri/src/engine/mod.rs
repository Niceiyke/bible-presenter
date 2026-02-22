use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;


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

        let embedding_session = Session::builder()?
            .with_intra_threads(2)?
            .commit_from_file(embedding_model_path)?;

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

        let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> = encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
        let token_type_ids: Vec<i64> = encoding.get_type_ids().iter().map(|&i| i as i64).collect();

        let seq_len = input_ids.len();

        let inputs = ort::inputs![
            "input_ids" => Tensor::from_array(([1usize, seq_len], input_ids))?,
            "attention_mask" => Tensor::from_array(([1usize, seq_len], attention_mask))?,
            "token_type_ids" => Tensor::from_array(([1usize, seq_len], token_type_ids))?,
        ];

        let outputs = self.embedding_session.run(inputs)?;
        let (shape, data) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;

        // shape is [batch=1, seq_len, hidden_dim]
        let dim = shape[2] as usize;

        // Mean pooling over the sequence dimension
        let mut mean = vec![0.0f32; dim];
        for s in 0..seq_len {
            for d in 0..dim {
                mean[d] += data[s * dim + d];
            }
        }
        for d in 0..dim {
            mean[d] /= seq_len as f32;
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
}
