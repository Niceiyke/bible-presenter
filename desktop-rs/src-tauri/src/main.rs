// Bible Presenter RS Main Entry Point
// Triggering fresh CI build with reorganized resources
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, State, Emitter};
use std::sync::Arc;
use parking_lot::Mutex;
use serde::Serialize;
use bible_presenter_lib::{audio, engine, store};

#[derive(Clone, Serialize)]
struct TranscriptionUpdate {
    text: String,
    detected_verse: Option<store::Verse>,
}

struct AppState {
    audio: Arc<Mutex<audio::AudioEngine>>,
    engine: Option<Arc<engine::TranscriptionEngine>>,
    store: Arc<store::BibleStore>,
}

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let engine = state.engine.as_ref().ok_or("AI Models not loaded. Please ensure models are present in the resources directory.")?.clone();
    let audio = state.audio.clone();
    let store = state.store.clone();
    drop(state);
    
    let (tx, mut rx) = tokio::sync::mpsc::channel(50);
    
    {
        let mut audio_guard = audio.lock();
        audio_guard.start_capturing(tx).map_err(|e: anyhow::Error| e.to_string())?;
    }

    tokio::spawn(async move {
        let mut buffer = Vec::new();
        let window_size = 32000; // 2s at 16kHz
        let overlap = 8000;    // 500ms at 16kHz

        while let Some(mut chunk) = rx.recv().await {
            buffer.append(&mut chunk);

            if buffer.len() >= window_size { 
                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();
                
                // HYBRID DETECTION: Reference Regex + Semantic AI
                let result: Option<(String, Option<store::Verse>)> = tokio::task::spawn_blocking(move || {
                    let text = e_clone.transcribe(&b_clone).ok()?;
                    
                    // Generate embedding for semantic search
                    let embedding = e_clone.embed(&text).ok();
                    
                    // Call the hybrid detection logic
                    let mut verse = s_clone.detect_verse_hybrid(&text, embedding);
                    
                    // Final fallback: Text keyword overlap if embedding/regex both failed
                    if verse.is_none() {
                        verse = s_clone.search_semantic_text(&text);
                    }
                    Some((text, verse))
                }).await.ok().flatten();

                if let Some((text, verse)) = result {
                    if !text.trim().is_empty() {
                        let _ = app.emit("transcription-update", TranscriptionUpdate {
                            text,
                            detected_verse: verse,
                        });
                    }
                }
                
                let remaining = buffer.len() - overlap;
                buffer = buffer[remaining..].to_vec();
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn toggle_output_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            // Attempt to find a secondary monitor
            let monitors = window.available_monitors().map_err(|e: tauri::Error| e.to_string())?;
            if monitors.len() > 1 {
                // Find the first monitor that isn't the primary one
                if let Some(primary) = window.primary_monitor().map_err(|e: tauri::Error| e.to_string())? {
                    for monitor in monitors {
                        if monitor.name() != primary.name() {
                            let pos = monitor.position();
                            window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                                x: pos.x,
                                y: pos.y,
                            })).map_err(|e: tauri::Error| e.to_string())?;
                            window.set_fullscreen(true).map_err(|e: tauri::Error| e.to_string())?;
                            break;
                        }
                    }
                }
            }
            
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_audio_devices(state: State<'_, Arc<AppState>>) -> Result<Vec<(String, String)>, String> {
    let audio = state.audio.lock();
    audio.list_devices().map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_audio_device(state: State<'_, Arc<AppState>>, device_name: String) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio.select_device(&device_name).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_vad_threshold(state: State<'_, Arc<AppState>>, threshold: f32) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio.set_vad_threshold(threshold);
    Ok(())
}

#[tauri::command]
async fn search_manual(state: State<'_, Arc<AppState>>, query: String) -> Result<Vec<store::Verse>, String> {
    state.store.search_manual(&query).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_books(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    state.store.get_books().map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_chapters(state: State<'_, Arc<AppState>>, book: String) -> Result<Vec<i32>, String> {
    state.store.get_chapters(&book).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verses_count(state: State<'_, Arc<AppState>>, book: String, chapter: i32) -> Result<Vec<i32>, String> {
    state.store.get_verses_count(&book, chapter).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verse(state: State<'_, Arc<AppState>>, book: String, chapter: i32, verse: i32) -> Result<Option<store::Verse>, String> {
    state.store.get_verse(&book, chapter, verse).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn select_verse(app: AppHandle, verse: store::Verse) -> Result<(), String> {
    let _ = app.emit("transcription-update", TranscriptionUpdate {
        text: format!("{} {}:{}", verse.book, verse.chapter, verse.verse),
        detected_verse: Some(verse),
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let resolver = app.path();
            let resource_path = resolver.resource_dir().expect("Failed to get resource dir");
            println!("Resource Dir: {:?}", resource_path);
            
            let whisper_path = resource_path.join("models/whisper-base.bin");
            let embedding_model_path = resource_path.join("models/all-minilm-l6-v2.onnx");
            let tokenizer_path = resource_path.join("models/tokenizer.json");
            let db_path = resource_path.join("bible_data/bible.db");
            let embeddings_path = resource_path.join("bible_data/embeddings.npy");

            println!("Looking for DB at: {:?}", db_path);
            if !db_path.exists() {
                eprintln!("CRITICAL: Bible Database missing at {:?}", db_path);
            }

            // Load Engine (Non-fatal if missing, just warn)
            let engine = match engine::TranscriptionEngine::new(
                whisper_path.to_str().unwrap_or(""),
                embedding_model_path.to_str().unwrap_or(""),
                tokenizer_path.to_str().unwrap_or("")
            ) {
                Ok(e) => Some(Arc::new(e)),
                Err(e) => {
                    eprintln!("Warning: AI Engine failed to load: {}", e);
                    None
                }
            };

            let store = Arc::new(store::BibleStore::new(
                db_path.to_str().expect("Invalid DB path"),
                embeddings_path.to_str()
            ).expect("Failed to connect to Bible Database"));

            let audio = Arc::new(Mutex::new(audio::AudioEngine::new()));

            app.manage(Arc::new(AppState { audio, engine, store }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session, 
            toggle_output_window, 
            get_audio_devices, 
            set_audio_device,
            set_vad_threshold,
            search_manual,
            select_verse,
            get_books,
            get_chapters,
            get_verses_count,
            get_verse
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
