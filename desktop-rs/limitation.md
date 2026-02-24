# Bible Presenter Pro — Commercial Readiness Review

**Review Date:** 2026-02-24
**Reviewer role:** Senior Software Architect, critical commercial readiness assessment
**Scope:** Full codebase review across all dimensions relevant to commercial sale

---

## Executive Summary

Bible Presenter Pro is a technically ambitious proof-of-concept that successfully demonstrates the core loop: real-time speech transcription via Whisper, semantic verse detection via ONNX embeddings, and projection to a second monitor. However, **the product is not commercially ready in its current state.** It has a single hardcoded English translation with no confirmed licensing for redistribution, an audio pipeline with no error recovery, a monolithic 274-line React component with zero state persistence, no activation or licensing system, no crash reporting, no test suite, and a distribution bundle that will exceed 300 MB before the app even launches. Several of these limitations are not minor polish items — they are fundamental architectural gaps that would require significant rework before the product could be sold, installed by a non-technical end user, or used in a live church service without embarrassing failure. The sections below catalogue every limitation found, ordered by commercial impact.

---

## CRITICAL — Blockers for Commercial Sale or Live Deployment

### C1. No Licensing or Activation System

**What it is:** There is no user identity layer, no license key validation, no seat management, no trial mode, no subscription gate, and no entitlement check of any kind. The product is currently free and unlimited by design.

**Why it matters commercially:** You cannot sell software that has no mechanism to enforce payment. Any distributed binary would be fully functional for an unlimited number of users indefinitely, with no way to differentiate a paying customer from a pirate copy.

**What is needed:** A license key validation system (local cryptographic check or server-side activation), hardware fingerprinting for seat enforcement, trial mode with feature/time gating, and an entitlement server or embedded certificate. This is not a small feature — it is an entirely separate subsystem.

---

### C2. Bible Translation Copyright — Unconfirmed Legal Right to Redistribute

**What it is:** The application bundles `bible_data/bible.db` as a static SQLite file that contains the full text of a Bible translation. The specific translation is not identified anywhere in the code, the configuration, or the UI. There is no `LICENSE` file, no `NOTICE` file, and no attribution text visible to the user.

**Why it matters commercially:** Almost all modern English Bible translations are under active copyright with strict licensing terms for software distribution. The NIV, ESV, NKJV, NASB, NLT, CSB, and many others each have separate royalty and per-unit or SaaS licensing frameworks. Redistributing a copyrighted Bible text without a signed distribution agreement exposes the company to copyright infringement claims that could result in injunctions, mandatory product recall, and damages. Even if the embedded translation is a public domain one (KJV, ASV, WEB), this must be explicitly verified and documented. This is the single highest legal risk item in the entire codebase.

**What is needed:** Identify the exact translation, obtain written redistribution rights, add in-app attribution as required by the license agreement, and document it. If the translation is copyrighted, budget for licensing fees — some publishers charge per-unit royalties for software bundling.

---

### C3. No Stop Session / Restart Capability — Audio Stream Cannot Be Restarted Without App Relaunch

**What it is:** `main.rs` exposes `start_session` as a Tauri command but there is no corresponding `stop_session` command. The Tokio async loop spawned in `start_session` (lines 57–100) runs until the mpsc channel closes, which only happens when the `AudioEngine` is dropped. Calling `start_session` a second time creates a new audio stream and a new Tokio task while the previous task may still be running, resulting in two concurrent transcription loops both emitting `transcription-update` events.

**Why it matters commercially:** In a live church environment, operators need to be able to pause, stop, and restart the listening session — for example, when switching from a sermon to a musical segment. The current design makes this impossible without killing the application. Calling START LIVE twice produces undefined, potentially race-condition-prone behavior.

**Code location:** `main.rs:44–103`

**What is needed:** A `stop_session` command that sends a cancellation signal to the Tokio loop, a session state enum (`Idle | Running | Stopping`), and a guard in `start_session` that rejects the call or first stops an existing session.

---

### C4. No Error Recovery for Audio Stream Crash

**What it is:** The CPAL error callback in `audio/mod.rs:134` is:
```rust
|err| eprintln!("Audio error: {}", err),
```
The error is printed to stderr and discarded. There is no attempt to stop and restart the stream, no notification to the UI, no health check, and no way for the operator to know the audio pipeline has silently died.

**Why it matters commercially:** Audio hardware errors are routine in live environments — USB audio interfaces are unplugged, Windows redirects the default device, Bluetooth adapters disconnect. When this happens, the app will appear to be running normally (the UI shows no error state) while silently producing no transcription output. An operator at a live service will only discover the failure when verses stop appearing on the projection screen. This is a critical reliability failure.

**Code location:** `audio/mod.rs:134`

**What is needed:** The error callback must emit a Tauri event to the UI, set an error flag on `AudioEngine`, and ideally attempt stream reconnection with exponential backoff. The UI must display a visible audio status indicator.

---

### C5. Entire Verse Cache and Embeddings Loaded Into Memory at Startup — No Lazy Loading

**What it is:** `store/mod.rs:38–54` preloads every verse from the SQLite database into a `Vec<Verse>` (`verse_cache`) on startup. `store/mod.rs:57–76` loads the entire `embeddings.npy` file (documented as ~48 MB for 384-dim embeddings across all ~31,000 Bible verses) into a dense `Array2<f32>` in RAM. Additionally, the Whisper base model (~148 MB) and the ONNX model (~90 MB) are loaded into memory at startup.

**Why it matters commercially:** Total startup memory footprint is approximately 300–350 MB before any transcription occurs, solely from model and data loading. On machines with 8 GB RAM this is tolerable, but on older church hardware (4 GB, shared GPU VRAM) this will cause severe paging or OOM failures. More critically, this means the app takes a long time to become interactive — the user sees nothing until all models finish loading, with no progress indicator.

**Code location:** `store/mod.rs:38–76`, `main.rs:216–228`

**What is needed:** A startup splash screen with loading progress, lazy model loading (defer Whisper until START LIVE is clicked), and consideration of quantized or smaller model variants.

---

### C6. Single Translation Only — No Bible Version Switching

**What it is:** The database schema is a flat `verses(id, book, chapter, verse, text)` table with no `translation` column. There is no UI for selecting a translation. All queries in `store/mod.rs` fetch text without any translation filter. The entire product is hardcoded to whatever single translation is embedded in `bible.db`.

**Why it matters commercially:** Churches use different Bible versions — NIV, ESV, KJV, NKJV, NLT, and others. A worship leader's sermon may quote from ESV while a pastor uses NKJV. A product marketed to churches that only supports a single unnamed translation will face immediate rejection in a market where every competitor (ProPresenter, EasyWorship, MediaShout) supports 30+ translations with runtime switching.

**Code location:** `store/mod.rs:40`, `store/mod.rs:200–218`

**What is needed:** A `translations` table and a `translation_id` foreign key on `verses`, a translation selector in the UI, and a process for licensing and bundling multiple translations.

---

## HIGH — Severely Limits Commercial Viability or Market Reach

### H1. English-Only Transcription — Hardcoded Language Parameter

**What it is:** `engine/mod.rs:34` sets the Whisper language parameter unconditionally to English:
```rust
params.set_language(Some("en"));
```
This cannot be changed at runtime. There is no language selector in the UI.

**Why it matters commercially:** The global church software market is dominated by non-English-speaking congregations — Spanish, Portuguese, Korean, Mandarin, French, Swahili, and others. Locking to English excludes the majority of the world church market. Even within English-speaking countries, bilingual congregations are common.

**Code location:** `engine/mod.rs:34`

**What is needed:** A language selector in the UI, persistence of the language setting, and validation that the Whisper model variant used supports the required languages (the `whisper-base` model supports multilingual inference when not forced to English).

---

### H2. No State Persistence — All Settings Reset on Every App Launch

**What it is:** All application state is held exclusively in React `useState` hooks in `App.tsx`. There is no use of `localStorage`, no settings file, no Tauri store plugin, and no database table for preferences. Every time the application is launched, the operator must:
- Re-select the audio input device
- Re-tune the VAD sensitivity slider
- Re-toggle the output window

The installed dependencies include `zustand` (a state management library) but it is explicitly noted in `CLAUDE.md:109` as "not yet used." The `tauri-plugin-fs` dependency appears in `Cargo.toml:14` but is unused.

**Why it matters commercially:** Requiring operators to reconfigure the application every session is a usability failure. In a church environment, the sound technician who configured the app may not be present the following Sunday. This is a basic product quality expectation that every competitor meets.

**Code location:** `src/App.tsx` (entire file), `Cargo.toml:14`

**What is needed:** Persist audio device selection, VAD threshold, Bible translation, and window state to a settings file using the Tauri store plugin or a SQLite preferences table.

---

### H3. No Keyboard Shortcuts

**What it is:** There are zero keyboard event handlers in `App.tsx`. Every interaction requires mouse clicks. Common presenter workflows — advancing to the next verse, clearing the screen, triggering manual display — are only achievable via mouse.

**Why it matters commercially:** Live presentation operators work in high-pressure, fast-moving environments. ProPresenter, EasyWorship, and every professional presentation tool are designed around keyboard-first operation. An operator fumbling with a mouse during a live service is unacceptable. This is a fundamental UX expectation in the church presentation software category.

**What is needed:** Global keyboard event listeners for at minimum: clear screen (`Escape`), display current selection (`Enter`/`Space`), start/stop listening, and next/previous verse navigation.

---

### H4. No Confidence Score or Match Quality Indicator in the UI

**What it is:** The semantic search in `store/mod.rs:220–244` computes a cosine similarity score (`max_score`) and applies a threshold of `0.45`, but this score is never surfaced to the UI. The `TranscriptionUpdate` struct in `main.rs:13–17` contains only `text` and `detected_verse`, with no confidence field. The operator has no way to know whether a detected verse is a strong match (score 0.95) or a borderline guess (score 0.46).

**Why it matters commercially:** False positives — where the AI displays the wrong verse on the projection screen — are the most embarrassing failure mode in a live service. An operator who can see a confidence score can intervene before a wrong verse is shown. Without this, the operator is flying blind.

**Code location:** `store/mod.rs:239`, `main.rs:13–17`

**What is needed:** Add a `confidence: Option<f32>` field to `TranscriptionUpdate`, propagate scores through the detection pipeline, and display a visual confidence indicator in the operator UI.

---

### H5. No "Clear Screen" / "Blank Screen" Command

**What it is:** Once a verse is displayed on the output window, there is no way to clear it. The only way to remove a verse from the projection screen is to display a different verse. The `activeVerse` state in `App.tsx` can only be set to a `Verse` object — it cannot be cleared by the operator.

**Why it matters commercially:** Blanking the projection screen is a fundamental capability used constantly during live services — between segments, during prayer, when transitioning to announcements. Every presentation tool has a "black screen" or "blank" shortcut. The absence of this feature alone would be reported as a critical bug by any church user within the first five minutes of use.

**Code location:** `src/App.tsx:9`, `main.rs:105–135`

**What is needed:** A `clear_screen` Tauri command, a keyboard shortcut (e.g., `Escape`), and a UI button.

---

### H6. VAD Is a Naive Energy Threshold — No Proper Voice Activity Detection

**What it is:** The "VAD" (Voice Activity Detection) in `audio/mod.rs:126–129` is simply:
```rust
let energy = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;
if energy > vad_threshold {
    let _ = tx.try_send(mono);
}
```
This is RMS energy gating. It is not voice activity detection. It will trigger on any loud sound — applause, music, coughing, microphone handling noise, or PA system feedback.

**Why it matters commercially:** In a church environment, background music, congregational singing, and ambient noise are constant. Every one of these will trigger the transcription pipeline, causing spurious verse detections that disrupt the display. A proper VAD implementation (such as Silero VAD) uses a neural model to distinguish speech from non-speech audio.

**Code location:** `audio/mod.rs:126–129`

**What is needed:** Integration of a proper VAD model (Silero VAD is permissively licensed and available as ONNX), or at minimum spectral/frequency-domain analysis to distinguish speech-like signals from music and noise.

---

### H7. No Multi-Translation / Apocrypha Support — Schema Locks Out Catholic and Orthodox Markets

**What it is:** The `book_map` in `store/mod.rs:79–146` contains only the 66 books of the Protestant canon. There is no entry for Tobit, Judith, 1–4 Maccabees, Sirach/Ecclesiasticus, Wisdom, Baruch, or other deuterocanonical books used by Catholic, Eastern Orthodox, and Anglican congregations.

**Why it matters commercially:** Roman Catholic churches, Eastern Orthodox parishes, and Anglican congregations — which collectively represent a substantial fraction of the global churchgoing market — use Bibles that include the deuterocanonical books. These congregations will be unable to display passages from these books at all.

**Code location:** `store/mod.rs:79–146`

---

### H8. Single-User Architecture — No Network Projection or Multi-Operator Support

**What it is:** The entire application is a single-process desktop app. The output window is a second Tauri window within the same process, using in-process Tauri events for communication. There is no network layer, no WebSocket server, no NDI output, no RTMP, and no way for a remote display (tablet, secondary PC, lobby screen) to receive the current verse.

**Why it matters commercially:** Modern church A/V setups routinely require output to lobby screens, cry rooms, live stream overlays, and stage confidence monitors — all on separate hardware. ProPresenter's "Pro" tier and EasyWorship both offer network output as core paid features. This architecture cannot support any of these use cases without a complete redesign of the output layer.

---

### H9. No Auto-Update Mechanism

**What it is:** `tauri.conf.json` contains no `updater` plugin configuration. There is no `tauri-plugin-updater` in `Cargo.toml`. Once a user installs the application, they have no way to receive bug fixes, security patches, or new features except by manually downloading and re-installing.

**Why it matters commercially:** For a commercial product, the ability to push fixes to installed users is essential for security maintenance and feature delivery. It is also a standard expectation for any paid software product. Operating without auto-update means any critical bug discovered post-launch requires a manual re-download campaign to every customer.

---

### H10. Distribution Bundle Size Is Prohibitive

**What it is:** The bundle resources declared in `tauri.conf.json:45–51` include:
- `whisper-base.bin` — ~148 MB
- `all-minilm-l6-v2.onnx` — ~90 MB
- `embeddings.npy` — ~48 MB
- `bible.db` — estimated 10–30 MB
- `tokenizer.json` — small

Total: approximately **300–320 MB of bundled resources**, before the Rust binary, WebView runtime, and Tauri runtime are included. The full installer will likely exceed 350 MB.

**Why it matters commercially:** A 350 MB installer creates friction at every distribution point. Most church IT policies have download size limits. Many churches have slow internet connections. App stores and direct distribution platforms charge for bandwidth. Users compare this to ProPresenter (which streams content) and reject it. Furthermore, the entire bundle must be re-downloaded on every update, since there is no delta-update or separate model download flow.

**What is needed:** Separate model distribution from the app installer. Ship a small (~5 MB) application installer that downloads models on first run with a progress UI. Consider using `whisper-tiny` as a default with optional upgrade to `whisper-base`.

---

## MEDIUM — Significant Quality and Scalability Gaps

### M1. Content Security Policy Allows unsafe-inline

**What it is:** `tauri.conf.json:32`:
```
"script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
```
`unsafe-inline` permits execution of inline JavaScript and inline styles without a nonce or hash. This weakens the XSS mitigation that CSP is designed to provide.

**Why it matters commercially:** While Tauri's local renderer context limits some attack vectors, `unsafe-inline` in the CSP is a known security weakness that will appear in any security audit. Enterprise church organizations and schools will perform security reviews before approving software for installation on their networks.

**What is needed:** Move inline styles to CSS classes (Tailwind already does this for most cases). Use a build-time CSP nonce or hash for any remaining inline scripts.

---

### M2. Entire App Is a Single 274-Line Monolithic React Component

**What it is:** `src/App.tsx` is 274 lines containing a single default export component that handles window role detection, all API calls, all state, two completely different UI layouts (operator and output), and all event handlers. The installed state management library (`zustand`) and animation library (`framer-motion`) are installed but explicitly unused per `CLAUDE.md:109`.

**Why it matters commercially:** This structure makes the codebase unmaintainable at scale. Adding features requires editing a single growing file. Testing individual UI concerns is impossible. The output window's display logic is embedded inside an `if (label === "output")` branch at line 104, which is a code smell that will cause bugs as the output display becomes more complex (themes, backgrounds, transitions).

**Code location:** `src/App.tsx:1–274`, `CLAUDE.md:109`

**What is needed:** Component decomposition (OperatorPanel, OutputDisplay, SearchSidebar, VerseSelector, DeviceSelector), a proper store layer using Zustand, and separation of the output window into its own dedicated component or route.

---

### M3. No Presentation Themes or Background Customization

**What it is:** The output window in `App.tsx:105–119` is hardcoded with a black background (`bg-black`), white text at `text-7xl`, and amber reference text at `text-4xl`. There is no font picker, no background image support, no color scheme selection, and no way to save or recall presentation themes.

**Why it matters commercially:** Churches have strong brand identities. A youth ministry uses different fonts and colors than a traditional congregation. Worship backgrounds (motion graphics, still images) are a core expectation. Every competitor supports theming. A fixed black screen with hardcoded font sizes will be rejected immediately by any design-conscious church.

---

### M4. Whisper Transcription Is Blocking — Runs on spawn_blocking with No Timeout

**What it is:** `main.rs:71–85` calls `tokio::task::spawn_blocking` to run both the Whisper transcription and the ONNX embedding inference. There is no timeout set on this operation. If Whisper stalls (which it can under certain audio conditions with the GGML backend), the thread pool thread is permanently occupied. Multiple such stalls can exhaust the Tokio blocking thread pool.

**Code location:** `main.rs:71–85`

**What is needed:** A timeout wrapper around the `spawn_blocking` call (e.g., `tokio::time::timeout`), a maximum queue depth check, and a mechanism to detect and recover from stalled inference.

---

### M5. Semantic Search Has No Disambiguation — Always Returns Top Match

**What it is:** `store/mod.rs:228–244` returns the single verse with the highest cosine similarity score above 0.45. There is no disambiguation step, no list of candidates for the operator to choose from, and no mechanism to handle cases where multiple verses are nearly equally similar to the transcription.

**Why it matters commercially:** Common phrases like "love your neighbor" appear in multiple passages. The algorithm will silently pick one, with no indication that several equally plausible matches exist. The operator cannot review and confirm the match. This leads to confidently-displayed wrong verses.

---

### M6. search_manual Uses LIKE with No FTS — Will Be Slow on Large Translation Databases

**What it is:** `store/mod.rs:283–286`:
```rust
"SELECT id, book, chapter, verse, text FROM verses WHERE text LIKE ?1 LIMIT 20"
```
This uses a `LIKE '%query%'` pattern which requires a full table scan. SQLite's FTS5 extension is not enabled. With a single translation this is marginal, but with multiple translations (tens of thousands of additional rows) this will produce noticeable latency.

**Code location:** `store/mod.rs:283`

**What is needed:** Enable SQLite FTS5 (`rusqlite` supports it via the `bundled-sqlcipher` or `bundled` feature with FTS5 enabled) and replace the LIKE query with an FTS5 virtual table query.

---

### M7. No Crash Reporting or Telemetry

**What it is:** The logging in `main.rs:25–40` writes to a local file (`app.log`) with plain text. There is no integration with any crash reporting service (Sentry, Crashpad, Bugsnag). When the app crashes in the field, the developer has no visibility into what happened.

**Why it matters commercially:** Identifying and fixing bugs in shipped software requires crash reports from the field. Without telemetry, the support burden falls entirely on users submitting manual bug reports with log files. This is not scalable for a commercial product.

---

### M8. No Tests

**What it is:** `CLAUDE.md:26` explicitly states: "There are no tests in this project currently." There are no unit tests, no integration tests, no end-to-end tests, and no test infrastructure.

**Why it matters commercially:** The verse detection logic (`detect_verse_hybrid`, `detect_verse`, `search_semantic_mem`, `search_semantic_text`) is the core value proposition of the product. Shipping this logic with zero test coverage means any change risks silently breaking detection accuracy. Regressions will only be discovered in live services.

---

### M9. No Input Sanitization on search_manual

**What it is:** `store/mod.rs:287` passes the user's search query directly into a `params!` macro:
```rust
params![format!("%{}%", query)]
```
While the parameterized query prevents SQL injection, there is no length limit, no character class validation, and no rate limiting on the Tauri command. A malformed query with pathological LIKE patterns (e.g., a string of `%` characters) can cause excessive SQLite CPU usage.

**Code location:** `store/mod.rs:287`, `main.rs:157–159`

---

### M10. Output Window Management Has No Fallback for Single-Monitor Setup

**What it is:** `main.rs:112–131` attempts to move the output window to a secondary monitor and go fullscreen, but if `monitors.len() <= 1` the code falls through to `window.show()` without any position adjustment. The output window will appear over the operator window on the same monitor, which is the expected case for a user testing the software for the first time on a laptop.

**Code location:** `main.rs:112–131`

**Why it matters commercially:** First-run experience is critical for trial conversions. A user evaluating the product on their laptop will see the output window appear on top of the operator window with no explanation. This is confusing and looks broken.

---

### M11. No Installer Polish — Version 0.1.0 Branding in Production Configuration

**What it is:** `tauri.conf.json:3` and `Cargo.toml:3` both declare version `0.1.0`. The product name in `tauri.conf.json:2` is "Bible Presenter RS" — the "RS" suffix is an internal Rust rewrite indicator that has leaked into the user-facing product name. There is no EULA in the installer, no privacy policy, no onboarding flow, and no "getting started" experience.

**Code location:** `tauri.conf.json:2–3`, `Cargo.toml:3`

---

### M12. macOS and Linux Audio Are Untested

**What it is:** `CLAUDE.md:113` notes that the `unsafe impl Send + Sync` on `StreamHandle` is specifically motivated by Windows WASAPI behavior. CPAL behaves differently on macOS (CoreAudio) and Linux (ALSA/PipeWire/PulseAudio). The resampling pipeline and VAD have not been validated on non-Windows platforms. The `tauri.conf.json` bundle targets `"all"` but there is no evidence of macOS or Linux build or test activity.

**Code location:** `audio/mod.rs:7–12`, `tauri.conf.json:42`

**Why it matters commercially:** If macOS builds are distributed but untested, audio failures on Apple Silicon or Intel Mac will generate immediate negative reviews. Church A/V teams are a Mac-heavy demographic.

---

### M13. Installed Packages Unused — Dependency Bloat and Future Confusion

**What it is:** `package.json` declares `framer-motion`, `lucide-react`, and `zustand` as production dependencies. `CLAUDE.md:109` explicitly confirms none of these are used. Similarly, `tauri-plugin-fs` is in `Cargo.toml:14` but has no usage in the Rust source files.

**Why it matters commercially:** Unused production dependencies inflate the bundle size, create potential security exposure if those packages have vulnerabilities, and signal to any technical reviewer that the codebase is not production-ready. Dependency audits are standard practice for enterprise procurement.

**Code location:** `package.json:16–19`, `Cargo.toml:14`

---

### M14. No Session History or Recently Used Verses

**What it is:** There is no persistence of which verses were displayed during a service, no "recently used" list, no service playlist, and no way to prepare a set of verses in advance. Every session starts from scratch.

**Why it matters commercially:** Worship leaders and pastors often prepare sermon verse lists in advance. The ability to pre-program a service is a standard feature in all competing products. Without it, the product is entirely reactive (dependent on AI detection) with no fallback workflow.

---

### M15. Whisper Greedy Decoding Only — Lowest Accuracy Configuration

**What it is:** `engine/mod.rs:32`:
```rust
let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
```
Greedy decoding with `best_of: 1` is the fastest but least accurate Whisper sampling strategy. Beam search (`SamplingStrategy::BeamSearch { beam_size: 5, patience: 1.0 }`) consistently produces more accurate transcriptions, which directly improves verse detection accuracy — the product's core value proposition.

**Code location:** `engine/mod.rs:32`

---

## Summary Table

| ID  | Category              | Severity | Estimated Fix Effort |
|-----|-----------------------|----------|----------------------|
| C1  | No licensing/activation system | Critical | 4–8 weeks |
| C2  | Bible translation copyright unclear | Critical | Legal review + negotiation |
| C3  | No stop session / session management | Critical | 1–2 weeks |
| C4  | Audio stream crash silent failure | Critical | 1 week |
| C5  | 300+ MB startup memory, no progress UI | Critical | 2–3 weeks |
| C6  | Single translation only | Critical | 3–5 weeks |
| H1  | English-only transcription | High | 3 days |
| H2  | No settings persistence | High | 1 week |
| H3  | No keyboard shortcuts | High | 3 days |
| H4  | No confidence score in UI | High | 2 days |
| H5  | No clear/blank screen command | High | 1 day |
| H6  | Naive energy-threshold VAD | High | 2–3 weeks |
| H7  | Protestant-only canon | High | 1 week |
| H8  | Single-user, no network output | High | 4–8 weeks |
| H9  | No auto-update | High | 1 week |
| H10 | 350 MB installer bundle | High | 2 weeks |
| M1  | CSP unsafe-inline | Medium | 1 day |
| M2  | Monolithic React component | Medium | 1 week |
| M3  | No presentation theming | Medium | 2–3 weeks |
| M4  | Blocking inference, no timeout | Medium | 2 days |
| M5  | No match disambiguation | Medium | 1 week |
| M6  | No FTS for verse search | Medium | 2 days |
| M7  | No crash reporting | Medium | 3 days |
| M8  | Zero test coverage | Medium | Ongoing |
| M9  | No search input sanitization | Medium | 1 day |
| M10 | Single-monitor output UX broken | Medium | 2 days |
| M11 | Version/naming not production-ready | Medium | 1 day |
| M12 | macOS/Linux audio untested | Medium | 1–2 weeks |
| M13 | Unused production dependencies | Medium | 1 day |
| M14 | No service planning / history | Medium | 1–2 weeks |
| M15 | Greedy decoding lowest accuracy | Medium | 1 day |

---

*This document reflects the state of the codebase as reviewed on 2026-02-24. No fixes have been applied. All file references are to the paths under `desktop-rs/src-tauri/` and `desktop-rs/src/` as reviewed.*
