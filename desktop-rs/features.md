# Bible Presenter Pro — Missing Features & Product Roadmap

## Methodology

This analysis was conducted by reading the full source of the Tauri 2.0 desktop application: the Rust backend (`main.rs`, `audio/mod.rs`, `engine/mod.rs`, `store/mod.rs`), the React frontend (`src/App.tsx`), the configuration (`tauri.conf.json`, `package.json`), and the architecture documentation (`CLAUDE.md`). Each identified gap was then evaluated against what church AV operators, worship leaders, and tech directors actually need in a live service environment — and measured against the feature sets of competing products: ProPresenter 7, EasyWorship 7, OpenLP 3, and Proclaim.

The core technology is genuinely strong: a hybrid detection pipeline (Whisper + ONNX semantic embeddings + regex) running entirely on-device, a two-window Tauri model (operator vs. output), and a manual override path via book/chapter/verse picker and keyword search. However, the product is currently a functional prototype, not a commercial tool. What follows is a prioritized roadmap organized into three tiers.

---

## P1 — Must Have (Commercial Launch)

These features are table-stakes for any church that would consider paying money for this product. Without them, the product cannot survive a single Sunday morning in a real church.

---

### 1.1 Screen Blank / Clear Output

**What is missing:** There is no way to clear the output window to black (or a blank slide) during a live service. The `toggle_output_window` command in `main.rs` only hides or shows the entire Tauri window — it does not send a "blank" state to the projection display.

**Why it matters:** This is arguably the single most-used button in any church presentation software. When a speaker finishes a scripture reading, the AV operator must clear the screen immediately or it distracts the congregation. ProPresenter puts this on the `Escape` key and the `B` key. EasyWorship has a dedicated "Logo" and "Black" button in the toolbar. The absence of this feature alone would disqualify the product from live use.

**Implementation notes:** Add a `clear_output` boolean to the frontend state. The output window's render path in `App.tsx` (the `label === "output"` branch) should render a fully black `<div>` when this flag is set. A `clear_output` Tauri command (or a client-side Zustand store update broadcast via `app.emit`) can toggle it. The keyboard shortcut should be a global hotkey registered via `tauri-plugin-global-shortcut`, mapped to `Escape` or `B`.

---

### 1.2 Global Keyboard Shortcuts

**What is missing:** The operator window has no keyboard shortcuts. Every action — displaying a verse, clearing the screen, starting/stopping the session — requires a mouse click. The packages `framer-motion`, `lucide-react`, and `zustand` are installed in `package.json` but not used. Keyboard support infrastructure is completely absent.

**Why it matters:** During a live service, the AV operator cannot take their eyes off the speaker to navigate a UI. Speed and muscle memory are essential. ProPresenter operators navigate entirely by keyboard. The absence of shortcuts is a professional blocker.

**Implementation notes:** Register global shortcuts via `tauri-plugin-global-shortcut`. Recommended shortcut map for v1:
- `Escape` / `B` — blank/clear output
- `Space` — confirm/push currently-previewed verse to output
- `Cmd/Ctrl+F` — focus search input
- `Cmd/Ctrl+L` — start/stop live session
- `Arrow Up/Down` — navigate search results or history list
- `Enter` — select highlighted verse

---

### 1.3 Confidence Score Display and Manual Override / Reject

**What is missing:** The `transcription-update` event payload in `main.rs` returns `{ text, detected_verse }`. The `search_semantic_mem` function in `store/mod.rs` computes a `max_score` (cosine similarity, threshold 0.45) but **discards it** — the score is never surfaced to the frontend. The operator has no idea whether the AI is 90% confident or just barely past threshold. More critically, there is no way to reject a false positive before it hits the screen.

**Why it matters:** Semantic search will produce false positives. A speaker saying "I have a song in my heart" should not trigger Song of Solomon 1:1. When this happens in front of a congregation, it is embarrassing and erodes trust in the product. The operator needs to see a confidence score and approve or reject the detected verse before it is shown. This is a **preview-before-send** workflow.

**Implementation notes:**
- In `store/mod.rs`, modify `search_semantic_mem` to return `Option<(Verse, f32)>` — the verse and its cosine similarity score.
- Modify `detect_verse_hybrid` to propagate the score.
- Extend the `TranscriptionUpdate` struct in `main.rs` with `confidence: Option<f32>`.
- In `App.tsx`, render a "staged" verse panel in the operator window. The AI detection places a candidate verse in a "pending" state with the confidence score displayed as a percentage badge.
- The operator presses `Space` (or clicks a "Send" button) to push it to output, or `Delete`/`X` to reject it and keep the screen unchanged.
- Auto-send can be a configurable setting for operators who trust the AI: only auto-display verses with confidence >= a user-set threshold (e.g. 80%).

---

### 1.4 Multiple Bible Translations

**What is missing:** The SQLite database schema in `store/mod.rs` is `verses(id, book, chapter, verse, text)` — there is no `translation` column. Only one translation is loaded. The `tauri.conf.json` bundles a single `bible.db` file.

**Why it matters:** Churches are deeply divided on translation preference. KJV churches will not use a product that shows NIV text. Many evangelical churches use ESV or NKJV. A church tech director evaluating this product will ask "which translation?" as their first question. If the answer is "only one, fixed at install time," the evaluation ends there.

**Implementation notes:**
- Add a `translation` column to the SQLite schema: `verses(id, translation TEXT, book, chapter, verse, text)`.
- Bundle at least KJV (public domain), and provide a download/import path for NIV, ESV, NKJV (licensing required).
- Add a `translation: String` field to the `Verse` struct in `store/mod.rs`.
- Add a `get_translations() -> Vec<String>` Tauri command and a translation selector in the operator UI header.
- The current `get_verse`, `search_manual`, and `detect_verse_hybrid` queries all need a `translation` parameter.
- Store the user's preferred translation in settings persistence (see feature 1.10).

---

### 1.5 Verse Range Display (Multi-verse Passages)

**What is missing:** The regex in `store/mod.rs` only captures a single verse reference: `([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)`. It cannot match ranges like "John 3:16-17" or "Psalm 23:1-6". The `get_verse` command retrieves a single `Verse` struct. There is no `get_verse_range` command in `main.rs`.

**Why it matters:** Preachers commonly read multiple verses in sequence. "Turn with me to Romans 8:28-30" is a standard pastoral phrase. Displaying only verse 28 while the pastor reads through verse 30 leaves the congregation without context. This is a basic usability gap.

**Implementation notes:**
- Extend the regex in `store/mod.rs` to capture optional end verse: `([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)(?:\s*[-–]\s*(\d+))?`
- Add a `get_verse_range(book, chapter, start_verse, end_verse) -> Vec<Verse>` command in `main.rs`.
- The output window in `App.tsx` should support multi-verse display: either paginate through verses with arrow keys, or display all verses stacked (scroll mode for longer passages).
- Auto-pagination: if a range contains more than 2-3 verses, split across multiple "slides" the operator can advance through manually.

---

### 1.6 Confidence Monitor (Operator Preview of Output)

**What is missing:** The operator window's "Current Projection" section (bottom half of `main` in `App.tsx`) shows what the AI detected, but it is not a real preview of the output window's visual appearance. The operator sees plain text styled differently from the actual projection. There is no way to know exactly how the text will look on screen.

**Why it matters:** Font size wrapping, text overflow, and long verse texts can produce ugly output. The operator needs to see a pixel-accurate thumbnail of what the audience sees. This is standard in ProPresenter (Stage Display + Preview) and EasyWorship.

**Implementation notes:**
- In `tauri.conf.json`, the output window is `transparent: true` and `1920x1080`. Add a `@tauri-apps/plugin-screenshot` or render the output window's state in a scaled-down preview `<div>` inside the operator window.
- The simplest approach: render a `transform: scale(0.2)` CSS-transformed clone of the output window's JSX inside the "Current Projection" section of `App.tsx`. Since both windows share the same React app and subscribe to the same `transcription-update` event, a shared Zustand store can keep them in sync without an IPC round-trip.

---

### 1.7 Settings Persistence Across Restarts

**What is missing:** All UI state is `useState` local to `App.tsx`. The selected audio device (`selectedDevice`), VAD threshold (`vadThreshold`), and any future settings (translation preference, display theme) are lost on every restart. There is no persistence layer.

**Why it matters:** A church AV operator sets up the system once and expects it to be ready to go every Sunday. Re-selecting the audio device and re-tuning VAD sensitivity every session is unprofessional and error-prone. `tauri-plugin-store` is not listed in `package.json` or `Cargo.toml`.

**Implementation notes:**
- Add `tauri-plugin-store` (a first-party Tauri v2 plugin) for a simple JSON key-value store.
- Persist: `audio_device`, `vad_threshold`, `translation`, `display_theme`, `font_size`, `output_window_monitor`.
- Load persisted settings in the `useEffect` initialization block in `App.tsx`.
- On the Rust side, a `get_settings / set_settings` Tauri command backed by `tauri-plugin-store` or a simple `serde_json` file in `app.path().app_config_dir()`.

---

### 1.8 Stop Session / Session State Indicator

**What is missing:** There is a "START LIVE" button in `App.tsx` that calls `invoke("start_session")`. There is no stop button. Calling `start_session` again while a session is running would spawn a second Tokio task and a second CPAL stream, causing duplicate events or a device conflict. The `AppState` has no `is_running: bool` flag. The audio engine's `stop()` method exists in `audio/mod.rs` but is never called from the frontend.

**Why it matters:** The operator needs to be able to stop and restart the session (e.g., when switching to a different segment of the service, or when reconfiguring the audio device). The current architecture makes re-starting broken.

**Implementation notes:**
- Add `is_running: Arc<Mutex<bool>>` to `AppState` in `main.rs`.
- Add a `stop_session` Tauri command that calls `audio.lock().stop()` and sets `is_running` to false, and cancels the Tokio task (use a `CancellationToken` from `tokio-util`).
- `start_session` should check `is_running` and return an error if already running.
- In `App.tsx`, track session state with a `useState<"idle" | "running">` and toggle the button between "START LIVE" (green) and "STOP" (red).

---

### 1.9 Detection History / Undo

**What is missing:** Once `setActiveVerse` updates in `App.tsx`, the previous verse is gone. There is no history of what was displayed. The `transcription-update` event overwrites the state entirely. There is no undo operation.

**Why it matters:** A false positive will push an incorrect verse to the screen. The operator needs to immediately revert to the previous verse (or clear the screen). Without undo, recovery requires manually searching for the correct verse, which takes 10-15 seconds while the congregation watches.

**Implementation notes:**
- Replace `const [activeVerse, setActiveVerse] = useState<any>(null)` with a `verseHistory: Verse[]` array in the Zustand store (the `zustand` package is already installed).
- Maintain a `historyIndex: number` cursor.
- `Cmd/Ctrl+Z` moves the cursor back one, re-displaying the previous verse.
- The history panel (see feature 2.1) renders this list.
- The history should persist for the session duration (in-memory is sufficient, no DB write needed).

---

### 1.10 Audio Level Meter

**What is missing:** The `build_stream` method in `audio/mod.rs` computes RMS energy: `let energy = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;`. This value is computed but is only compared against `vad_threshold` — it is never emitted to the frontend. The operator has no visual feedback about the audio input level.

**Why it matters:** The number one support question for any audio-dependent software is "why isn't it detecting anything?" The answer is almost always that the microphone input level is too low. Without a meter, the operator has no diagnostic tool. The VAD threshold slider exists but is meaningless without seeing the actual signal level relative to the threshold.

**Implementation notes:**
- In `audio/mod.rs`, emit an `audio-level` event alongside the sample data: `let _ = app.emit("audio-level", energy)` — this requires passing the `AppHandle` into the stream closure.
- In `App.tsx`, listen for `audio-level` events and render a simple CSS-bar meter in the header, next to the sensitivity slider.
- Overlay the VAD threshold as a horizontal line on the meter so the operator can see when signal exceeds the gate.

---

### 1.11 Display Theme System (Font, Color, Background)

**What is missing:** The output window in `App.tsx` is hardcoded: `bg-black`, `text-white`, `text-7xl font-serif`, amber reference text. There are no theme options, no font size control, no background color or image, and no way to match a church's branding.

**Why it matters:** Churches have distinct visual identities. Some use dark backgrounds, some use white (for projection in bright rooms), some want a specific font that matches their printed bulletins. ProPresenter and EasyWorship themes are a primary selling point. A one-size-fits-all design will look wrong in most churches.

**Implementation notes:**
- Define a `DisplayTheme` struct (JSON-serializable) with fields: `background_color: String`, `background_image: Option<String>`, `verse_text_color: String`, `verse_font_family: String`, `verse_font_size_px: u32`, `reference_text_color: String`, `reference_font_size_px: u32`.
- Store the active theme in the Zustand store and persist via `tauri-plugin-store`.
- Apply theme values as inline styles on the output window's root `<div>` in `App.tsx`.
- Ship 4-6 built-in presets: Dark Classic (current), Light/White, Dark Blue, Dark with blur, Minimal Transparent (lower-third).
- A simple theme editor in the Settings panel of the operator window.

---

### 1.12 Verse Not Found / AI Unavailable Feedback

**What is missing:** When the AI engine fails to load (the `engine: None` branch in `main.rs`), the only indication is a log file entry. The operator window shows no warning. When `start_session` is called with a missing engine, it returns the error string "AI Models not loaded..." but the frontend's `invoke("start_session")` call in `App.tsx` has no `.catch()` handler — the error is silently swallowed.

**Why it matters:** Silent failures during a live service are catastrophic. An operator who clicks "START LIVE" and gets no feedback will not know whether the system is working until a verse fails to appear during the sermon.

**Implementation notes:**
- In `App.tsx`, add `.catch((err) => setError(err))` to all `invoke()` calls.
- Display a persistent error banner at the top of the operator window for AI engine failures.
- Add a status indicator in the header: colored dot — green (running), yellow (no AI engine, manual-only mode), red (no database, fatal error).
- In `main.rs`, add a `get_status` Tauri command returning `{ engine_loaded: bool, database_loaded: bool, is_running: bool }`.

---

## P2 — Should Have (v1.1)

These features significantly increase the product's value and differentiation but are not blockers for a cautious initial launch with early adopter churches.

---

### 2.1 Verse History Panel with Timestamps

**What is missing:** There is no persistent log of what was displayed during a service. The `transcript` state in `App.tsx` shows only the most recent transcription text, not a scrollable history.

**Why it matters:** After a service, the pastor or AV coordinator often wants a record of which scriptures were displayed and when. This is also essential for the re-display use case — tapping a verse in history re-sends it to the output screen immediately.

**Implementation notes:**
- Maintain a `displayHistory: Array<{ verse: Verse, timestamp: Date, confidence?: number, source: "auto" | "manual" }>` in the Zustand store.
- Render a scrollable history list in a new panel in the operator window (right sidebar or collapsible drawer).
- Each history item shows: reference, timestamp, source badge (AUTO/MANUAL), confidence percentage.
- Clicking any history item re-invokes `select_verse` to re-display it.
- Export to CSV/TXT (see feature 2.6).

---

### 2.2 Setlist / Service Order (Cue List)

**What is missing:** There is no concept of a "service" or a pre-planned sequence of content. The operator works entirely reactively — waiting for AI detection or manually searching. There is no ability to pre-load the scriptures for today's sermon.

**Why it matters:** Most churches follow a predictable service order: opening verse, songs, sermon verses (usually 5-15 specific passages), closing verse. A worship leader or pastor provides the sermon scriptures in advance. The ability to pre-load these into an ordered queue — and step through them with arrow keys — dramatically reduces cognitive load during the service.

**Implementation notes:**
- A `Setlist` is an ordered `Vec<SetlistItem>` where each item is one of: `BibleVerse(Verse)`, `VerseRange(Vec<Verse>)`, or `SongLyrics(Song)` (future).
- New panel in the operator window: "Today's Service" with drag-to-reorder items.
- `Arrow Down` / `Arrow Up` navigates the setlist; `Space` or `Enter` pushes the selected item to output.
- Save/load setlists as JSON files via `tauri-plugin-dialog` (file picker) + `tauri-plugin-fs`.
- A default setlist is auto-saved as the "current service" and restored on restart.

---

### 2.3 Lower-Third / Overlay Mode

**What is missing:** The output window is hardcoded as full-screen black background. The output Tauri window in `tauri.conf.json` is `transparent: true` — this capability already exists in the configuration but is not used. There is no lower-third rendering mode.

**Why it matters:** Many modern churches use video-integrated workflows where the sermon is also livestreamed or projected with a camera feed of the speaker. In these environments, a full black-background slide is inappropriate — a lower-third overlay (transparent background, text at the bottom 20% of screen) is the correct display mode. This is also required for IMAG (Image Magnification) setups common in larger churches.

**Implementation notes:**
- Add a `display_mode: "fullscreen" | "lower_third"` field to the `DisplayTheme` config.
- In lower-third mode, the output window's root `<div>` uses `bg-transparent` and positions text at `absolute bottom-0 left-0 right-0` with a semi-transparent gradient backing.
- The window already has `transparent: true` in `tauri.conf.json`. In lower-third mode, disable `fullscreen` and position the window at the bottom portion of the secondary monitor.
- This enables the app to work alongside OBS or vMix in streaming workflows.

---

### 2.4 Song Lyrics Display

**What is missing:** The app is called "Bible Presenter Pro" but can only display Bible verses. Worship services consist of 40-60% congregational singing. The output window has no concept of songs or lyrics. Competing products (OpenLP, EasyWorship, ProPresenter) treat songs as a first-class content type.

**Why it matters:** If the AV operator must use a separate product for lyrics (e.g., OpenLP) and this product for Bible verses, the value proposition collapses. Integrated lyrics support means one product handles the entire service.

**Implementation notes:**
- Add a `songs` SQLite table: `songs(id, title TEXT, artist TEXT, ccli_number TEXT)` and `song_slides(id, song_id INTEGER, slide_order INTEGER, content TEXT)`.
- A new "Songs" panel in the operator window sidebar with search and setlist-add capability.
- The output window renders song slides with the same theme system as Bible verses.
- Import from OpenLyrics XML format (the standard used by OpenLP and many CCLI worship databases) to bootstrap content.
- CCLI license number field in settings (required for legal compliance in US/UK churches).

---

### 2.5 Custom Phrase-to-Verse Mapping

**What is missing:** The `BibleStore` has no concept of user-defined aliases. The book name map in `store/mod.rs` is hardcoded. There is no mechanism for a user to say "when you hear 'the love chapter', show 1 Corinthians 13:1".

**Why it matters:** Pastors have verbal habits. They may refer to Psalm 91 as "my protection psalm," or always call John 11:35 "the shortest verse." Teaching the app these custom mappings dramatically improves detection accuracy for a specific church's regular preacher. This is a differentiating feature no competitor currently offers.

**Implementation notes:**
- Add a `custom_mappings` table to the SQLite DB: `(id, phrase TEXT UNIQUE, book TEXT, chapter INTEGER, verse_start INTEGER, verse_end INTEGER)`.
- A "Custom Phrases" settings page in the operator window with add/edit/delete CRUD.
- In `store/mod.rs`, `detect_verse_hybrid` checks custom mappings first (before regex), performing a case-insensitive substring match on the transcribed text.
- This effectively teaches Whisper-detected speech patterns that no regex could catch.

---

### 2.6 Export Session Transcript and Verse Log

**What is missing:** There is no export functionality. When the service ends, nothing is saved. The `transcript` state in `App.tsx` only holds the most recent transcription window (2 seconds of audio, 32000 samples per `window_size` in `main.rs`).

**Why it matters:** Pastors often want to share the scripture references from a service with congregants via email or bulletin. AV teams want to review what was displayed to improve future services. Legal/compliance departments of larger churches may require records of CCLI-licensed content displayed.

**Implementation notes:**
- Use the verse history store (feature 2.1) as the data source.
- Add an "Export" button in the operator window header.
- Export formats: plain text (reference list), CSV (timestamp, book, chapter, verse, text, confidence, source), Markdown (formatted for easy sharing).
- Use `tauri-plugin-dialog` for save-file dialog and `tauri-plugin-fs` for writing.

---

### 2.7 Multiple Monitor Target Selection

**What is missing:** `toggle_output_window` in `main.rs` picks "the first non-primary monitor" automatically. In a church with three monitors (operator laptop, confidence monitor, main projection), this heuristic may pick the wrong display. There is no UI to select which physical monitor receives the output window.

**Why it matters:** Churches routinely have complex display setups: a projection screen, a stage confidence monitor, and a livestream encoder all driven from one workstation. Sending the verse to the confidence monitor instead of the projector is a live-service disaster.

**Implementation notes:**
- Add a `get_monitors` Tauri command returning a list of `{ name, width, height, position_x, position_y }` for all available monitors.
- In the Settings panel, render a visual diagram of the detected monitors (labeled rectangles) and let the operator click the target.
- Persist the chosen monitor's name/position in settings.
- Modify `toggle_output_window` to use the persisted monitor choice.

---

### 2.8 Onboarding / Setup Wizard

**What is missing:** The app will "crash at startup" without `bible.db` (per `CLAUDE.md`). The models (`whisper-base.bin`, `all-minilm-l6-v2.onnx`) are not bundled and must be placed manually in the resources directory. There is no setup wizard, no first-run experience, and no documentation visible in-app.

**Why it matters:** The target users are church volunteers, not developers. They will not know what a `.bin` file or a `.npy` file is. A "crash at startup" is the end of the evaluation. This is the highest friction point between the current state and commercial viability.

**Implementation notes:**
- Bundle the Bible database (`bible.db`) and embeddings (`embeddings.npy`) with the installer — these are essential and not large enough to exclude (the DB is tens of MB).
- Add a first-run detection: on startup, check for the AI model files. If missing, show an in-app setup screen (not a crash) that offers to download them from a CDN with a progress bar.
- Use `tauri-plugin-http` + `tauri-plugin-fs` for model downloading.
- A step-by-step wizard: (1) welcome screen, (2) model download, (3) audio device selection with a "Test Microphone" feature, (4) translation selection, (5) display theme selection.
- A "Demo Mode" that works without models (manual-only, no AI detection) so users can evaluate the UI before downloading 240 MB of model files.

---

### 2.9 Side-by-Side Translation Comparison

**What is missing:** Only one translation can be displayed at a time (once multi-translation support from P1.4 is implemented). There is no comparison view.

**Why it matters:** Many expository preachers read a verse from one translation and then compare it to another on screen to illuminate word choices. This is particularly common with KJV vs. ESV comparisons. ProPresenter and EasyWorship both support parallel translation display.

**Implementation notes:**
- Requires P1.4 (multiple translations) as a prerequisite.
- Add a `comparison_translation: Option<String>` to the display state.
- The output window renders two text columns side-by-side (or stacked) when comparison mode is active.
- In the operator window, a "Compare with..." dropdown next to the active translation selector.

---

### 2.10 Noise Cancellation / Audio Preprocessing

**What is missing:** The `build_stream` in `audio/mod.rs` feeds raw resampled audio directly to Whisper. There is no bandpass filtering, no noise gate beyond the simple RMS VAD, and no echo/reverb suppression. Church environments are acoustically challenging: HVAC noise, congregation sound, reverb, PA system feedback.

**Why it matters:** Whisper's recognition accuracy degrades significantly in noisy environments. The quality of detection is only as good as the audio quality. A noisy environment will produce constant false positives from the semantic search (threshold 0.45 is already quite permissive in `store/mod.rs`).

**Implementation notes:**
- Apply a bandpass filter (300 Hz - 3400 Hz, the human speech frequency range) to the resampled mono signal before passing to Whisper. This eliminates HVAC rumble and HF hiss.
- Implement a simple spectral subtraction noise floor estimator: compute a noise profile from the first 2 seconds of audio before the VAD gate opens, then subtract it from subsequent frames.
- Consider integrating `webrtc-audio-processing` (a Rust crate wrapping the libwebrtc APM) for production-quality AEC/ANR.
- Expose a "Noise Reduction" toggle in the operator Settings panel.

---

### 2.11 Auto-Update Mechanism

**What is missing:** There is no update mechanism. `tauri.conf.json` does not configure `tauri-plugin-updater`. Churches will run v0.1.0 forever until manually re-installed.

**Why it matters:** Bible database updates (new translations), AI model improvements, and bug fixes need to reach deployed machines. Churches are notoriously slow to manually update software. An auto-update (or at minimum, an update notification) is the only way to maintain a deployed installed base.

**Implementation notes:**
- Add `tauri-plugin-updater` to `Cargo.toml` and configure the `updater` section in `tauri.conf.json` with a `pubkey` and `endpoints` URL pointing to a GitHub Releases JSON endpoint.
- On startup, call `check_update()` and show a non-intrusive notification banner if an update is available.
- Consider a separate content-update channel for the Bible database (SQLite replacement) vs. application binary updates.

---

### 2.12 Crash Reporting

**What is missing:** The only error logging is the custom `log_msg` function in `main.rs` writing to `app.log`. There is no structured error reporting. Panics in the Rust backend produce no user-facing information. The frontend's `invoke()` error handling is largely absent (no `.catch()` handlers).

**Why it matters:** Without crash reports from deployed instances, it is impossible to know what is failing in the field. Church environments have wildly varied hardware configurations (Windows 7 machines, unusual audio hardware, multiple GPU configurations for the output window). Silent failures will produce support tickets that are impossible to diagnose.

**Implementation notes:**
- Add `.catch()` handlers to every `invoke()` call in `App.tsx`, logging errors to a visible error state.
- Integrate `sentry` (Rust SDK `sentry` crate + JS `@sentry/browser`) for structured error capture with opt-in consent during onboarding.
- Alternatively, use a self-hosted error aggregation endpoint (simpler for a small product) that receives a `POST` with the `app.log` contents on crash.
- Add a `std::panic::set_hook` in `main.rs` to catch Rust panics and log them before the process exits.

---

## P3 — Nice to Have (Future Versions)

These features increase market reach, differentiation, and power-user satisfaction but are not required for initial commercial success.

---

### 3.1 Language Support Beyond English

**What is missing:** In `engine/mod.rs`, `params.set_language(Some("en"))` is hardcoded. Whisper supports 99 languages. The book name map in `store/mod.rs` is entirely English. The regex patterns assume English book names.

**Why it matters:** Non-English speaking churches represent a significant global market. Spanish, Portuguese, French, Korean, and Mandarin Christian communities are large and underserved by US-centric presentation software.

**Implementation notes:**
- Add a `language: String` field to settings (default `"en"`).
- Pass the language code to `params.set_language()` in `engine/mod.rs`.
- Non-English book name maps can be loaded from locale-specific JSON files.
- The semantic embedding model (all-MiniLM-L6-v2) is multilingual and should handle cross-lingual similarity reasonably well.
- Requires localized Bible databases (available from various open-source projects).

---

### 3.2 Bible Passage Navigation and Reading Plans

**What is missing:** The operator window has book/chapter/verse selectors but no passage-level navigation (e.g., display an entire chapter sequentially, advance verse by verse). There are no reading plans, liturgical calendar integrations, or "next verse" navigation.

**Why it matters:** Liturgical churches (Catholic, Anglican, Lutheran, Methodist) follow a lectionary — a prescribed set of passages for each Sunday. A lectionary-aware display mode would be an immediate selling point for these denominations.

**Implementation notes:**
- Add a "Chapter Mode": select a chapter and navigate verse by verse with `Arrow Right`/`Arrow Left`.
- Add a lectionary database (RCL - Revised Common Lectionary is open data) to the SQLite DB.
- A "Today's Lectionary" quick-access button that pre-loads the day's assigned passages into the setlist.

---

### 3.3 Remote Control / Stage Display via Mobile

**What is missing:** There is no network interface. The app only serves the local machine.

**Why it matters:** Many worship leaders want to see on their phone or tablet what is currently projected (confidence monitor use case). Some larger churches have multiple operators who need to see the current state or submit verse requests from different locations in the building.

**Implementation notes:**
- Add a `tauri-plugin-http` server embedded in the Rust backend serving a minimal WebSocket endpoint.
- A companion web app (React, deployable as a static page) that connects to the local WebSocket and displays the current verse.
- A simple "request verse" form on the mobile app that sends a suggested verse to the operator's queue (not directly to output — operator approves first).
- This also enables a "Pastor's App" use case: the pastor loads their sermon verses on their phone, and the app automatically displays each one as the pastor taps it.

---

### 3.4 Presentation Recording and Replay

**What is missing:** There is no recording of what was displayed, beyond the verse history log.

**Why it matters:** Churches that record services for YouTube/podcast need timestamps of what scripture was displayed to add chapter markers or overlays in post-production. Some churches replay a previous service recording on a screen in overflow rooms — syncing verse display to the recording requires timestamps.

**Implementation notes:**
- When a verse is pushed to the output window, record `{ timestamp_ms: u64, verse: Verse, event_type: "display" | "clear" }` to a session log file.
- Export as a subtitle/caption file (SRT or VTT format) — each displayed verse becomes a timed subtitle.
- This integrates directly with YouTube's auto-chapter feature when uploaded.

---

### 3.5 Side-by-side Original Language

**What is missing:** No Hebrew (OT) or Greek (NT) text support.

**Why it matters:** Seminary-trained pastors and Bible teachers frequently refer to the original Hebrew or Greek. Displaying the Greek text of a New Testament verse alongside the English translation is a premium feature that targets the academic/seminary church market.

**Implementation notes:**
- Add Greek NT (Textus Receptus or NA28 — check licensing) and Hebrew OT (Westminster Leningrad Codex — open license) to the SQLite database.
- A "Show Original Language" toggle in display settings, rendering the original language above or below the translation in a smaller font.
- Requires right-to-left (RTL) text rendering support for Hebrew — CSS `direction: rtl` on the Hebrew text element.

---

### 3.6 Performance / Usage Analytics (Privacy-Preserving)

**What is missing:** There is no telemetry. The developer has no idea which features are used, which translations are most popular, how often the AI correctly detects vs. the operator manually overrides, or what audio devices are common.

**Why it matters:** Product decisions without data are guesses. Knowing that 80% of users override the AI detection would indicate the confidence threshold needs tuning. Knowing the most common manual search terms would inform a "recently used" quick-access feature.

**Implementation notes:**
- Aggregate-only, on-device analytics: count events locally and send weekly summaries (no individual verse data, no audio).
- Events to track: `session_started`, `verse_displayed { source: "auto" | "manual" | "search" }`, `verse_rejected`, `ai_override_count`, `translation_used`, `theme_used`.
- Opt-in consent during onboarding, with a clear explanation of what is and is not collected.
- Send to a simple aggregation endpoint (e.g., Plausible Analytics self-hosted, or a Cloudflare Worker with D1).

---

### 3.7 Presentation Templates and Slide Builder

**What is missing:** The output is a single-layout React component. There are no editable slide templates, no ability to add logos or watermarks, and no title/announcement slides.

**Why it matters:** Churches use their AV system for more than scripture — announcements, event slides, and welcome screens are all part of the display workflow. A minimal slide builder (title, body text, background image) would allow this product to replace a separate announcement display tool.

**Implementation notes:**
- A `Slide` type with variants: `Scripture(Verse)`, `Song(SongSlide)`, `Custom { title: String, body: String, background: Background }`.
- A slide editor panel in the operator window with live preview.
- Custom slides are stored in the setlist alongside scripture cues.
- Background image support requires updating the CSP in `tauri.conf.json` to allow `img-src` from `asset:` protocol (already listed) and the `tauri-plugin-fs` scope.

---

### 3.8 Whisper Model Selection

**What is missing:** The app is hardcoded to use `whisper-base.bin` (74M parameters). Whisper comes in multiple sizes: tiny (39M), base (74M), small (244M), medium (769M), large (1.5B). The path is fixed in `main.rs`: `resource_path.join("models/whisper-base.bin")`.

**Why it matters:** A church with a powerful modern workstation could run `whisper-medium` for significantly better transcription accuracy and fewer false positives. A church with an older laptop would benefit from `whisper-tiny` for lower CPU usage. One-size-fits-all is always a compromise.

**Implementation notes:**
- In Settings, add a "Model Quality" dropdown: Fastest (tiny), Balanced (base, default), Accurate (small), High Accuracy (medium).
- Map selections to filenames: `whisper-tiny.bin`, `whisper-base.bin`, `whisper-small.bin`, `whisper-medium.bin`.
- The setup wizard (P2.8) offers to download the selected model.
- Add an estimated CPU usage indicator next to each option: "~2% CPU", "~5% CPU", "~15% CPU", "~40% CPU".

---

## Summary Table

| ID  | Feature                                | Priority | Complexity | Current State |
|-----|----------------------------------------|----------|------------|---------------|
| 1.1 | Screen Blank / Clear Output            | P1       | Low        | Missing       |
| 1.2 | Global Keyboard Shortcuts              | P1       | Medium     | Missing       |
| 1.3 | Confidence Score + Preview-Before-Send | P1       | Medium     | Score discarded in `search_semantic_mem` |
| 1.4 | Multiple Bible Translations            | P1       | High       | Single DB, no `translation` column |
| 1.5 | Verse Range Display                    | P1       | Medium     | Regex only matches single verse |
| 1.6 | Confidence Monitor (Preview)           | P1       | Low-Medium | Operator sees unstyled text only |
| 1.7 | Settings Persistence                   | P1       | Low        | All state is ephemeral `useState` |
| 1.8 | Stop Session + State Indicator         | P1       | Low        | No stop button, no running state |
| 1.9 | Detection History / Undo               | P1       | Low        | State overwrites on every event |
| 1.10| Audio Level Meter                      | P1       | Low        | Energy computed but never emitted |
| 1.11| Display Theme System                   | P1       | Medium     | Hardcoded black/white/amber |
| 1.12| Error Feedback (AI/DB status)          | P1       | Low        | Silent failures, no error UI |
| 2.1 | Verse History Panel with Timestamps    | P2       | Low        | Missing       |
| 2.2 | Setlist / Service Order                | P2       | High       | Missing       |
| 2.3 | Lower-Third / Overlay Mode             | P2       | Medium     | Window is `transparent` but unused |
| 2.4 | Song Lyrics Display                    | P2       | High       | Missing       |
| 2.5 | Custom Phrase-to-Verse Mapping         | P2       | Medium     | Missing       |
| 2.6 | Export Session Log                     | P2       | Low        | Missing       |
| 2.7 | Monitor Target Selection               | P2       | Medium     | Hardcoded "first non-primary" |
| 2.8 | Onboarding / Setup Wizard              | P2       | High       | App crashes without DB |
| 2.9 | Side-by-Side Translation Comparison    | P2       | Medium     | Requires P1.4 |
| 2.10| Noise Cancellation                     | P2       | Medium-High| Raw audio to Whisper |
| 2.11| Auto-Update Mechanism                  | P2       | Low        | No updater plugin |
| 2.12| Crash Reporting                        | P2       | Low-Medium | Only `app.log` file |
| 3.1 | Multi-language Support                 | P3       | High       | `"en"` hardcoded in engine |
| 3.2 | Passage Navigation / Lectionary        | P3       | Medium     | Single verse navigation only |
| 3.3 | Remote Control / Mobile Companion      | P3       | High       | No network interface |
| 3.4 | Presentation Recording + SRT Export    | P3       | Medium     | No recording |
| 3.5 | Original Language (Greek/Hebrew)       | P3       | Medium     | Missing       |
| 3.6 | Privacy-Preserving Analytics           | P3       | Medium     | Missing       |
| 3.7 | Slide Builder / Announcement Slides    | P3       | High       | Missing       |
| 3.8 | Whisper Model Selection                | P3       | Low        | Hardcoded `whisper-base.bin` |

---

## Immediate Next Steps (Recommended Sprint Order)

The following four features have the highest impact-to-effort ratio and should be built first, in order:

1. **P1.1 Screen Blank** — one afternoon of work, eliminates the most dangerous live-service failure mode.
2. **P1.8 Stop Session + Status Indicator** — prevents the broken re-start bug and gives operators confidence the system is working.
3. **P1.9 Detection History / Undo + Zustand store** — activates the already-installed `zustand` package and creates the shared state architecture that P1.3, P1.6, and P2.1 all depend on.
4. **P1.3 Confidence Score + Preview-Before-Send** — the single most important UX change for live reliability; requires only exposing a value already computed in `store/mod.rs`.

These four changes together would transform the product from a technically impressive demo into a tool that could survive a real Sunday morning service.
