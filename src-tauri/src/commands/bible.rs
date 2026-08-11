use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn get_bible_versions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.store.get_available_versions())
}

#[tauri::command]
pub async fn set_bible_version(app: AppHandle, state: State<'_, AppState>, version: String) -> Result<(), String> {
    state.store.set_active_version(&app, &version);
    Ok(())
}

#[tauri::command]
pub fn split_verse(verse: store::Verse, threshold: Option<usize>) -> Vec<store::Verse> {
    let limit = threshold.unwrap_or(200);
    let text = verse.text.trim();
    if text.len() <= limit { return vec![verse]; }

    let mut slides = Vec::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut current_text = String::new();

    for word in words {
        if !current_text.is_empty() && current_text.len() + word.len() + 1 > limit {
            slides.push(current_text.trim().to_string());
            current_text = String::new();
        }
        if !current_text.is_empty() { current_text.push(' '); }
        current_text.push_str(word);
    }
    if !current_text.is_empty() { slides.push(current_text.trim().to_string()); }

    let total = slides.len();
    slides.into_iter().enumerate().map(|(i, t)| {
        let mut v = verse.clone();
        v.text = t;
        v.split_index = Some(i);
        v.total_splits = Some(total);
        v
    }).collect()
}

#[tauri::command]
pub async fn search_semantic_query(state: State<'_, AppState>, query: String, version: String) -> Result<store::SearchResponse, String> {
    state.store.search_all(&query, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn read_file_base64(app: AppHandle, path: String) -> Result<String, String> {
    use base64::Engine as _;
    let data_dir = app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;

    let requested_path = std::path::PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&requested_path)
        .map_err(|_| "Access denied: path could not be resolved".to_string())?;
    let canonical_data_dir = std::fs::canonicalize(&data_dir).unwrap_or(data_dir);

    if !canonical.starts_with(&canonical_data_dir) {
        return Err("Access denied: path is outside of authorized data directory".to_string());
    }

    let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn get_books(state: State<'_, AppState>, version: String) -> Result<Vec<String>, String> {
    state.store.get_books(&version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_chapters(state: State<'_, AppState>, book: String, version: String) -> Result<Vec<i32>, String> {
    state.store.get_chapters(&book, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_verses_count(state: State<'_, AppState>, book: String, chapter: i32, version: String) -> Result<Vec<i32>, String> {
    state.store.get_verses_count(&book, chapter, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_chapter(state: State<'_, AppState>, book: String, chapter: i32, version: String) -> Result<Vec<store::Verse>, String> {
    state.store.get_chapter_verses(&book, chapter, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_verse(state: State<'_, AppState>, book: String, chapter: i32, verse: i32, version: String) -> Result<Option<store::Verse>, String> {
    state.store.get_verse(&book, chapter, verse, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_next_verse(state: State<'_, AppState>, book: String, chapter: i32, verse: i32, version: String) -> Result<Option<store::Verse>, String> {
    state.store.get_next_verse(&book, chapter, verse, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn get_prev_verse(state: State<'_, AppState>, book: String, chapter: i32, verse: i32, version: String) -> Result<Option<store::Verse>, String> {
    state.store.get_prev_verse(&book, chapter, verse, &version).map_err(|e: anyhow::Error| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Verse;

    #[test]
    fn split_verse_short() {
        let v = Verse {
            book: "John".into(), chapter: 3, verse: 16,
            text: "Short verse".into(), version: "KJV".into(),
            split_index: None, total_splits: None, score: None,
        };
        let result = split_verse(v, Some(200));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "Short verse");
    }

    #[test]
    fn split_verse_long() {
        let words = vec!["word"; 100];
        let text = words.join(" ");
        let v = Verse {
            book: "John".into(), chapter: 3, verse: 16,
            text, version: "KJV".into(),
            split_index: None, total_splits: None, score: None,
        };
        let result = split_verse(v, Some(50));
        assert!(result.len() > 1);
        assert_eq!(result[0].split_index, Some(0));
        assert_eq!(result.last().unwrap().total_splits, Some(result.len()));
    }

    #[test]
    fn split_verse_exact() {
        let v = Verse {
            book: "Gen".into(), chapter: 1, verse: 1,
            text: "exact amount".into(), version: "KJV".into(),
            split_index: None, total_splits: None, score: None,
        };
        let result = split_verse(v, Some(200));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn range_detection_pattern() {
        use crate::store::{RE_FULL, RE_RANGE};
        // A range must be captured by RE_RANGE, and RE_FULL must not fire first.
        assert!(RE_RANGE.is_match("john 3:16-18"));
        // Single-verse references still match RE_FULL.
        assert!(RE_FULL.is_match("John 3:16"));
        assert!(RE_FULL.is_match("Psalm 23:4"));
        // Bare chapter references do not match either verse regex.
        assert!(!RE_RANGE.is_match("Psalm 23"));
        assert!(!RE_FULL.is_match("Psalm 23"));
    }
}
