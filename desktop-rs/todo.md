# Bible Presenter — ProPresenter Gap Analysis & TODO

## What's Already Strong
- AI verse detection (live transcription + semantic embedding — better than ProPresenter)
- Multi-version Bible (KJV, AMP, NIV, ESV, NKJV, NASB with stacked embeddings)
- LAN WebRTC cameras (ProPresenter doesn't have this)
- Scene compositor with layered content
- Lower thirds with full template engine
- Remote control via PWA
- Schedule queue + songs + media
- Auto-updater with signed CI releases

---

## Priority TODO List

### P1 — Showstoppers (Must-have to compete)

- [x] **Stage Display Window**
  - Add a third Tauri window (`stage`) showing: next slide preview, upcoming text, clock, operator notes
  - Performers/worship leaders need this — it's ProPresenter's most-used secondary screen feature
  - Fix: New `stage` window label in `tauri.conf.json`; `AppState` tracks `staged_item` already — wire it to the stage window

- [ ] **Multiple Independent Outputs**
  - Current two-window model (`main` + `output`) is hardcoded
  - Professional setups need: FOH screen, stage confidence monitor, lobby/overflow screen, stage display
  - Fix: `AppState` needs `outputs: Vec<OutputConfig>` with per-output content routing; each output window gets its own `DisplayItem` state
  - Note: Significant refactor of the window management model

---

### P2 — High Impact, Low Effort

- [x] **Slide Transitions**
  - Every slide cut is instant — cross-fade, dissolve, fly-in are baseline expectations
  - Fix: CSS/Framer Motion transition system between `liveItem` changes in the output window (pure frontend)

- [x] **Song Arrangement Engine**
  - Songs have sections (`[Verse 1]`, `[Chorus]`) but no *arrangement* per service
  - ProPresenter lets you define `V1 → Ch → V2 → Ch → Bridge → Ch` once and it auto-orders slides
  - Fix: Add `arrangement: Vec<String>` (ordered section labels) to `Song` struct; rendering expands into the right slide sequence

- [x] **Timers / Clocks**
  - Pre-service countdown, segment timers, clock overlays — entirely absent
  - Essential for service coordinators and stage display
  - Fix: New `DisplayItem::Timer` variant + output renderer; Tauri interval or frontend `setInterval` drives it

---

### P3 — High Impact, Medium Effort

- [x] **Library vs. Service Workflow**
  - Current model: add things to a queue. ProPresenter's model: Library (permanent) → pull into Service (per-week)
  - Right now songs/media live in `{app_data}/` with no reuse concept — operators rebuild from scratch every week
  - Fix: Named service plans in `services/{id}.json`; Schedule tab has service switcher + manager popover (rename/delete/new); auto-saves on switch

- [x] **Persistent Props Layer**
  - ProPresenter "Props" = graphics that overlay *across all slide changes* (bugs, lower-third tickers, animated logos)
  - Scene Compositor approximates this but isn't connected to the main output pipeline
  - Fix: `props_layer: Vec<PropItem>` in `AppState`; `PropsRenderer` at z-30 in OutputWindow above all slides; Props tab with image/clock support, position presets, opacity, visibility toggle

- [ ] **PPTX Rendering Fidelity**
  - Current PPTX support parses slide XML in-browser — renders text only, no images/shapes/gradients/animations
  - Fix: LibreOffice headless on the Rust backend to convert PPTX → PNG per slide (only reliable cross-platform approach)

- [ ] **MIDI / OSC Control**
  - ProPresenter is controllable via MIDI foot pedals, OSC from lighting boards, Bitfocus Companion
  - Church AV teams integrate everything — absence is a dealbreaker for technical operators
  - Fix: `midir` crate for MIDI input, `rosc` for OSC UDP listener; map to existing `go_live`, `stage_item` commands

---

### P4 — High Impact, High Effort

- [ ] **Planning Center / CCLI Integration**
  - Most US churches use Planning Center Online for service planning; CCLI SongSelect for licensed lyrics
  - No integration = manual data entry every week
  - Fix: REST client to Planning Center API (OAuth2); CCLI SongSelect API or web scrape fallback

- [ ] **UI Polish Under Pressure**
  - Operator UI is 6,795 lines in a single `App.tsx` — functional but dense
  - Under live conditions (dark room, time pressure) ProPresenter's UX is aggressively optimized: large hit targets, clear staged/live hierarchy, one-click confidence
  - Fix: Component decomposition + UX audit focused on live-use ergonomics; not a feature, a refactor

---

### P5 — Lower Priority / Broadcast Use Cases

- [ ] **Per-Word / Per-Line Text Formatting**
  - Every text zone is uniformly styled — ProPresenter allows per-word color, size, bold
  - Critical for karaoke-style lyric highlighting and scripture emphasis
  - Fix: Replace plain string content with rich text model (`Vec<TextRun>` with per-run style); isolated to `CustomSlide`/lyrics rendering

- [ ] **NDI Output**
  - ProPresenter outputs NDI for professional video switchers (ATEM, Ross, etc.)
  - Fix: `ndi-sdk-rs` wrapper; write output window to NDI stream

- [ ] **RTMP Streaming Output**
  - Direct streaming integration for online services
  - Fix: `ffmpeg` subprocess capturing a virtual framebuffer of the output window

---

## Summary Priority Matrix

| Gap                        | Impact   | Effort     | Priority |
|----------------------------|----------|------------|----------|
| Stage Display              | Critical | Medium     | P1       |
| Slide Transitions          | High     | Low        | P2       |
| Song Arrangements          | High     | Low        | P2       |
| Timers / Clocks            | High     | Low        | P2       |
| ~~Library vs Service model~~| High    | Medium     | P3 ✓     |
| ~~Props Layer~~            | Medium   | Medium     | P3 ✓     |
| Multiple Outputs           | Critical | High       | P3       |
| PPTX rendering (LibreOffice)| Medium  | Medium     | P3       |
| MIDI / OSC                 | Medium   | Medium     | P3       |
| Planning Center integration| High     | High       | P4       |
| UI Polish                  | High     | High       | P4       |
| Per-word formatting        | Low      | High       | P5       |
| NDI / Streaming            | Low      | Very High  | P5       |

---

## Quick Wins to Start (least effort, highest return)

1. Slide transitions — pure CSS/Framer Motion, no backend changes
2. Song arrangement engine — add one field to `Song` struct + frontend reorder UI
3. Timers — new `DisplayItem` variant + frontend clock renderer
4. Stage Display window — Tauri window already understands labels; wire `staged_item` to it
