# Fixes & Improvements

This directory contains the fixed Rust version of the Bible Presenter.

## Changes Made
1.  **Audio Device Selection**: 
    - Added `get_audio_devices` and `set_audio_device` commands.
    - Updated frontend to allow selecting the input device.
    - Fixed `AudioEngine` to support device selection.
2.  **Window Management**:
    - Added `toggle_output_window` command.
    - Added "TOGGLE OUTPUT" button in the frontend.
3.  **Robust Startup**:
    - The app no longer panics if AI models are missing (it logs a warning).
    - `start_session` will return a helpful error if models are not loaded.
4.  **Database Compatibility**:
    - Fixed `store/mod.rs` to query the `verses` table instead of `bible`.

## Troubleshooting

### Missing DLLs (MSVCP140.dll, VCRUNTIME140.dll)
If you encounter errors saying these DLLs were not found when running the Windows version:
1.  **Issue**: The app is dynamically linked and needs the C++ runtime.
2.  **Fix**: Install the **Microsoft Visual C++ Redistributable for Visual Studio 2015, 2017, 2019, and 2022**.
    - Download: [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)

### App Exits/Crashes at Startup
If the application exits unexpectedly after opening:
1.  **Check Logs**: Look for `app.log` in your local app data directory:
    - `C:\Users\<YourUsername>\AppData\Local\com.biblepresenter.rs\logs\app.log`
2.  **Common Causes**:
    - Missing models in `src-tauri/models/`.
    - Database file `bible.db` is locked or corrupted.
    - No audio input devices found.

## Setup Instructions

### 1. AI Models
The application requires AI models to function. These are **not** committed to the repo.
You must manually place them in `src-tauri/models/`:

- `whisper-base.bin`: The GGML/GGUF Whisper model.
- `all-minilm-l6-v2.onnx`: The ONNX version of the embedding model.
- `tokenizer.json`: The tokenizer file (already present).

**If you have the Python version set up:**
You might need to convert the `safetensors` model to ONNX or download a pre-converted one.

### 2. Database
Ensure `src-tauri/bible_data/bible.db` exists and has the `verses` table populated.

## Running
```bash
npm install
npm run tauri dev
```
