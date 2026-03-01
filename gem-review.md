# Bible Presenter RS — Architectural & Code Quality Review

## Executive Summary
Bible Presenter RS is a sophisticated Tauri 2.0 application that successfully integrates real-time AI (Whisper/ONNX) into a professional church projection workflow. The architecture is soundly built on a multi-window model with a shared Rust state, but it is currently at a critical "refactor or technical debt" junction.

While feature-complete for a beta, the project suffers from **zero test coverage**, several **high-risk security vulnerabilities**, and **monolithic code structures** that will hinder long-term maintainability.

---

## 1. Architecture Review
*   **The Good:**
    *   **Tauri 2.0 Choice:** Using Rust for the backend is the right decision for low-latency audio processing and multi-monitor window management.
    *   **Multi-Window State Sync:** The use of `tokio::sync::broadcast` and Tauri events to sync state across Operator, Output, Stage, and Design windows is clean and idiomatic.
    *   **Hybrid AI Pipeline:** The tiered approach (Regex → Semantic Search → Keyword Fallback) for verse detection is clever and performs well.
    *   **Lazy Loading:** Loading heavy AI models (~250MB) only when the session starts prevents a 15-second "cold start" blank screen.

*   **The Bad:**
    *   **The "God Module" Problem:** `main.rs` is over 1,300 lines and handles everything from app setup to audio loops and database queries. This makes it a merge-conflict magnet and hard to test.
    *   **State Deadlock Risk:** `AppState` is a massive struct of nested `Arc<Mutex<>>`. Accessing multiple fields in different orders across 50+ Tauri commands is a high risk for ABBA deadlocks.
    *   **Remote Inconsistency:** The remote control bypasses the "Staged → Live" workflow used in the desktop UI, which can lead to desynchronization between what the operator sees and what is on screen.

---

## 2. Code Quality & Maintainability
*   **Testing (Critical Gap):** There is **zero test coverage**. At this complexity level, any change to the regex patterns or the audio buffer logic risks silent regressions in scripture detection.
*   **Error Handling:** Almost all Tauri commands return `Result<T, String>`. This "stringly-typed" error handling makes it impossible for the frontend to distinguish between a transient error (e.g., "mic busy") and a fatal one (e.g., "model missing").
*   **Hardcoded Data:** The `BibleStore` constructor contains 130+ lines of hardcoded book aliases. This should be moved to a JSON configuration or a database table.
*   **Duplicated Logic:** Logic for converting a `DisplayItem` to a label is duplicated in at least three places (Rust main, Rust remote, and TypeScript utils).

---

## 3. Production Readiness & Security
*   **Security Vulnerabilities:**
    1.  **Path Traversal:** The `read_file_base64` command allows the frontend to read *any* file on the user's system without validation.
    2.  **Remote Brute Force:** The 4-digit remote PIN has no rate limiting or lockout, allowing an attacker on the same LAN to gain control in seconds.
    3.  **Asset Protocol:** The `assetProtocol.scope` is set to `["**"]`, which is overly permissive.
*   **Performance Issues:**
    1.  **Hot-Path Allocations:** The main audio loop re-allocates a `Vec` every 1–3 seconds using `buffer = buffer[remaining..].to_vec()`. This pressures the heap in a latency-sensitive path.
    2.  **Database Inefficiency:** Book lookups use `LIKE` instead of `=`, which prevents SQLite from using indexes effectively on a 100MB+ database.
    3.  **Memory Leak:** PPTX rendering caches ZIP objects indefinitely in `OutputWindow.tsx`, which will eventually crash the app during long services.

---

## 4. Key Recommendations

### Immediate (Priority 1)
1.  **Fix Security:** 
    *   Add path validation to `read_file_base64`.
    *   Implement rate-limiting for the WebSocket auth handler (e.g., 3 attempts per IP then 60s lockout).
2.  **Add Unit Tests:** Implement tests for `BibleStore::detect_verse_hybrid` with a suite of common scripture reference formats.
3.  **Modularize `main.rs`:** Split commands into modules (e.g., `commands/bible.rs`, `commands/audio.rs`) to break up the monolith.

### Near-term (Priority 2)
4.  **Structured Errors:** Introduce a `#[derive(Serialize)] enum AppError` and return `Result<T, AppError>` from all Tauri commands.
5.  **Optimize Audio Loop:** Replace the buffer re-allocation with a `VecDeque` and use `drain` to keep the overlap context.
6.  **Database Indexing:** Ensure a composite index exists on `(title, chapter, verse, version)` and use `=` for lookups.

### Good to Have (Roadmap)
7.  **Model Downloader:** Add a UI flow to download AI models if they are missing, rather than crashing at startup.
8.  **MIDI/OSC Support:** Essential for professional AV integration (controlling slides via foot pedals or lighting boards).
9.  **NDI Output:** For broadcasting to professional video switchers like the ATEM Mini.

**Overall Score: 6.5/10.** The core engineering is impressive and the AI integration is top-tier, but the project needs a "quality-focused" sprint to fix security holes and establish a testing baseline before it can be considered production-ready for mission-critical church environments.
