export interface StartupStatus {
  db_ok: boolean;
  embeddings_ok: boolean;
  onnx_model_ok: boolean;
  tokenizer_ok: boolean;
  reranker_ok: boolean;
  whisper_model_ok: boolean;
  whisper_model_name: string | null;
  db_path: string;
  issues: string[];
}
