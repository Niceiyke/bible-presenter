# Bible Presenter RS — Critical Code Review
**Version:** 0.7.0 | **Date:** 2026-02-27 | **Branch:** main

---

## Executive Summary

Bible Presenter RS is a Tauri 2.0 desktop app (Rust backend + React/TypeScript frontend) built for real-time Bible projection with AI-powered sermon transcription. It features a multi-window model, live speech-to-text detection, multi-version Bible support, media scheduling, LAN remote control, and WebRTC camera feeds.

At 0.7.0 it is a capable, feature-rich beta product. The architecture is well-considered, the Rust code is largely sound, and recent refactors have improved the frontend structure. However, there are significant quality issues — zero test coverage, structural performance problems in hot paths, weak security on the remote interface, and a monolithic backend that is beginning to creak. This review covers all of it.

---

## Codebase Size

| File | Lines |
|------|-------|
| `src-tauri/src/main.rs` | 1,357 |
| `src-tauri/src/store/media_schedule.rs` | 1,008 |
| `src-tauri/src/store/mod.rs` | 522 |
| `src-tauri/src/audio/mod.rs` | 227 |
| `src-tauri/src/engine/mod.rs` | 93 |
| **Rust total** | **~3,207** |
| `src/App.tsx` | 516 |
| `src/components/shared/Renderers.tsx` | 703 |
| `src/windows/OutputWindow.tsx` | 401 |
| `src/components/SettingsTab.tsx` | 440 |
| **Frontend total (44 files)** | **~7,392** |

---

## THE GOOD

### 1. Multi-Window Architecture Is Correct
The single-bundle / multiple-window-label routing pattern is clean:
```tsx
if (label === "output") return <OutputWindow />;
if (label === "stage")  return <StageWindow />;
if (label === "design") return <DesignHub />;
// else: operator
```
One React bundle, four purpose-built views. No code duplication, no IPC for rendering. The windows get state via Tauri events, not prop-drilling. This is the right call.

### 2. Lazy Model Loading
Whisper (~148 MB) and ONNX (~90 MB) are loaded on first `start_session`, not at startup. This eliminates a 10–15 second blank-window on cold start. The AtomicBool `transcription_paused` enables CPU-free draining during LAN camera mode — a nice design detail.

### 3. Hybrid Verse Detection Pipeline
Three-tier detection is architecturally sound:
1. Regex (explicit references like "John 3:16") → confidence 1.0
2. ONNX cosine similarity against stacked embeddings → ~0.0–1.0
3. Keyword overlap fallback

The stacked-embedding strategy for multi-version support (KJV/AMP/NIV/ESV/NKJV/NASB) using `version_offsets`/`version_lengths` slicing is elegant. It enables single-pass search across all versions without reloading models.

### 4. Broadcast Channel for Multi-Client Sync
Using `tokio::sync::broadcast` to fan out state to the Axum WS server, all four windows, and the remote panel is the right pattern. It prevents polling and keeps all clients eventual-consistent without shared state.

### 5. Justified Unsafe Code
```rust
struct StreamHandle(cpal::Stream);
unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}
```
CPAL streams on Windows are `!Send + !Sync` (raw WASAPI handles). This is the only way to hold them behind an `Arc<Mutex<>>`. The invariant is documented, enforced by the outer Mutex, and the safety argument holds. This is correct unsafe usage, not lazy unsafe usage.

### 6. ort/ndarray Constraint Handled Correctly
The dual-ndarray problem (ort 2.0.0-rc.11 wants ndarray 0.17, ndarray-npy 0.8 needs 0.15) is documented in CLAUDE.md and solved correctly: raw tensor APIs instead of `try_extract_array()`, no `features = ["ndarray"]` on ort. The CLAUDE.md constraint note will prevent future regressions.

### 7. Auto-Updater + CI Pipeline
`tauri-plugin-updater` with GitHub Releases and a private signing key stored off-repo is a production-grade update flow. The CI pattern (tauri-action on push to main → signed release → running apps show update banner) is exactly right.

### 8. DisplayItem Enum Is Extensible
```rust
enum DisplayItem {
    Verse(Verse),
    Media(MediaItem),
    PresentationSlide(PresentationSlideData),
    CustomSlide(CustomSlideData),
    CameraFeed(CameraFeedData),
    Scene(serde_json::Value),
    Timer(TimerData),
}
```
This scales without protocol changes. Adding a new content type is one enum variant + one match arm. Serde handles serialization automatically.

### 9. Recent Frontend Modularization
The c499fb8 refactor extracted tab components, hooks (`useAppInitialization`, `useBibleCascade`, `useLanCamera`), and Zustand slices. The directory structure is now sensible with `components/`, `windows/`, `hooks/`, `store/`, `types/`, `utils/`. Direction is right.

---

## THE BAD

### 1. Zero Test Coverage
```
There are no tests in this project currently.  — CLAUDE.md
```
This is the single biggest risk. There is no safety net for:
- Regex verse detection edge cases (abbreviations, multi-language, mixed case)
- Cosine similarity threshold behavior near the 0.45 boundary
- Audio buffer management (overlap correctness)
- Media schedule CRUD (corrupted JSON, missing files)
- Tauri command input validation

At this feature density, one refactor without tests will produce silent regressions. The project has the maturity to justify a test suite now.

**Minimum viable tests needed:**
- Unit: `BibleStore::detect_verse_hybrid()` with 20+ Scripture reference formats
- Unit: `MediaScheduleStore` save/load/delete round-trips
- Unit: audio buffer overlap logic
- Integration: Tauri commands (using `tauri::test::MockBuilder`)

### 2. main.rs Is 1,357 Lines and Has 50+ Tauri Commands
`main.rs` is doing everything: AppState definition, session management, audio commands, Bible commands, media commands, LAN camera commands, service management, props, remote control, LibreOffice subprocess, file I/O, settings persistence. This is a god module.

The Tauri command count alone (50+) makes this file hard to navigate, impossible to unit test, and a merge-conflict magnet. Commands should be split into modules:

```
src-tauri/src/
  commands/
    audio.rs        // start_session, stop_session, set_vad_threshold
    bible.rs        // get_books, get_verse, search_semantic_query
    media.rs        // add_media, delete_media, get_media_library
    schedule.rs     // stage_item, go_live, clear_live, update_timer
    remote.rs       // get_remote_info, get_props, set_props
    settings.rs     // save_settings, load_settings
  main.rs           // AppState, setup(), command registration only
```

### 3. Renderers.tsx Is 703 Lines
The largest single frontend file is `components/shared/Renderers.tsx` at 703 lines. This is the rendering logic for every DisplayItem variant, lower thirds, timers, etc. It is the output window's equivalent of main.rs. It needs splitting into per-type renderer files.

### 4. Hardcoded Book Name Aliases (130 lines in store/mod.rs)
```rust
let mut map = HashMap::new();
map.insert("gen", "Genesis");
map.insert("genesis", "Genesis");
map.insert("1 samuel", "1 Samuel");
// ... 130 more lines in BibleStore::new()
```
This is data embedded as code. It runs every startup, allocates a HashMap in the constructor, and cannot be updated without recompilation. It should live in a JSON file bundled with the app, or better yet, in the Bible database itself as a `book_aliases` table. The constructor becomes one SQL query.

### 5. Keyword Fallback Stop Words Duplicated
```rust
// In search_semantic_stacked():
const STOP: &[&str] = &["the", "and", "for", "in", "is", "to", "of", ...];

// In another method further down:
const STOP: &[&str] = &["the", "and", "for", "in", "is", "to", "of", ...];
```
Identical constant defined twice. These will drift. One `const` at module level, referenced in both places.

### 6. SQL Uses LIKE for Exact Matches
```rust
"SELECT title, chapter, verse, text FROM super_bible
 WHERE title LIKE ?1 AND chapter = ?2 AND verse = ?3 AND version = ?4 LIMIT 1"
```
`LIKE` with a literal string (no wildcards) forces SQLite into a string scan instead of index lookup. With 100MB+ of verse data across 6 versions, this matters. Change to `= ?1`. Also confirm that `(title, chapter, verse, version)` has a composite index — if not, queries degrade to full table scans.

### 7. Keyboard Shortcut Handler Has 21-Item Dependency Array
```tsx
useEffect(() => {
    const handleKD = (e: KeyboardEvent) => { /* 20+ switch cases */ };
    window.addEventListener("keydown", handleKD);
    return () => window.removeEventListener("keydown", handleKD);
}, [stagedItem, goLive, liveItem, studioSlides, nextVerse, /* 16 more */]);
```
A 21-item dependency array is a code smell for one of two problems: either the effect genuinely needs all 21 values (it re-registers on every one of them changing), or some of those values should be refs to avoid re-registration. Keyboard event handlers should use `useRef` for stable callbacks and `useCallback` only for values that actually differ per keypress. This is a potential source of missed or double-firing keyboard shortcuts.

### 8. Unstable Tauri Event Listener Patterns
Multiple components call `listen("event-name", handler)` in `useEffect` without cleanup. Tauri's `listen` returns an unlisten function. Without calling it in the cleanup return, old listeners stack up across hot-reloads and re-mounts. Every `listen()` call needs:
```tsx
useEffect(() => {
    const unlisten = listen("transcription-update", handler);
    return () => { unlisten.then(f => f()); };
}, []);
```

### 9. VAD Threshold Change Requires Stream Restart
```rust
pub fn set_vad_threshold(&mut self, threshold: f32) {
    self.vad_threshold = threshold;
}
```
The threshold is read at stream-build time and stored in the closure. Changing it via the UI slider only updates the struct field — it has no effect on the running stream. The user sees the slider move but nothing changes until they stop and restart the session. This is a silent behavior bug.

---

## THE UGLY

### 1. Buffer Heap Allocation in the Hot Audio Loop
```rust
// In the transcription loop, every 1–3 seconds:
let remaining = buffer.len().saturating_sub(OVERLAP);
buffer = buffer[remaining..].to_vec();  // New Vec<f32> allocated on heap
```
At 16kHz mono f32, the buffer is ~128KB. This allocates a fresh Vec every cycle, immediately drops the old one, and pressures the allocator in a latency-sensitive audio path. The fix is a `VecDeque<f32>` with `drain(..remaining)`, or a preallocated ring buffer. The current code works but introduces GC-style pauses at the worst possible moment (mid-transcription).

### 2. AppState Is an Arc<Mutex<>> Nest
```rust
pub struct AppState {
    audio: Arc<Mutex<AudioEngine>>,
    engine: Arc<Mutex<Option<Arc<TranscriptionEngine>>>>,
    store: Arc<BibleStore>,
    media_schedule: Arc<MediaScheduleStore>,
    is_running: Arc<Mutex<bool>>,
    live_item: Arc<Mutex<Option<DisplayItem>>>,
    staged_item: Arc<Mutex<Option<DisplayItem>>>,
    settings: Arc<Mutex<PresentationSettings>>,
    lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    broadcast_tx: broadcast::Sender<String>,
    app_handle: Arc<OnceLock<AppHandle>>,
    remote_pin: Arc<Mutex<String>>,
    signaling_clients: Arc<Mutex<HashMap<String, UnboundedSender<String>>>>,
    transcription_paused: Arc<AtomicBool>,
    props_layer: Arc<Mutex<Vec<PropItem>>>,
}
```
15 fields, 12 of them Arc-wrapped, 10 of those behind Mutex. Every Tauri command that touches multiple fields must acquire multiple locks in a consistent order or risk deadlock. There is no documented lock order. As more commands are added, the risk of ABBA deadlocks grows.

A better pattern: one `Arc<Mutex<LiveState>>` for the frequently-mutated "now playing" state (live_item, staged_item, lower_third, props_layer) with an event channel to propagate changes. Read-heavy state (store, media_schedule) should be behind `RwLock` not `Mutex`.

### 3. All Tauri Commands Return `String` Errors
```rust
async fn start_session(state: State<'_, AppState>) -> Result<(), String>
async fn go_live(item: DisplayItem, state: State<'_, AppState>) -> Result<(), String>
async fn get_verse(...) -> Result<Option<Verse>, String>
```
Fifty-plus commands all collapse every possible error (IO, audio, database, model inference, JSON serialization) into an anonymous `String`. The frontend receives a string and has no structured way to:
- Distinguish recoverable from fatal errors
- Show context-appropriate recovery UI
- Log errors with machine-readable codes
- Retry specific categories

This needs a proper error enum:
```rust
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum AppError {
    AudioDevice { message: String },
    ModelNotFound { path: String },
    DatabaseError { message: String },
    IoError { message: String },
    InvalidInput { field: String, message: String },
}
```

### 4. LibreOffice Subprocess Has No Timeout
```rust
std::process::Command::new("libreoffice")
    .args(["--headless", "--convert-to", "png:impress_png_Export",
           "--outdir", &out_dir, &pptx_path])
    .output()  // blocks indefinitely
```
A malformed or very large PPTX will hang the Tauri command indefinitely. LibreOffice itself is assumed to be on PATH with no graceful fallback. If LibreOffice is not installed, the error message is whatever the OS produces for "command not found" — unformatted, not user-friendly.

**Required fixes:**
- Use `.spawn()` + `wait_timeout()` instead of `.output()`
- Set a 30-second timeout
- Check that LibreOffice exists before spawning, show a clear error if not
- Document LibreOffice as a system dependency in README

### 5. 4-Digit Remote PIN Is Too Weak
```rust
let remote_pin = generate_pin();  // 4 random digits = 10,000 possibilities
```
The LAN remote panel is protected by a 4-digit PIN with no rate limiting on the WebSocket auth handler. An attacker on the same network can try all 10,000 PINs in seconds with a simple script. The damage is bounded (they can control what slides show on screen) but in a church/conference context, a prank or disruptive attack is plausible.

**Recommended changes:**
- Use 6-digit or 8-character alphanumeric PIN
- Rate-limit WebSocket auth: 3 attempts then 60-second lockout per IP
- Log failed auth attempts
- Document the attack surface in README

### 6. Asset Protocol Scope Is Maximally Permissive
```json
"assetProtocol": {
  "enable": true,
  "scope": ["**"]
}
```
The asset protocol scope `["**"]` allows the frontend to load any file on the filesystem via `asset://` URLs. This is necessary for media preview (user-selected images/videos), but it means any XSS vulnerability in the frontend would have full read access to the user's files. The scope should be narrowed to the app data directory and user-selected media locations.

---

## LIMITATIONS

### Platform
- Bundled as NSIS (Windows installer) only. No macOS `.dmg` or Linux `.AppImage` targets configured. A church in a macOS environment cannot use this without a custom build.
- No CI build matrix for macOS/Linux (only `ubuntu-latest` in CI).

### AI Model Requirements
- The app **crashes at startup** without `bible.db`/`super_bible.db`. This is a hard stop with no graceful degradation (e.g., manual-only mode without AI features).
- Whisper base model gives acceptable accuracy for clear speech but will struggle with heavy accents, multiple simultaneous speakers, or poor microphone placement.
- The ONNX sentence-transformer model and cosine threshold (0.45) are fixed. There is no way for users to adjust detection sensitivity beyond the VAD threshold.
- Models ship outside the app bundle (too large for NSIS), requiring a separate download step not mentioned in any UI.

### Audio
- Single audio input only. Many worship settings use split audio (pastor mic + ambient). Mixing multiple inputs is not supported.
- VAD is energy-based only. Background music, HVAC noise, or congregation singing will trigger false positives.

### Presentation
- Custom Presentation Studio supports text-based slides only (no shapes, images inline, or real-time collaboration).
- PPTX rendering falls back to LibreOffice PNG conversion (no native renderer), so animation, transitions, and embedded fonts are lost.
- No PDF import.

### Synchronization
- The broadcast channel is fire-and-forget. If the output window misses an event (e.g., it opens after `go_live` is called), it may show stale content. `toggle_output_window` re-emits the current live item as a workaround, but this is fragile — the Stage and Design windows have no equivalent.

### Scalability
- The `verse_cache: Vec<Verse>` loads all verses for all 6 Bible versions into RAM at startup (~100MB database → significant in-memory footprint). On low-RAM systems this will be felt.
- Embeddings (`all_versions_embeddings.npy`, ~48MB) are fully loaded into an `Array2<f32>`. This works, but the entire array is scanned for every transcription cycle. There is no approximate nearest-neighbor index (FAISS, HNSW) for faster search.

---

## AREAS OF IMPROVEMENT

### Priority 1 — Correctness & Safety
1. **Add unit tests for BibleStore** — regex patterns, semantic search, keyword fallback, multi-version switching
2. **Add unit tests for MediaScheduleStore** — CRUD round-trips for services, songs, props, schedule entries
3. **Fix VAD threshold to apply live** — pass threshold through the audio channel instead of rebuilding the stream
4. **Fix SQL LIKE → = for book lookups** — add composite index on `(title, chapter, verse, version)`
5. **Add LibreOffice timeout** — 30 seconds max; clear error if not installed
6. **Upgrade remote PIN** — 6+ digits or alphanumeric; add auth rate-limiting

### Priority 2 — Architecture
7. **Split main.rs into command modules** — 1,357 lines with 50+ commands is unmaintainable
8. **Replace buffer Vec re-allocation with VecDeque** — drain instead of slice+to_vec in audio loop
9. **Introduce structured AppError enum** — replace all `Result<T, String>` in Tauri commands
10. **Replace some Mutex with RwLock** — `BibleStore`, `MediaScheduleStore`, settings are read-mostly
11. **Split Renderers.tsx (703 lines)** — one file per DisplayItem variant

### Priority 3 — Code Quality
12. **Extract book aliases to JSON or DB** — remove 130-line HashMap from constructor
13. **Deduplicate STOP word constant** — one module-level const, used by both callers
14. **Fix Tauri event listener cleanup** — every `listen()` needs unlisten in effect cleanup
15. **Refactor keyboard shortcut handler** — use refs to avoid 21-item dependency array
16. **Audit Tokio feature flags** — `features = ["full"]` compiles everything; trim to `rt-multi-thread, macros, sync, time`
17. **Add database indexes** — `CREATE INDEX IF NOT EXISTS` on startup for common query patterns

### Priority 4 — Platform & Distribution
18. **Add macOS and Linux build targets** — configure `tauri.conf.json` bundle targets for `.dmg` and `.AppImage`
19. **Add Linux GTK dependencies to CI** — already noted in MEMORY.md but not in CI config
20. **Narrow asset protocol scope** — restrict to `app_data_dir` and explicitly selected media directories
21. **Add model download UI** — the user needs a guided setup flow when models are missing, not a crash

---

## FEATURES TO HAVE

### High Impact / Feasible
- **AI Model Downloader** — in-app progress dialog to download Whisper/ONNX models on first run instead of crashing
- **Confidence Threshold Settings** — expose cosine similarity (currently 0.45) and keyword overlap (currently 3) as user-adjustable settings in the UI
- **Multi-Audio Input Mixing** — combine pastor mic + lavalier + ambient into one transcription feed with per-source gain
- **Setlist Auto-Advance** — option to automatically move to the next scheduled item when a verse matches for N seconds without change
- **Song Chord Charts** — store chord annotations alongside lyrics; display in stage window for musicians
- **Teleprompter Mode** — continuous scrolling text in stage window (for scripture reading or sermon notes)
- **Slide Background Per-Item Override** — allow individual schedule items to override the global background setting
- **Rich Text Editor for Custom Slides** — basic bold/italic/color formatting without needing the full Design Hub
- **PDF Import** — render PDF pages as presentation slides (same LibreOffice path already works for pptx)

### Medium Impact / Requires Design
- **Multi-Operator Mode** — two users controlling different aspects simultaneously (one on songs, one on Bible) via the LAN remote
- **Scripture Reference Search by Keyword** — "find all verses about peace" using the existing semantic search, surfaced as a Bible tab feature
- **Verse Highlight Mode** — show a full passage with one verse highlighted, advancing on next trigger (for reading Scripture out loud)
- **Service Template System** — predefined service order templates (e.g., "Sunday Morning: Worship → Scripture → Sermon → Offering") that pre-populate the setlist
- **History / Undo** — track live item history so operator can go back to a previous slide without re-finding it
- **OBS Virtual Camera Integration** — output window renders to a virtual camera device for streaming software

### Low Impact / Nice to Have
- **Dark/Light theme toggle** — currently forced dark
- **Shortcut customization UI** — edit key bindings in Settings instead of hardcoded switch statements
- **Per-version font preferences** — some Bible versions use different character sets (e.g., Greek/Hebrew)
- **Export Service as PDF** — generate a printable order of service with all schedule items
- **macOS Companion App** — lightweight iOS/macOS app for remote control (beyond the LAN web panel)

---

## Code Health Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | 7/10 | Good multi-window + broadcast design; main.rs is a god module |
| Rust Code Quality | 6/10 | Mostly idiomatic; buffer alloc in hot loop; nested Mutex excess |
| TypeScript Quality | 7/10 | Strict mode; well-typed; keyboard effect over-subscribed |
| Frontend Structure | 7/10 | Good modularization progress; Renderers.tsx still too large |
| Test Coverage | 1/10 | Zero tests; highest risk item in the project |
| Error Handling | 3/10 | String errors throughout; no structure; no recovery paths |
| Security | 5/10 | Weak PIN; broad asset scope; no input validation on file paths |
| Performance | 6/10 | Hot-path alloc; LIKE queries; no ANN index for embeddings |
| Documentation | 8/10 | CLAUDE.md is excellent; inline comments sparse in Rust |
| Deployment | 6/10 | Windows-only bundle; no guided model setup; crash on missing DB |

**Overall: 6.1/10 — Solid beta. Not production-ready without test coverage and error handling.**

---

## Summary

The project has earned its feature set through genuine engineering work. The multi-version Bible search with stacked embeddings is genuinely clever. The lazy-load AI pipeline, broadcast state sync, and ProPresenter-style multi-window layout are all well-executed.

What holds it back from production quality is the complete absence of tests, the collapse of all errors into strings, a 1,357-line god module, and a handful of correctness bugs (VAD threshold, buffer allocation, stale listeners). None of these are hard to fix — they just have not been done yet.

The next milestone should be: split main.rs, add BibleStore unit tests, introduce structured errors, fix the hot-loop allocation, and set up a macOS build target. That work would take this from a polished beta to a deployable product.
