# Windows Build Troubleshooting & Resolution Log

This document outlines the errors encountered during the transition to the Rust-based Tauri architecture and the steps taken to achieve a successful build on Windows.

## 1. Linker Error: LNK2038 (CRT Mismatch)
### Error
`error LNK2038: mismatch detected for 'RuntimeLibrary': value 'MD_DynamicRelease' doesn't match value 'MT_StaticRelease' in libesaxx_rs-...`

### Cause
A conflict between dependencies on the C Runtime (CRT) library linkage.
- `ort-sys` (ONNX Runtime) was pre-built against the **Dynamic CRT (/MD)**.
- `esaxx-rs` (transitive dependency of `tokenizers`) and other native components were defaulting to the **Static CRT (/MT)**.
- MSVC forbids linking objects using different CRTs because they manage their own heaps separately.

### Solution
Forced all components to use the Dynamic CRT.
1.  **Cargo Configuration:** Created `desktop-rs/src-tauri/.cargo/config.toml` to disable static CRT globally for MSVC targets:
    ```toml
    [build]
    rustflags = ["-C", "target-feature=-crt-static"]
    [env]
    RUSTFLAGS = "-C target-feature=-crt-static"
    MSVC_RUNTIME_LIBRARY = "MultiThreadedDLL"
    CFLAGS = "/MD"
    CXXFLAGS = "/MD"
    ```
2.  **CI Workflow:** Updated `.github/workflows/build-windows.yml` to export these environment variables and set `CMAKE_MSVC_RUNTIME_LIBRARY="MultiThreadedDLL"` to catch CMake-based builds (like `whisper-rs-sys`).
3.  **Crate Type:** Simplified the `[lib]` section in `Cargo.toml` to only produce an `rlib`, reducing complexity for the final binary link step.

---

## 2. CI Failure: Missing Bible Embeddings
### Error
`CRITICAL: embeddings.npy missing!` in GitHub Actions logs.

### Cause
The CI script was looking for the pre-calculated vector embeddings in `backend/bible_data/`, but they were stored in the original Electron project path: `desktop/src/core-engine/bible_data/`.

### Solution
Updated the sync step in the CI workflow to pull the file from the correct directory:
```yaml
if [ -f "desktop/src/core-engine/bible_data/embeddings.npy" ]; then
   cp -f "desktop/src/core-engine/bible_data/embeddings.npy" "desktop-rs/src-tauri/bible_data/embeddings.npy"
```

---

## 3. Compilation Error: AppState Thread Safety
### Error
`error[E0277]: *mut () cannot be sent between threads safely` and `no field ... on type State<'_, AppState>`.

### Cause
Tauri commands run on a thread pool. The `AppState` struct was being managed directly, but its contents (specifically the Mutex-wrapped engines) and the way Tauri's `State` wrapper was used didn't satisfy thread-safety requirements.

### Solution
1.  **Arc Wrapping:** Wrapped `AppState` in an `Arc` when initializing in `main.rs` via `app.manage(Arc::new(AppState { ... }))`.
2.  **Signature Update:** Updated command signatures to use `State<'_, Arc<AppState>>`.
3.  **Type Inference:** Added explicit type annotations to `map_err` closures (e.g., `|e: anyhow::Error|`) to help the compiler resolve error types in async blocks.

---

## 4. Async State Management (Send/Sync)
### Error
Persistent `!Send` errors when using `State` across `.await` points.

### Cause
Tauri's `State` wrapper is a reference-like type. Holding it across an `.await` point in an `async` function forces the compiler to ensure the entire `State` wrapper is `Send`, which can fail if the inner type has complex safety requirements.

### Solution
Implemented an "Extract and Drop" pattern in `start_session`:
```rust
async fn start_session(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let engine = state.engine.clone(); // Clone inner Arcs
    let audio = state.audio.clone();
    drop(state); // Explicitly drop the State wrapper before any .await
    
    // Perform async work with the clones...
}
```

---

## 5. cpal::Stream !Send Wrapper
### Error
`AudioEngine` cannot be sent between threads because `cpal::Stream` contains a raw pointer (`*mut ()` for WASAPI handles).

### Cause
On Windows, `cpal` marks the `Stream` as `!Send` and `!Sync` due to platform implementation details.

### Solution
Created a thread-safe newtype wrapper with an `unsafe` implementation of `Send` and `Sync`.
```rust
struct StreamHandle(cpal::Stream);
unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}
```
This is safe in this architecture because the `StreamHandle` is stored inside an `Option<Arc<StreamHandle>>` which is itself behind a `parking_lot::Mutex` in the `AppState`, guaranteeing synchronized access across threads.
