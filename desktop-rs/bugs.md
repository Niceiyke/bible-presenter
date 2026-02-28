# Bible Presenter RS - Bug Report

This document outlines the bugs and potential issues identified during the project review.

## Backend (Rust / Tauri)

### 1. Security: Path Traversal Vulnerability
- **Location:** `src-tauri/src/main.rs`, function `read_file_base64`.
- **Bug:** The command reads any file from disk based on a raw path string from the frontend without validation.
- **Effect:** A compromised or malicious frontend can read sensitive system files (e.g., `.env`, SSH keys) from the host machine.
- **Side Effect:** Potential data breach and loss of system integrity.

### 2. Logic: Inefficient Media & Presentation Operations
- **Location:** `src-tauri/src/store/media_schedule.rs`, functions `set_media_fit` and `delete_media`.
- **Bug:** These operations perform an $O(N)$ full directory scan and generate/read sidecar IDs for every file to find a match.
- **Effect:** UI lag and high disk I/O when the media library grows.
- **Side Effect:** Stale or duplicate sidecar files if operations are interrupted.

### 3. Functional: Non-Embedded Bible Version Search Failure
- **Location:** `src-tauri/src/store/mod.rs`, function `version_slice`.
- **Bug:** `search_manual` returns an empty result for any Bible version not listed in the hardcoded `EMBEDDED_VERSIONS` array.
- **Effect:** Users cannot search within manually added Bible versions.
- **Side Effect:** Users may assume the version is corrupt or the search is broken.

### 4. Logic: Multi-word Bible Book Detection
- **Location:** `src-tauri/src/store/mod.rs`, `detect_verse_by_ref` regex.
- **Bug:** The regex `r"(?i)([1-3]?\s*[a-z]+)\s+(\d+)[:\s]+(\d+)"` only captures the first word of a book name.
- **Effect:** Fails to detect references like "Song of Solomon 1:1" if Whisper transcribes the full name.
- **Side Effect:** Reduced AI reliability for specific books.

### 5. State: Remote Control vs. Desktop App Inconsistency
- **Location:** `src-tauri/src/remote/mod.rs` vs `src-tauri/src/main.rs`.
- **Bug:** The `go_live` command in the remote module sets both `live_item` and `staged_item`, whereas the desktop `go_live` only sets `live_item` from the current `staged_item`.
- **Effect:** "Stage" state in the desktop UI is unexpectedly overwritten when triggered from a remote device.
- **Side Effect:** Confusion for the operator who might have been preparing another slide in the stage area.

---

## Frontend (React / TypeScript)

### 6. Logic: Race Condition in `sendLive`
- **Location:** `src/App.tsx`, function `sendLive`.
- **Bug:** Uses `await new Promise((r) => setTimeout(r, 50))` between `stageItem` and `goLive`.
- **Effect:** If the backend takes longer than 50ms to process the `stage_item` invoke, `go_live` will project the *previous* staged item instead of the new one.
- **Side Effect:** Intermittent "wrong slide" displayed during live presentations.

### 7. Performance: Memory Leak in PPTX Rendering
- **Location:** `src/windows/OutputWindow.tsx`, `outputZipsRef`.
- **Bug:** ZIP objects for PPTX files are cached indefinitely and never cleared.
- **Effect:** Increasing RAM usage over time, eventually leading to a crash or system slowdown during long services.
- **Side Effect:** Browser tab (Webview) crash on low-memory systems.

### 8. UI/UX: AI Confidence Ignoring on Output
- **Location:** `src/windows/OutputWindow.tsx`, `transcription-update` listener.
- **Bug:** The output window automatically updates `liveItem` whenever a `detected_item` is received, regardless of the confidence score.
- **Effect:** Low-confidence AI "hallucinations" or background noise misidentified as verses will be immediately projected to the congregation.
- **Side Effect:** Embarrassing or disruptive incorrect scriptures appearing on screen.

### 9. Resource: Missing Thumbnail Generation
- **Location:** `src/store/media_schedule.rs` and `src/components/MediaTab.tsx`.
- **Bug:** `MediaItem` has a `thumbnail_path` field that is always `None`.
- **Effect:** The frontend is forced to load original high-resolution images/videos for small library thumbnails.
- **Side Effect:** Slow UI loading, high memory usage, and potential lag when scrolling through large media folders.

---

## System Architecture

### 10. Reliability: WebSocket Brute Force
- **Location:** `src-tauri/src/remote/mod.rs`, `handle_socket`.
- **Bug:** No rate limiting or lockout mechanism for the 4-digit PIN authentication.
- **Effect:** An attacker on the same LAN can brute-force the PIN in seconds using a simple script.
- **Side Effect:** Unauthorized remote control of the church's projection screen.

### 11. Maintenance: Duplicated Display Text Logic
- **Location:** Found in `main.rs`, `remote/mod.rs`, and `utils/index.ts`.
- **Bug:** Logic for converting a `DisplayItem` to a human-readable string (e.g., "John 3:16") is reimplemented in multiple places.
- **Effect:** Changes to item types or formatting must be manually updated in 3+ locations.
- **Side Effect:** UI and Remote logs will eventually drift and show inconsistent labels.
