# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs Vite dev server + Tauri backend together)
npm run tauri dev

# Frontend only
npm run dev           # Vite dev server on port 1420
npm run build         # tsc + vite build → dist/

# Rust backend
cd src-tauri
cargo check           # Fast compile check
cargo clippy          # Lint
cargo build           # Debug build
cargo build --release # Release build

# Full production bundle
npm run tauri build
```

There are no tests in this project currently.

## Required Files (Not in Repo)

The app will start but `start_session` will fail without models. It will **crash at startup** without the database.

```
src-tauri/models/
  whisper-base.bin          # ~148 MB GGML Whisper model
  all-minilm-l6-v2.onnx     # ~90 MB sentence-transformer ONNX
  tokenizer.json            # HuggingFace tokenizer (already committed)

src-tauri/bible_data/
  bible.db                  # SQLite with table: verses(id, book, chapter, verse, text)
  embeddings.npy            # ~48 MB pre-computed 384-dim L2-normalized verse embeddings
```

Startup logs go to `{AppLocalData}/com.biblepresenter.rs/logs/app.log`.

## Architecture

### Two-Window Model

The same React app (`src/App.tsx`) is loaded in two Tauri windows:

- **`main`** (1200×800) — Operator control panel: device selector, VAD threshold slider, manual book/chapter/verse picker, keyword search, live transcription view
- **`output`** (1920×1080, transparent, always-on-top, hidden by default) — Audience display, toggled via `toggle_output_window` command which also tries to fullscreen on a secondary monitor

The window's role is determined at runtime: `getCurrentWindow().label` is checked in `useEffect`. Both windows subscribe to the same `transcription-update` Tauri event and maintain their own `activeVerse` state. When `select_verse` is called, `app.emit("transcription-update", ...)` broadcasts to both.

### Live Transcription Pipeline

```
Microphone → CPAL stream → Rubato resampler (→ 16kHz mono) → VAD gate (energy threshold)
  → mpsc channel → Tokio async loop (accumulate 32000 samples = 2s)
  → spawn_blocking:
      1. Whisper transcription (text)
      2. ONNX embedding (384-dim L2-normalized vector)
      3. store.detect_verse_hybrid(text, embedding)
           ├─ Regex patterns on text (explicit references like "John 3:16")
           ├─ Cosine similarity against pre-loaded embeddings.npy (threshold 0.45)
           └─ Fallback: keyword overlap in verse_cache (threshold ≥ 3 matching words)
  → app.emit("transcription-update", { text, detected_verse })
  → Slide buffer forward (keep 8000 sample overlap)
```

`BibleStore` preloads all verses into `verse_cache: Vec<Verse>` and all embeddings into `embeddings: Option<Array2<f32>>` at startup for in-memory inference speed.

### Global State

`AppState` in `main.rs` holds:
- `audio: Arc<Mutex<AudioEngine>>` — CPAL stream, device selection, VAD
- `engine: Option<Arc<TranscriptionEngine>>` — Whisper context + ONNX session (None if models missing)
- `store: Arc<BibleStore>` — SQLite connection, verse cache, embeddings

All Tauri commands receive `State<'_, AppState>`.

## Critical Dependency Constraint: ort + ndarray

**`ort 2.0.0-rc.11`** depends on ndarray 0.17; **`ndarray-npy 0.8`** depends on ndarray 0.15. Enabling ort's `ndarray` feature causes both versions to compile simultaneously, creating type conflicts (e.g. `Axis` becomes ambiguous).

**Rules:**
- Do NOT add `features = ["ndarray"]` to the `ort` dependency
- Use raw tensor APIs only:
  ```rust
  // Input tensors:
  Tensor::from_array(([1usize, seq_len], data_vec))?

  // Output tensors:
  let (shape, data) = output.try_extract_tensor::<f32>()?;
  // shape derefs to &[i64], data is &[f32]

  // Do NOT use try_extract_array() — it returns ndarray 0.17 types

  // ort::inputs! macro returns Vec<...>, NOT Result — do not use ?
  let inputs = ort::inputs!["name" => Tensor::from_array(...)?];
  ```
- `ort::value::Tensor` is the correct import path (not `ort::Tensor`)

## Frontend Stack

- **Tailwind CSS v4** — requires `@tailwindcss/vite` plugin in `vite.config.ts`; `@import "tailwindcss"` in `index.css` is the v4 CSS-first syntax. The `tailwind.config.js` is a legacy v3-format file that v4 ignores.
- **`framer-motion`** and **`lucide-react`** and **`zustand`** are installed but not yet used in `App.tsx`
- All UI state is local `useState` in the single monolithic `App.tsx` component

## Windows Platform Notes

`cpal::Stream` on Windows is `!Send + !Sync` (raw WASAPI handles). `AudioEngine` wraps it in `StreamHandle` with `unsafe impl Send + Sync` — safe because `AudioEngine` itself is behind `Arc<Mutex<>>` in `AppState`, serialising all access.
