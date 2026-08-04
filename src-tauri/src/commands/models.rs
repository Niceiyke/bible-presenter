use crate::engine;
use crate::state::AppState;
use crate::events::SemanticIndexStatus;
use crate::engine::model_manager::{
    self, detect_hardware, download_model, list_model_statuses, model_path_if_exists, DownloadProgress, HardwareInfo, ModelStatus,
    TranscriptionConfig,
};
use crate::store;
use store::log_msg;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn get_semantic_index_status(app: AppHandle, state: State<'_, AppState>) -> Result<SemanticIndexStatus, String> {
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = engine::model_manager::semantic_index_path(&state.app_data_dir, &resource_path);
    let downloaded = path.is_some();
    Ok(SemanticIndexStatus { downloaded, path: path.map(|p| p.to_string_lossy().to_string()), size_mb: 300 })
}

use crate::events::VerseIndexStatus;

#[tauri::command]
pub async fn get_verse_index_status(app: AppHandle, state: State<'_, AppState>) -> Result<VerseIndexStatus, String> {
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path = engine::model_manager::verse_index_path(&state.app_data_dir, &resource_path);
    let downloaded = path.is_some();
    Ok(VerseIndexStatus { downloaded, path: path.map(|p| p.to_string_lossy().to_string()), size_mb: 11 })
}

#[tauri::command]
pub async fn download_bible_db_cmd(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_msg(&app, "Command received: download_bible_db_cmd");
    if state.download_in_progress.load(Ordering::Relaxed) {
        return Err("Another download is already in progress.".into());
    }
    state.download_in_progress.store(true, Ordering::SeqCst);
    let app_data = state.app_data_dir.clone();
    let cancel_flag = state.download_in_progress.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let res = engine::model_manager::download_and_extract_zip(
            engine::model_manager::BIBLE_DATA_ZIP_URL, "bible_db",
            &engine::model_manager::user_data_dir(&app_data), cancel_flag.clone(),
            { let app_handle = app_handle.clone(); move |progress| { let _ = app_handle.emit("download-progress", progress); } },
        ).await;
        cancel_flag.store(false, Ordering::SeqCst);
        match res {
            Ok(_) => {
                log_msg(&app_handle, "Bible data ZIP downloaded and extracted successfully.");
                let path = engine::model_manager::user_data_dir(&app_data).join(engine::model_manager::BIBLE_DB_FILENAME);
                let _ = app_handle.emit("bible-db-ready", path.to_string_lossy());
            }
            Err(e) => {
                log_msg(&app_handle, &format!("Bible data ZIP download failed: {}", e));
                let _ = app_handle.emit("download-error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn download_core_search_models_cmd(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_msg(&app, "Command received: download_core_search_models_cmd");
    if state.download_in_progress.load(Ordering::Relaxed) {
        return Err("Another download is already in progress.".into());
    }
    state.download_in_progress.store(true, Ordering::SeqCst);
    let app_data = state.app_data_dir.clone();
    let cancel_flag = state.download_in_progress.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let res = engine::model_manager::download_and_extract_zip(
            engine::model_manager::MODELS_ZIP_URL, "core_models",
            &engine::model_manager::user_models_dir(&app_data), cancel_flag.clone(),
            { let app_handle = app_handle.clone(); move |progress| { let _ = app_handle.emit("download-progress", progress); } },
        ).await;
        cancel_flag.store(false, Ordering::SeqCst);
        match res {
            Ok(_) => {
                log_msg(&app_handle, "Core search models ZIP downloaded and extracted successfully.");
                let _ = app_handle.emit("core-models-ready", true);
            }
            Err(e) => {
                log_msg(&app_handle, &format!("Core models ZIP download failed: {}", e));
                let _ = app_handle.emit("download-error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn list_whisper_models(state: State<'_, AppState>) -> Result<Vec<ModelStatus>, String> {
    let config = state.transcription_config.lock().clone();
    let hw = tokio::task::spawn_blocking(detect_hardware).await.map_err(|e| e.to_string())?;
    Ok(list_model_statuses(&config, &state.app_data_dir, &hw.recommended_model))
}

#[tauri::command]
pub async fn get_hardware_info() -> Result<HardwareInfo, String> {
    tokio::task::spawn_blocking(detect_hardware).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle, state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    log_msg(&app, &format!("Command received: download_whisper_model id={}", model_id));
    let info = model_manager::MODEL_CATALOG.iter().find(|m| m.id == model_id).cloned()
        .ok_or_else(|| format!("Unknown model id: {}", model_id))?;

    if state.download_in_progress.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("A download is already in progress".to_string());
    }

    let cancel_flag = state.download_in_progress.clone();
    let app_data_dir = state.app_data_dir.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        log_msg(&app_clone, &format!("Starting download for model: {}", info.id));
        let result = download_model(&info, &app_data_dir, cancel_flag.clone(), {
            let app_clone = app_clone.clone();
            move |progress| { let _ = app_clone.emit("download-progress", &progress); }
        }).await;
        cancel_flag.store(false, Ordering::SeqCst);
        match result {
            Ok(path) => { log_msg(&app_clone, &format!("Whisper model {} downloaded successfully to {:?}", info.id, path)); }
            Err(e) => {
                log_msg(&app_clone, &format!("Whisper model {} download failed: {}", info.id, e));
                let _ = app.emit("download-progress", DownloadProgress { model_id: info.id.to_string(), bytes_downloaded: 0, total_bytes: 0, percent: 0.0, done: true, error: Some(e.to_string()) });
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_whisper_download(state: State<'_, AppState>) -> Result<(), String> {
    state.download_in_progress.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn set_active_whisper_model(state: State<'_, AppState>, filename: String) -> Result<(), String> {
    let path = model_path_if_exists(&state.app_data_dir, &filename)
        .ok_or_else(|| format!("Model file not found: {}", filename))?;
    {
        let mut config = state.transcription_config.lock();
        config.active_model = Some(filename);
        config.save(&state.app_data_dir);
    }
    *state.model.whisper_path.lock() = Some(path);
    *state.model.engine.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn set_gpu_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    {
        let mut config = state.transcription_config.lock();
        config.use_gpu = enabled;
        config.save(&state.app_data_dir);
    }
    *state.model.engine.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn delete_whisper_model(state: State<'_, AppState>, filename: String) -> Result<(), String> {
    let active = state.transcription_config.lock().active_model.clone();
    if active.as_deref() == Some(&filename) {
        return Err("Cannot delete the active model. Select a different model first.".to_string());
    }
    model_manager::delete_model_file(&state.app_data_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_transcription_config(state: State<'_, AppState>) -> Result<TranscriptionConfig, String> {
    Ok(state.transcription_config.lock().clone())
}

#[tauri::command]
pub async fn set_cloud_config(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: Option<String>,
    api_key: Option<String>,
    hostname: Option<String>,
    model: Option<String>,
    rest_model: Option<String>,
    language: Option<String>,
    operator_mode: Option<String>,
    preacher_mode: Option<String>,
    auto_project: Option<bool>,
    verse_lock_secs: Option<u32>,
    confidence_threshold: Option<f32>,
) -> Result<(), String> {
    let valid = matches!(provider.as_deref(), None | Some("deepgram") | Some("openai") | Some("assemblyai") | Some("google"));
    if !valid { return Err(format!("Invalid cloud provider: {:?}", provider)); }

    {
        let mut config = state.transcription_config.lock();
        config.cloud_provider = provider.clone();
        if api_key.is_some() { config.cloud_api_key = api_key; }
        config.cloud_hostname = hostname.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_model = model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_rest_model = rest_model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_language = language.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(v) = operator_mode { config.operator_mode = Some(v); }
        if let Some(v) = preacher_mode { config.preacher_mode = Some(v); }
        if let Some(v) = auto_project { config.auto_project = v; }
        if let Some(v) = verse_lock_secs { config.verse_lock_secs = v; }
        if let Some(v) = confidence_threshold { config.confidence_threshold = v.clamp(0.0, 1.0); }
        config.save(&state.app_data_dir);
    }

    if let Some(v) = confidence_threshold {
        state.store.set_confidence_threshold(&app, v.clamp(0.0, 1.0));
    }

    *state.model.engine.lock() = None;

    if provider.is_none() {
        let filename = state.transcription_config.lock().active_model.clone();
        let new_path = filename.as_ref().and_then(|f| model_path_if_exists(&state.app_data_dir, f));
        *state.model.whisper_path.lock() = new_path;
    }

    Ok(())
}

#[tauri::command]
pub async fn test_cloud_connection(app: AppHandle, provider: String, api_key: String, model: Option<String>) -> Result<String, String> {
    log_msg(&app, &format!("[Test] Testing {} connection (model={:?})", provider, model));
    let result = crate::engine::cloud::test_connection(&provider, &api_key, model.as_deref()).await;
    match &result {
        Ok(_) => log_msg(&app, &format!("[Test] {} connection OK", provider)),
        Err(e) => log_msg(&app, &format!("[Test] {} connection FAILED: {}", provider, e)),
    }
    result.map(|_| "Connected".to_string()).map_err(|e| e.to_string())
}

use serde::Serialize;

#[derive(Serialize)]
pub struct StartupStatus {
    pub db_ok: bool,
    pub embeddings_ok: bool,
    pub onnx_model_ok: bool,
    pub tokenizer_ok: bool,
    pub reranker_ok: bool,
    pub whisper_model_ok: bool,
    pub whisper_model_name: Option<String>,
    pub db_path: String,
    pub issues: Vec<String>,
}

#[tauri::command]
pub async fn get_startup_status(app: AppHandle, state: State<'_, AppState>) -> Result<StartupStatus, String> {
    let mut issues = Vec::new();
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));

    let db_path = engine::model_manager::bible_db_path(&state.app_data_dir, &resource_path);
    let emb_path = engine::model_manager::semantic_index_path(&state.app_data_dir, &resource_path);
    let vidx_path = engine::model_manager::verse_index_path(&state.app_data_dir, &resource_path);

    let db_ok = db_path.exists();
    let emb_ok = emb_path.is_some();
    let vidx_ok = vidx_path.is_some();
    let onnx_ok = state.model.embedding_model_path.exists();
    let tok_ok = state.model.tokenizer_path.exists();
    let rerank_ok = state.model.reranker_model_path.exists() && state.model.reranker_tokenizer_path.exists();

    let whisper = state.model.whisper_path.lock().clone();
    let whisper_ok = whisper.as_ref().map_or(false, |p| p.exists());
    let whisper_name = whisper.and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()));

    if !db_ok { issues.push("Bible database not found. Please download it in Settings.".to_string()); }
    if !emb_ok { issues.push("Embeddings file missing. Auto-detection will be unavailable.".to_string()); }
    if !vidx_ok { issues.push("Verse index missing. Semantic search might be limited.".to_string()); }
    if !onnx_ok { issues.push("ONNX embedding model missing. Semantic search disabled.".to_string()); }
    if !tok_ok { issues.push("Tokenizer missing. Semantic search disabled.".to_string()); }
    if !rerank_ok { issues.push("Reranker model missing. Precision search will be limited.".to_string()); }
    if !whisper_ok { issues.push("No Whisper model selected. Go to Settings \u{2192} Transcription Model.".to_string()); }

    Ok(StartupStatus { db_ok, embeddings_ok: emb_ok, onnx_model_ok: onnx_ok, tokenizer_ok: tok_ok, reranker_ok: rerank_ok, whisper_model_ok: whisper_ok, whisper_model_name: whisper_name, db_path: db_path.display().to_string(), issues })
}

#[tauri::command]
pub async fn set_confidence_threshold(app: AppHandle, state: State<'_, AppState>, threshold: f32) -> Result<(), String> {
    let clamped = threshold.clamp(0.0, 1.0);
    state.store.set_confidence_threshold(&app, clamped);
    {
        let mut config = state.transcription_config.lock();
        config.confidence_threshold = clamped;
        config.save(&state.app_data_dir);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_transcripts(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let dir = state.app_data_dir.join("transcripts");
    if !dir.exists() { return Ok(Vec::new()); }
    let mut files: Vec<String> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    files.sort_by(|a, b| b.cmp(a));
    Ok(files)
}
