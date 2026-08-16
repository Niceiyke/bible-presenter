# TODO — NDI support (Phase 8)

Status legend: `[ ]` todo · `[x]` done · `[b]` blocked (needs an action only the
operator can take)

The scaffold (committed `7feae56`) is live: `StreamDestination.mode`/`StreamPlatform`
accept `"ndi"`, an NDI preset exists, `src-tauri/src/commands/ndi.rs` exposes
`ndi_status`/`ndi_start`/`ndi_send`/`ndi_stop`, the `ndi` cargo feature is declared,
`useNdiSender` encodes H.264 Annex-B and calls the send commands, and the
`ndiAvailable` capability gates NDI cards in the Streaming hub + Diagnostics.
The SDK-gated sender/input pipelines below are NOT implemented.

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
- [ ] Re-run the check below; `ndi_status` should then report SDK present on the
      dev machine.

---

## 1. NDI output — real SDK sender

- [ ] Add `grafton-ndi` as an optional dependency wired to the `ndi` cargo feature
      (`Cargo.toml`).
- [ ] `ndi_status` (`#[cfg(feature = "ndi")]` in `commands/ndi.rs`): real probe —
      `NDIlib_initialize`, `NDIlib_is_supported_CPU`, SDK version + license age
      (<30 days at release). This is what flips `ndiAvailable` on.
- [ ] `AppState.ndi`: `HashMap<String, NdiSession>` keyed by `session_id` (mirror
      `AppState.rtmp`).
- [ ] `ndi_start(session_id, name)`: `NDIlib_send_create_v2` announcing
      `Wordlyte – <name>`, an `NDIlib_avsync_create`, store the session.
- [ ] `ndi_send(session_id, data_base64)`: decode Annex-B access units →
      `NDIlib_avsync_video` → `NDIlib_send_send_video_async_v2` (NDI|HX; avsync
      derives PTS from the reference clock).
- [ ] `ndi_stop(session_id)`: destroy avsync + sender; idempotent (unknown session
      = no-op, matching `rtmp_stop`).
- [ ] Build + verify: `cargo check --features ndi`, `cargo clippy --all-targets`,
      `cargo test`, `npm run build`, `npx vitest run`.
- [ ] End-to-end: Go Live an NDI destination in the hub, receive in OBS (obs-ndi),
      confirm name/quality.

## 1.1 NDI audio (Phase 8.1)

- [ ] `ndi_send_audio(session_id, data_base64)`: hub shared AAC encode →
      `NDIlib_send_send_audio_v2`.
- [ ] Re-enable the per-card Audio checkbox in `DestinationCard` (currently
      disabled for `ndi` mode) and feed the shared audio track in the hook.

## 1.2 Runtime bundling + attribution (end users download NOTHING)

- [ ] Add `scripts/fetch-ndi.ps1` (mirror `scripts/fetch-ffmpeg.ps1`): downloads
      the current NDI SDK runtime, extracts `Processing.NDI.Lib.x64.dll` into
      `src-tauri/binaries/ndi/`, and prints the SDK build date for the license
      check. Run at each release.
- [ ] Wire `Processing.NDI.Lib.x64.dll` into `bundle.resources` → `bin/`,
      resolved by the binpaths-style lookup (same as ffmpeg).
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

- [ ] `src/system/capabilities.ts` + Diagnostics checklist: `ndiAvailable` already
      plumbed; confirm reason text reflects the real probe result.
- [ ] StreamerTab NDI gating: cards auto-enable when `ndi_status` reports SDK
      present; update the empty-state + footnote text if it still says "SDK required".
- [ ] Update `docs/OUTPUT_MANAGER_DESIGN.md` §9 and `CLAUDE.md` to mark the sender
      + input implemented (replace "scaffold" wording).
