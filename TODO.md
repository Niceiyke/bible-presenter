# TODO — NDI support (Phase 8)

Status legend: `[ ]` todo · `[x]` done · `[b]` blocked (needs an action only the
operator can take)

The SDK-gated Windows NDI video sender is integrated with the shared
capture/Preview→Program transport. The `ndi` cargo feature and
`npm run build:ndi` release flavor require the staged EULA-provided runtime;
Diagnostics and the Streaming Hub gate the destination on a real runtime probe.
NDI audio and NDI input remain separate follow-up work.

Full design: `docs/OUTPUT_MANAGER_DESIGN.md` §9.

---

## 0. SDK setup — developer-only, NOT an end-user step

The church operator installs Wordlyte and NDI just works: the **runtime DLL**
(`Processing.NDI.Lib.x64.dll`) ships inside the installer (see §1.2), so no end
user ever downloads or accepts the SDK. The items below are **our** build-time
steps on the dev machine.

- [b] Developer downloads the NDI 6 SDK from https://ndi.video/for-developers/ndi-sdk/download/
      and accepts the EULA (form-gated — cannot be automated).
- [b] Developer installs to `C:\Program Files\NDI\NDI 6 SDK` (or sets `NDI_SDK_DIR`)
      — only needed to compile/test the sender on this machine.
- [b] Developer installs LLVM/clang for bindgen: `winget install LLVM.LLVM`.
- [x] Re-run the check below; `ndi_status` reports SDK/runtime availability on the
      dev machine.

---

## 1. NDI output — real SDK sender

- [x] Add a strict `ndi` build gate: Windows target, installed SDK (`NDI_SDK_DIR`),
      and a staged runtime DLL are all required before the feature compiles.
- [x] Add `scripts/prepare-ndi.ps1` and `tauri.ndi.conf.json` so the EULA-provided
      runtime can be staged and bundled without committing or downloading it.
- [x] Extend `ndi_status` with compile/runtime diagnostics and a real
      `NDIlib_initialize` + CPU-support probe. This flips `ndiAvailable` on for
      an NDI-enabled build.
- [x] Implement the native sender using the NDI SDK's synchronous video API and
      NV12 frames from the shared capture session.
- [x] Start and stop NDI destinations as part of the Streaming Hub master
      broadcast; mixed RTMP + NDI broadcasts share one capture readback.
- [x] Bundle the staged runtime through `tauri.ndi.conf.json` and provide
      `npm run check:ndi` / `npm run build:ndi` release commands.
- [x] Add `.github/workflows/build-windows-ndi.yml` for a manually triggered
      NDI release on a self-hosted Windows runner with the EULA-accepted SDK.
- [ ] Build + verify: `cargo clippy --all-targets`, `cargo test`, `npm test`.
- [b] End-to-end: Go Live an NDI destination in the hub, receive in OBS (obs-ndi),
      vMix, or ProPresenter, and confirm source name, timing, and quality.

## 1.1 NDI audio (Phase 8.1)

- [ ] `ndi_send_audio(session_id, data_base64)`: hub shared AAC encode →
      `NDIlib_send_send_audio_v2`.
- [ ] Re-enable the per-card Audio checkbox in `DestinationCard` (currently
      disabled for `ndi` mode) and feed the shared audio track in the hook.

## 1.2 Runtime bundling + attribution (end users download NOTHING)

- [ ] Add `scripts/fetch-ndi.ps1` (vendor/EULA distribution policy permitting): downloads
      the current NDI SDK runtime, extracts `Processing.NDI.Lib.x64.dll` into
      `src-tauri/binaries/ndi/`, and prints the SDK build date for the license
      check. Run at each release.
- [x] Wire `Processing.NDI.Lib.x64.dll` into the NDI release config's
      `bundle.resources` → `bin/`, resolved by the binpaths-style lookup.
- [ ] Add NDI® attribution + `https://ndi.video` link in the About box.
- [ ] Release-time license check: fail/skip the release if the bundled DLL's build
      date is older than 30 days (NDI requirement).

---

## 2. NDI input — discovery + receive → camera source

- [ ] Backend `ndi_list_sources`: `NDIlib_find_create_v2` discovery returning
      NDI|HX sources (name, address, H.264/HQ capability).
- [ ] Backend `ndi_receive_start(session_id, source)` / `ndi_receive_stop(session_id)`:
      `NDIlib_recv_create_v2` with `NDIlib_recv_bandwidth_lowest` (NDI|HX first —
      H.264 packets match the WebCodecs pipeline).
- [ ] Backend `ndi_receive_pull(session_id)`: `NDIlib_recv_capture_v2` H.264 access
      units streamed to the frontend (event or poll).
- [ ] Frontend `useNdiReceiver`: decode access units with WebCodecs `VideoDecoder`,
      feed frames into a `VideoTrackGenerator` so the feed presents as a normal
      `MediaStreamTrack`.
- [ ] Surface NDI sources in the Camera tab / zone sources like native cameras
      (stage/Go Live); device ids are synthetic — must never go to `getUserMedia`.
- [ ] Full-bandwidth (non-HX) NDI: backend re-encode to H.264 + faster pipe
      (raw 1080p30 ≈ 380 MB/s over IPC is too heavy) — defer until a segment needs it.

---

## 3. Cross-cutting cleanup (after 1+2 land)

- [x] `src/system/capabilities.ts` + Diagnostics checklist: `ndiAvailable` already
      plumbed; confirm reason text reflects the real probe result.
- [x] StreamerTab NDI gating: cards auto-enable when `ndi_status` reports SDK
      present; update the empty-state + footnote text if it still says "SDK required".
- [ ] Update the output design notes and `CLAUDE.md` to document the sender as
      implemented while keeping NDI input marked as future work.

## 4. Scripture AI roadmap

### 4.1 Offline ASR fallback (planned, feature-sized)

Goal: keep scripture detection working when the operator has no internet or an
ASR provider key is missing/expired — a local engine capturing the same PCM the
cloud providers already receive.

Design sketch (each step independently shippable):

- [ ] **Engine choice**: `whisper.cpp` bindings (`whisper-rs`, MIT) with
      `base.en`/`small.en` quantized model (~80–460 MB), streaming via
      `full_transcribe` on audio chunks; or `vosk` (Apache-2.0, small 40 MB
      models, true streaming + partial results like Deepgram interims).
      Vosk partials map onto the existing interim-evidence pipeline better;
      whisper quality is higher. Benchmark both on sermon audio before choosing.
- [ ] **Model provisioning**: ship nothing in the installer; download on
      demand in the AI settings page (same UX pattern as the semantic `bge`
      model), store under `%LOCALAPPDATA%\io.wordlyte.app\ai\asr\`, verify by
      checksum, keep the existing `Revision`-pinning pattern from
      `semantic_scripture.rs`.
- [ ] **Audio plumbing**: reuse the `program_audio` PCM fan-out (`feed_refcount`
      consumers) instead of capture-style taps; 16 kHz mono s16le is already
      produced by the shared capture — feed the engine in ring-buffer chunks
      with a small VAD gate (energy threshold) so idle pauses are skipped.
- [ ] **Provider integration**: add an `AsrProvider::Local` variant that emits
      the same normalized `Turn` stream; the provider-selection UI lists
      "Offline (local model)" and auto-falls-back when the chosen cloud
      provider is unreachable after N attempts (existing recovery counters).
- [ ] **Feature gating**: license-plan gating consistent with cloud ASR
      (free plan may restrict to the small model or a session length cap).
- [ ] **Eval**: extend `tools/ai-eval` with an ASR-quality fixture set (recorded
      sermon audio → expected transcript excerpts) so the offline engine's
      verse-detection parity is measured, not assumed.

Non-goals: speaker diarization, multi-language ASR, GPU requirements.
