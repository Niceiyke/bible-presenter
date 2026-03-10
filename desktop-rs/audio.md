# Audio Pipeline

This document describes how audio capture, resampling, and transcription work in the Wordlyte desktop app.

---

## Overview

```
Microphone (any sample rate, any format)
  │
  ▼
CPAL input stream  ──────────────────────────── audio-level event (VU meter)
  │  (raw frames, all channels)
  ▼
Sinc resampler  →  16 kHz mono f32
  │
  ▼
VAD gate  (energy threshold)
  │  drop silent frames
  ▼
mpsc channel  (Vec<f32> chunks)
  │
  ▼
Accumulation buffer  (grows until window_size reached)
  │
  ├─ [cloud mode]  ──→  HTTP API  →  text
  │
  └─ [local mode]  ──→  spawn_blocking
                            │
                            ├─ Whisper  →  text
                            └─ ONNX embed  +  detect_verse_hybrid
  │
  ▼
transcription-update event  →  frontend
```

---

## Components

### 1. `AudioEngine` (`src-tauri/src/audio/mod.rs`)

The central struct that owns the CPAL stream. It lives inside `Arc<Mutex<AudioEngine>>` in `AppState`, which serialises all access.

**Fields:**

| Field | Type | Purpose |
|---|---|---|
| `stream` | `Option<Arc<StreamHandle>>` | Live CPAL stream — dropping this stops capture |
| `selected_device_name` | `Option<String>` | User-chosen input device; `None` = system default |
| `active_tx` | `Option<mpsc::Sender<Vec<f32>>>` | Sends resampled chunks to the processing loop |
| `active_error_tx` | `Option<mpsc::Sender<String>>` | Forwards device errors to the UI |
| `active_level_tx` | `Option<mpsc::Sender<f32>>` | Sends RMS energy values for the VU meter |
| `vad_threshold` | `f32` | Energy gate; default `0.002` |

#### `StreamHandle` safety note

`cpal::Stream` on Windows is `!Send + !Sync` (it holds raw WASAPI handles). `StreamHandle` wraps it with `unsafe impl Send + Sync` — safe because `AudioEngine` is itself behind `Mutex`, so no two threads ever touch the stream simultaneously.

---

### 2. Device selection

`list_devices()` queries the default CPAL host for all input devices and returns their names. The operator picks one in the UI; `select_device()` stores the name and, if a session is already active, stops and restarts the stream immediately so the switch takes effect without a full session restart.

---

### 3. Stream building — `build_stream<T>`

Called from `start_capturing()` once the device and its `default_input_config` are known. The stream's sample format (F32, I16, or U16) is dispatched at runtime; each variant calls the same generic `build_stream<T>` function.

**Inside the CPAL callback (runs on an OS audio thread):**

1. **Frame demux** — interleaved samples are split into per-channel buffers.
2. **Batching** — accumulates 1 024 frames before processing to avoid calling the resampler on every tiny callback.
3. **Sinc resampling** (`rubato`) — converts from the device's native sample rate to 16 kHz. Parameters:
   - Sinc length: 256
   - Cutoff: 0.95 × Nyquist
   - Interpolation: Linear
   - Window: Blackman-Harris 2
   - Oversampling factor: 256
4. **Mono mix-down** — all channels are averaged to a single mono signal.
5. **VU energy** — RMS (`Σ s² / N`) is always computed and sent through `level_tx` for the frontend VU meter, regardless of the VAD gate.
6. **VAD gate** — if `energy ≤ vad_threshold`, the chunk is **dropped** (not forwarded). This prevents silent or background-noise frames from consuming CPU in the transcription pipeline. The threshold is adjustable at runtime via the VAD Sensitivity slider in Settings.
7. **Channel send** — passing-chunks go into `active_tx` via `try_send` (non-blocking; drops if the receiver is slow).

---

### 4. Three mpsc channels

| Channel | Capacity | Carries | Consumer |
|---|---|---|---|
| `tx` / `rx` | 50 | `Vec<f32>` resampled audio chunks | Main processing loop |
| `error_tx` / `error_rx` | 10 | `String` device error messages | `audio-error` event emitter task |
| `level_tx` / `level_rx` | 50 | `f32` RMS energy | `audio-level` event emitter task |

All three senders are kept alive inside `AudioEngine`. When `stop()` is called, the struct sets all three to `None`, which drops the senders and closes the channels. The receiving loops in `start_session` then exit naturally when `recv()` returns `None`.

---

### 5. Stopping

`stop()` does two things in order:

1. Sets `self.stream = None` — dropping the `Arc<StreamHandle>` stops the CPAL callback thread.
2. Sets all three senders to `None` — closing the channels causes the three receiver loops in `start_session` to drain and exit.

This means `stop_session` never needs to signal a separate shutdown flag; channel closure is the shutdown mechanism.

---

## Processing Loop (`main.rs` — `start_session`)

The processing loop runs as a Tokio task and owns the accumulation buffer.

### Accumulation

Chunks from `rx` are appended to a `Vec<f32>` buffer. The loop continues accumulating until `buffer.len() >= window_size`. `window_size` is read from `transcription_window` (an `Arc<Mutex<usize>>`) on **every iteration**, so the Transcription Window slider in Settings takes effect within one audio cycle without restarting the session.

Default window: 16 000 samples = 1 second. Range: 0.5 s (8 000) to 3 s (48 000).

### Pause mode

When `transcription_paused` is set, the loop drains the buffer down to 500 ms of context and skips inference entirely.

### Transcription — local vs. cloud

**Local mode** (`spawn_blocking`):
```
Whisper  →  text
ONNX embed(text)  →  384-dim vector
detect_verse_hybrid(text, vector)  →  (DisplayItem, confidence)
```

**Cloud mode** (async, runs directly in the Tokio task):
```
cloud::transcribe_cloud(buffer, provider, api_key)  →  text   [HTTP]
spawn_blocking:
  ONNX embed(text)  →  384-dim vector
  detect_verse_hybrid(text, vector)  →  (DisplayItem, confidence)
```

The ONNX embedding always runs locally in a `spawn_blocking` closure regardless of transcription mode, because `Session::run()` is a blocking call.

### Garbage filter

Before emitting, the transcription text is checked against a list of Whisper hallucination tokens:

```
[blank_audio]  [silence]  [music]  [inaudible]  (silence)  [ silence ]
```

Empty strings are also suppressed. Garbage frames are silently discarded.

### Overlap / sliding window

After each inference window, `OVERLAP = 4 000` samples (250 ms) are kept at the front of the buffer to provide Whisper with prior context on the next call. The rest is discarded:

```rust
let remaining = buffer.len().saturating_sub(OVERLAP);
buffer = buffer[remaining..].to_vec();
```

---

## Event flow to the frontend

| Event | Payload | When emitted |
|---|---|---|
| `audio-level` | `f32` RMS energy | Every resampled batch from CPAL |
| `audio-error` | `String` message | On CPAL stream error |
| `session-status` | `{ status, message }` | On start / loading / running / stopped / error |
| `transcription-update` | `{ text, detected_item, confidence, source }` | After each inference window (non-garbage only) |

---

## Data sizes at 16 kHz mono f32

| Duration | Samples | Bytes (f32) |
|---|---|---|
| 250 ms (overlap) | 4 000 | 16 KB |
| 500 ms (drain keep) | 8 000 | 32 KB |
| 1 s (default window) | 16 000 | 64 KB |
| 2 s | 32 000 | 128 KB |
| 3 s (max window) | 48 000 | 192 KB |

---

## Tauri commands

| Command | Effect |
|---|---|
| `start_session` | Starts CPAL stream, spawns processing loop |
| `stop_session` | Calls `audio.stop()`, clears `is_running` flag |
| `get_audio_devices` | Returns list of input device names |
| `set_audio_device(name)` | Selects device; restarts stream if session is active |
| `set_vad_threshold(value)` | Updates `vad_threshold` live; no session restart needed |
| `set_transcription_window(samples)` | Updates window size live; takes effect next cycle |
| `set_transcription_paused(paused)` | Enables/disables inference without stopping the stream |
