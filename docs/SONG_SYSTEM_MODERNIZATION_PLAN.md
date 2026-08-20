# Song System Modernization Plan

Status: Proposed
Owner: Implementation agent
Scope: Song library, hymn library, song editor, import workflow, lyric preview,
  lyrics overlay workflow, full-screen lyric workflow, service integration
Last reviewed: 2026-08-11

## 1. Mission

Modernize the Wordlyte song system so a volunteer can find a song, understand
what it contains, preview it, and prepare it for service without needing to
understand the internal distinction between songs, lower thirds, display items,
and presentation sequences.

The target experience should combine:

- A simple content library.
- A fast structured lyric editor.
- A clear arrangement/setlist builder.
- Full-screen lyric and lyrics-overlay output modes.
- Safe Preview, Stage, Go Live, and Add to Service actions.
- Reliable offline persistence and import recovery.

The song system must remain simpler than the slide editor. Songs are primarily
structured lyric content. They should not become arbitrary presentation decks.

## 2. Non-goals

Do not implement these as part of this modernization:

- Real-time collaboration.
- Cloud song synchronization.
- A full worship planning or church-management system.
- Audio playback, click tracks, or automatic vocal timing.
- A full chord chart editor.
- Automatic lyric timing from audio.
- A second live-output engine.
- A separate song presentation renderer for each workspace.
- A public hymn/template marketplace.

If a feature requires one of these, defer it and preserve the structured song
model.

## 3. Current System Inventory

### 3.1 Frontend entry points

- `src/components/layout/ContentBrowser.tsx` mounts `SongsTab` lazily.
- `src/components/SongsTab.tsx` owns song library display, song editing, import,
  preview, and card-level actions.
- `src/components/LowerThirdTab.tsx` owns lyrics-overlay setup, line navigation,
  quick lyrics, auto-advance, show/hide, and keyboard navigation.
- `src/components/LtDesignerTab.tsx` previews and edits lower-third templates.
- `src/hooks/useItemActions.ts` stages, commits, and advances `Song` display
  items.
- `src/items/registry.tsx` computes song sequence navigation and schedule tiles.
- `src/components/shared/Renderers.tsx` renders full-screen song slides.
- `src/components/PreviewCard.tsx` renders song display-item previews.
- `src/windows/OutputWindow.tsx` renders full-screen songs and lower-third
  overlays.

### 3.2 Shared state

Song state currently lives in the lower-third Zustand slice:

- `songs`
- `hymnLibrary`
- `songSearch`
- `editingSong`
- `songImportText`
- `showSongImport`
- `ltSongId`
- `ltLineIndex`
- `ltLinesPerDisplay`
- `ltAutoAdvance`
- `ltAutoSeconds`

The authoritative persistent library must remain `songs`. Temporary editor,
import, preview, and quick-lyrics drafts should not be stored in the persistent
song collection.

### 3.3 Existing frontend contract

Current TypeScript types are in `src/types/song.ts`:

```ts
interface LyricSection {
  label: string;
  lines: string[];
}

interface Song {
  id: string;
  title: string;
  author?: string;
  copyright?: string;
  ccli?: string;
  sections: LyricSection[];
  arrangement?: string[];
  style?: "FullSlide" | "LowerThird";
  font?: string;
  font_size?: number;
  font_weight?: string;
  color?: string;
}
```

Preserve these existing commands and events:

- `list_songs`
- `save_song`
- `delete_song`
- `get_hymn_library`
- `songs-sync`

Do not rename or remove these contracts without an explicit migration.

### 3.4 Existing Rust persistence

Song persistence is in:

- `src-tauri/src/commands/songs.rs`
- `src-tauri/src/store/media_schedule.rs`
- `src-tauri/src/commands/misc.rs` for the bundled hymn library

The Rust store currently serializes songs as hash-backed JSON. The current Rust
model uses:

- `LyricSection { label, lines }`
- `Song { id, title, author, copyright, ccli, sections, arrangement, style,
  font, font_size, font_weight, color }`

New fields must be optional or have migration defaults so existing song JSON
continues to load.

The display-item contract is separate from song persistence. Audit the Rust
`SongSlideData` used by `DisplayItem::Song` against the frontend
`SongSlideData`. It must carry the same mode and visual fields. In particular,
`style` must survive a Tauri stage/commit round trip so full-screen and overlay
behavior cannot be lost.

## 4. Known Problems To Fix First

### 4.1 Chord import correctness

`src/utils/songImporter.ts` detects ChordPro but can retain chord markers in
the lyric lines. `SongSlideRenderer` renders those lines directly, so imported
markers can appear on the audience output.

Required behavior:

- Never project raw ChordPro markers unless an explicit chord display mode is
  selected.
- Preserve detected key metadata.
- Show an import warning when chords were removed.
- Add a test proving `[G]Amazing grace` becomes `Amazing grace` in the default
  lyric-only import.

### 4.2 Fragile arrangement identity

`arrangement: string[]` references sections by label. Duplicate labels and
repeated sections are ambiguous because consumers use `find` by label.

Required behavior:

- Every section receives a stable id.
- Arrangement steps reference section ids.
- A chorus can be repeated without changing or duplicating the source section.
- Existing label-only arrangements remain loadable.

### 4.3 Quick lyrics is not a song

`LowerThirdTab.tsx` currently inserts a temporary `quick-lyrics` object into the
global `songs` array. This can make the draft appear in song workflows and it
disappears after restart.

Required behavior:

- Quick lyrics is local draft state or a dedicated transient lower-third state.
- It never appears in My Songs.
- It is never persisted unless the user explicitly chooses `Save as Song`.
- It can still be staged and shown immediately.

### 4.4 Missing operation error handling

Song import, save, delete, and hymn-library import currently do not consistently
show failure state or retry actions.

Required behavior:

- Disable the active action while an operation is running.
- Show an inline or toast error with a retry action.
- Do not update the local list until persistence succeeds, unless the optimistic
  update has an explicit rollback.
- Do not close the editor after a failed save.

### 4.5 Inconsistent display actions

Full-screen songs and lyrics-overlay songs currently expose different actions.
Full-screen songs do not receive the same preview path as lower-third songs, and
lower-third songs require a separate `Use (lyrics mode)` action.

Required behavior:

- Every song has `Preview` and `Use`.
- `Use` opens a unified mode choice: `Full-screen lyrics` or `Lyrics overlay`.
- `Stage`, `Go Live`, and `Add to Service` use the canonical item-action flow.

### 4.6 Duplicated sequence logic

Sequence flattening is duplicated in `App.tsx`, `SongsTab.tsx`,
`LowerThirdTab.tsx`, `LtDesignerTab.tsx`, and `items/registry.tsx`.

Required behavior:

- One shared utility defines song sequence order.
- All previews, live actions, schedule navigation, and lower-third controls use
  that utility.

### 4.7 Display-item contract mismatch risk

The frontend `SongSlideData` includes `style`, while the current Rust
`SongSlideData` shape does not. Tauri stage/commit round trips can therefore
drop the distinction between full-screen and overlay songs.

Required behavior:

- Audit TypeScript `SongSlideData`, Rust `SongSlideData`, and
  `DisplayItem::Song` serialization together.
- Add the missing optional Rust field with a serde default if it is not already
  present in the current branch.
- Verify `style`, font, font size, font weight, color, song id, section label,
  slide index, and total slide count survive stage and commit.
- Add a round-trip test for both `FullSlide` and `LowerThird`.
- Ensure output behavior is determined by the authoritative committed item, not
  only by a stale local pre-commit object.

## 5. Target UX

### 5.1 Library workflow

The primary workflow must be:

1. Open `Songs`.
2. Search by title, author, lyric, key, or CCLI number.
3. Select a song card.
4. Click `Preview` or `Use`.
5. Choose `Full-screen lyrics` or `Lyrics overlay`.
6. Review the sequence and current/next content.
7. Preview locally, stage safely, go live explicitly, or add to service.

The operator must not need to navigate manually to `LowerThirdTab` to use a
song as an overlay.

### 5.2 Library layout

```text
+------------------------------------------------------------------------+
| Songs                                      Import       New Song         |
| Search songs, lyrics, author, CCLI...       My Songs | Hymn Library      |
+------------------------------------------------------------------------+
| Filters: All  Full-screen  Overlay  Used recently  Needs metadata       |
+------------------------------------------------------------------------+
| [preview]  Amazing Grace                     Preview  Use  More          |
|            John Newton  |  4 sections       Add to Service              |
|            Full-screen ready | Key: G                                    |
+------------------------------------------------------------------------+
| [preview]  How Great Thou Art                Preview  Use  More          |
|            ...                                                            |
+------------------------------------------------------------------------+
```

Desktop requirements:

- Use a responsive card grid when width allows it.
- Fall back to a readable list at narrow widths.
- Keep important actions visible without hover.
- Use 40-44px controls for primary actions.
- Use minimum 12px body text and minimum 11px secondary text.
- Use a shared `SearchField` instead of a raw input.

### 5.3 Source switcher

Use one segmented control:

- `My Songs` with count.
- `Hymn Library` with count.

Hymn cards must expose:

- Preview.
- Use directly without importing.
- Add to My Songs.
- Add to Service.

Importing a hymn should be an explicit copy operation. It should create a new
id and never overwrite a user song.

### 5.4 Song card

Every song card should show:

- A small lyric preview rendered by `SongSlideRenderer` or a shared preview
  renderer.
- Title.
- Author when available.
- Section count and lyric-line count.
- Key when available.
- CCLI/copyright metadata status.
- Source badge.
- Default output-mode badge.

Primary card actions:

- `Preview`
- `Use`
- `Add to Service`

Secondary actions in a visible More menu:

- `Edit`
- `Duplicate`
- `Add to My Songs` for hymns
- `Delete` for user songs

Do not expose different action vocabularies based on source. Source changes
which secondary actions are available, not the meaning of the primary flow.

### 5.5 Unified Use panel

`SongUsePanel` should be a modal or full-height workspace with:

- Song title and author.
- Mode selector:
  - `Full-screen lyrics`
  - `Lyrics overlay`
- Sequence editor or read-only sequence summary.
- Current item preview.
- Up Next preview.
- Current position, for example `Chorus 2 of 8`.
- `Preview`.
- `Stage`.
- `Go Live`.
- `Add to Service`.
- `Previous` and `Next`.
- `Hide Overlay` when overlay mode is active.

Safety rules:

- Preview never calls a Tauri stage or live command.
- Stage only calls the existing staging action.
- Go Live only commits a successfully staged item.
- Save and edit operations never change live output.
- Lower-third show/hide errors remain visible to the user.

## 6. Target Data Model

### 6.1 Frontend types

Add stable section identity and optional metadata while keeping legacy fields
temporarily available:

```ts
export interface LyricSection {
  id?: string;
  label: string;
  lines: string[];
}

export interface SongArrangementStep {
  section_id: string;
}

export interface Song {
  id: string;
  title: string;
  author?: string;
  copyright?: string;
  ccli?: string;
  key?: string;
  sections: LyricSection[];

  // Legacy field. Read during migration and write during the compatibility
  // window so old consumers remain loadable.
  arrangement?: string[];

  // New canonical arrangement. Optional until migration is complete.
  arrangement_steps?: SongArrangementStep[];

  // Optional schema marker for future migrations.
  schema_version?: number;

  // Existing display defaults. Keep for compatibility.
  style?: SongStyle;
  font?: string;
  font_size?: number;
  font_weight?: string;
  color?: string;
}
```

Do not require `id` on `LyricSection` in the first deserialization pass. Legacy
JSON must load, be normalized in memory, and be assigned ids before the next
successful save.

### 6.2 Rust types

Extend the Rust structs with optional fields:

- `LyricSection.id: Option<String>` with `#[serde(default)]`.
- `Song.key: Option<String>` with `#[serde(default)]`.
- `Song.arrangement_steps: Option<Vec<SongArrangementStep>>` with
  `#[serde(default)]`.
- `Song.schema_version: Option<u32>` with `#[serde(default)]`.

Add:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SongArrangementStep {
    pub section_id: String,
}
```

Keep `arrangement: Vec<String>` for at least one compatibility cycle. New
saves should write both fields:

- `arrangement_steps`: canonical ids.
- `arrangement`: labels for old readers.

Do not remove the legacy field until all known consumers use
`arrangement_steps` and a migration decision is recorded.

### 6.3 Song normalization

Create `src/utils/song.ts` with these functions:

```ts
normalizeSong(song: Song): Song
getSongSections(song: Song): LyricSection[]
getSongSequence(song: Song): LyricSection[]
flattenSongLyrics(song: Song): SongLine[]
getSongSection(song: Song, sectionId: string): LyricSection | null
buildSongDisplayItem(song: Song, index: number, mode?: SongStyle): DisplayItem
getNextSongIndex(song: Song, index: number): number | null
getPreviousSongIndex(song: Song, index: number): number | null
getSongCounts(song: Song): { sections: number; sequence: number; lines: number }
```

`SongLine` should include:

```ts
interface SongLine {
  text: string;
  sectionId: string;
  sectionLabel: string;
  sequenceIndex: number;
  lineIndex: number;
}
```

Sequence rules:

- If `arrangement_steps` exists, use it.
- Otherwise convert legacy `arrangement` labels to section ids.
- If no arrangement exists, use sections in source order.
- Skip missing section ids and return a warning from normalization diagnostics.
- Never use `Array.find` by label for canonical navigation.

### 6.4 Legacy migration

Implement `normalizeSong` as a pure function and test it thoroughly.

Migration steps:

1. Deep-clone the input.
2. Ensure `sections` is an array.
3. Assign an id to each section without an id.
4. Preserve existing section labels and lines exactly.
5. If `arrangement_steps` exists, validate ids against sections.
6. If only legacy `arrangement` exists, map each label to a matching section.
7. For repeated labels, consume matching sections in occurrence order.
8. If a label cannot be resolved, omit it and record a warning.
9. If there is no arrangement, generate natural-order steps in memory.
10. Set `schema_version` to the current frontend schema version in memory.
11. Save the canonical arrangement only on successful save.

The migration must not silently delete lyric lines or sections.

## 7. Import Behavior

### 7.1 Supported formats

Retain:

- Plain text.
- Section-labeled text.
- ChordPro.
- OpenLyrics.

### 7.2 Parser changes

Refactor `src/utils/songImporter.ts` so parser results include diagnostics:

```ts
interface ParsedSong {
  title: string;
  author?: string;
  copyright?: string;
  ccli?: string;
  key?: string;
  sections: { label: string; lines: string[] }[];
  format: DetectedFormat;
  warnings: string[];
  chordsDetected: boolean;
}
```

Required parser behavior:

- ChordPro metadata fields map to title, author, copyright, CCLI, and key.
- Chord markers are removed from default lyric lines.
- Empty chord-only lines are not emitted as lyric lines.
- OpenLyrics parse errors return a readable failure instead of an empty song.
- Section-labeled parsing either implements author/copyright/CCLI parsing or
  stops declaring unused metadata variables.
- Plain text uses the first meaningful line as title and keeps the remaining
  lines in a single section.
- Empty imports do not create a song.

Do not add chord rendering yet. If chord support is added later, store chords as
structured optional data and make `Show chords` an explicit user choice.

### 7.3 Import wizard

Create `src/components/songs/SongImportWizard.tsx` with these steps:

1. Input.
2. Detected format and metadata.
3. Parsed section preview.
4. Metadata correction.
5. Import confirmation.

The wizard must show:

- Detected format.
- Number of sections.
- Number of lyric lines.
- Whether chords were detected.
- Which metadata fields are missing.
- Warnings that will affect output.

Import action behavior:

- Disable Import while saving.
- Keep the wizard open after failure.
- Show retry.
- Create a fresh id.
- Normalize the saved song.
- Update local songs only after `save_song` succeeds.
- Emit `songs-sync` after success.

## 8. Editor Implementation

### 8.1 New component structure

Create a focused song component directory:

```text
src/components/songs/
  SongCard.tsx
  SongLibraryToolbar.tsx
  SongFilters.tsx
  SongPreviewModal.tsx
  SongUsePanel.tsx
  SongEditorModal.tsx
  SongMetadataForm.tsx
  SongSectionEditor.tsx
  SongArrangementEditor.tsx
  SongImportWizard.tsx
  SongModePicker.tsx
  SongStatusBadge.tsx
```

Keep `SongsTab.tsx` as the workspace orchestrator, but move large forms and
modals out of it.

### 8.2 Song editor layout

```text
+------------------------------------------------------------------------+
| Cancel | Edit Song: Amazing Grace        Saved             Save Song     |
+------------------------------------------------------------------------+
| Details             | Lyrics sections                    | Preview       |
|                     |                                    |               |
| Title               | Verse 1                            | 16:9 preview  |
| Author              | [multiline editor]                 |               |
| Copyright           |                                    |               |
| CCLI                | Chorus                             |               |
| Key                 | [multiline editor]                 |               |
| Default mode        |                                    |               |
|                     | + Add section                      |               |
+------------------------------------------------------------------------+
```

At narrow widths:

- Preview collapses below the editor.
- Metadata becomes a collapsible section.
- Sections remain full-width.
- The save bar remains visible.

### 8.3 Section editor

Each section uses one multiline textarea, not one input per line.

Controls:

- Section type/label.
- Textarea with one lyric line per line.
- Duplicate.
- Move up.
- Move down.
- Delete.
- Collapse.

On save:

- Split textarea by newline.
- Preserve intentional blank lines only if the output renderer supports them.
- Trim trailing empty lines.
- Preserve internal line order.
- Keep section id stable.

### 8.4 Arrangement editor

Show arrangement as a sequence of steps, separate from source sections.

Controls:

- Add existing section.
- Drag reorder.
- Duplicate a step.
- Remove a step.
- Reset to natural order.
- Clear arrangement.

Adding a step must not duplicate the source section. Repeating a chorus should
create another arrangement step referencing the same section id.

### 8.5 Styling defaults

Put display styling in a collapsed `Display defaults` section:

- Default mode: Full-screen lyrics or Lyrics overlay.
- Font family.
- Font size.
- Font weight.
- Text color.

Use a live preview to make styling understandable. Do not make volunteers edit
font size before they can save lyrics.

### 8.6 Editor save state

Use an explicit state:

```ts
type SongSaveState = "saved" | "dirty" | "saving" | "save-failed";
```

The editor must:

- Keep a local draft separate from the saved song.
- Mark dirty on every metadata, section, arrangement, and style change.
- Save only when the user clicks Save or when the agreed autosave behavior is
  explicitly implemented.
- Prevent closing with unsaved changes without confirmation.
- Keep the modal open after save failure.
- Show `Saved`, `Unsaved changes`, `Saving`, or `Save failed` as text.

For the first implementation, use explicit `Save Song` rather than introducing
autosave into the song editor. This keeps the workflow simpler than the slide
editor. Add autosave only after explicit save behavior is reliable.

## 9. Preview Implementation

Create `SongPreviewModal` that supports both modes.

### Full-screen preview

- Render `SongSlideRenderer`.
- Show current sequence position.
- Show previous and next controls.
- Show keyboard hints.
- Do not stage or broadcast.

### Lyrics-overlay preview

- Render the same lower-third data shape used by `show_lower_third`.
- Render the selected lower-third template.
- Show current and next lyric lines.
- Show whether the preview is local or on air.
- Do not call `show_lower_third` during preview.

The preview should use the same data conversion as live output. Do not create a
third song-to-lines conversion just for preview.

## 10. Live and Service Integration

### 10.1 Shared display-item builder

Use `buildSongDisplayItem` from `src/utils/song.ts` for:

- Song card Stage.
- Song card Go Live.
- Song preview.
- Song Use panel.
- Service Plan insertion.
- Previous and Next.
- Lower-third lyrics mode.
- Keyboard navigation.

### 10.2 Full-screen mode

Full-screen song display items must continue to render through:

- `SongSlideRenderer` in `Renderers.tsx`.
- `PreviewCard.tsx`.
- `OutputWindow.tsx`.

Verify font, color, weight, section label, author, scaling, and final-slide
behavior across all three locations.

### 10.3 Lyrics-overlay mode

The overlay mode must use the existing lower-third command contract:

- `show_lower_third`
- `hide_lower_third`

Do not add a song-specific output command.

When Go Live commits a lower-third song item:

- Commit only after successful staging.
- Show the lower-third payload.
- Set the selected song and sequence position.
- Show failure if the overlay command fails.
- Do not claim the overlay is visible when the command failed.

### 10.4 Add to Service

`Add to Service` must use the existing `addToSchedule` path from
`useItemActions.ts` and `ContentBrowser.tsx`.

Decide and document one behavior:

- Recommended: add the first song display item, then use canonical `nextLive`
  navigation for the rest of the sequence.

The schedule tile must clearly show the song title, mode, and first section.

### 10.5 LowerThirdTab integration

After `SongUsePanel` exists:

- Keep `LowerThirdTab` for live tool control and manual navigation.
- Remove duplicate song flattening logic.
- Allow it to receive a selected song id from `SongUsePanel`.
- Keep Quick Lyrics as transient state.
- Add `Save as Song` to Quick Lyrics only if explicitly requested.
- Do not make the user switch tabs just to select a song mode.

## 11. Visual Design Rules

Use the existing shared operator design system from `src/index.css` and
`src/components/ui`.

### Colors

- Use `tool.audio` teal for song/music tooling.
- Use `action.primary` amber for primary authoring actions.
- Use `state.stage` cyan for staged/up-next content.
- Use `state.live` red for on-air and destructive actions.
- Use `state.success` green for saved/ready states.
- Keep hymn/source badges neutral or blue-gray.
- Do not use pink as the only song identity color.

### Typography

- Minimum body text: 12px.
- Minimum helper text: 11px.
- Primary actions: 12-13px.
- Use sentence case for labels.
- Avoid dense 8-10px uppercase labels.

### Controls

- Primary buttons: 40-44px high.
- Icon buttons: 40px square with `aria-label`.
- No essential action visible only on hover.
- Use focus-visible outlines.
- Use text plus icon for show/hide/live actions.

### Card layout

- Keep the library calm and neutral.
- Use one consistent card surface.
- Use preview thumbnails as the main visual interest.
- Avoid making every metadata field a colored badge.
- Use spacing and hierarchy before adding color.

## 12. Implementation Phases

Each phase must be implemented and verified before the next phase begins.

### Phase 0: Baseline and fixtures

Goal: establish test data and preserve current behavior.

Tasks:

- Inspect current worktree changes before editing.
- Capture current screenshots at 1280x720 and 1920x1080.
- Create song fixtures for:
  - One-section song.
  - Multiple verses and chorus.
  - Repeated chorus arrangement.
  - Duplicate section labels.
  - Legacy song without ids.
  - ChordPro import.
  - OpenLyrics import.
  - Missing metadata.
  - Empty sections.
- Record current command/event names.
- Record full-screen and overlay output behavior.

Files:

- `src/types/song.ts`
- `src/utils/songImporter.ts`
- `src/components/SongsTab.tsx`
- `src/components/LowerThirdTab.tsx`
- `src/items/registry.tsx`
- `src/hooks/useItemActions.ts`
- `src-tauri/src/store/media_schedule.rs`

Acceptance criteria:

- Fixtures load through the current code.
- Existing song JSON remains readable.
- No command or event names are changed.

Verification:

```bash
npm run test
npm run build
```

### Phase 1: Normalize data and centralize sequence logic

Goal: make section order reliable before changing the UI.

Tasks:

- Add section ids and arrangement-step types.
- Add optional Rust fields with serde defaults.
- Implement `normalizeSong`.
- Implement legacy label-to-id migration.
- Implement `getSongSequence` and `flattenSongLyrics`.
- Replace duplicate flattening logic in all consumers.
- Preserve legacy `arrangement` on save during the compatibility window.
- Add `key` to the frontend and Rust song models.
- Ensure imported and existing songs use normalized data before display.

Suggested files:

- `src/types/song.ts`
- `src/types/index.ts`
- `src/utils/song.ts`
- `src/utils/index.ts` only if exports are centralized there
- `src/items/registry.tsx`
- `src/App.tsx`
- `src/components/SongsTab.tsx`
- `src/components/LowerThirdTab.tsx`
- `src/components/LtDesignerTab.tsx`
- `src-tauri/src/store/media_schedule.rs`

Required tests:

- Legacy songs normalize without losing lines.
- Existing section ids remain stable.
- Duplicate labels map deterministically.
- Repeated chorus steps resolve to the same source section.
- Natural order is used when no arrangement exists.
- Missing arrangement references do not crash navigation.
- Next/previous sequence is identical in Songs, LowerThird, preview, and
  registry consumers.

Acceptance criteria:

- No consumer calls `sections.find` to resolve an arrangement step.
- All song sequence behavior uses the shared utility.
- Existing song JSON loads and saves successfully.

Verification:

```bash
npm run test
npm run build
cd src-tauri
cargo check
cargo clippy
cargo test
```

### Phase 2: Fix import and persistence safety

Goal: prevent bad imports and silent data loss.

Tasks:

- Fix ChordPro lyric stripping.
- Preserve key metadata.
- Add parser diagnostics and warnings.
- Parse or remove unused section metadata variables.
- Add explicit `save_song` operation state.
- Add explicit delete operation state.
- Add error and retry UI.
- Update local arrays only after successful backend operations.
- Emit `songs-sync` only after successful save, import, copy, or delete.
- Replace Quick Lyrics mutation of `songs` with transient draft state.
- Add `Save as Song` for Quick Lyrics only as an explicit action.

Suggested files:

- `src/utils/songImporter.ts`
- `src/components/SongsTab.tsx`
- `src/components/LowerThirdTab.tsx`
- `src/store/slices/lowerThirdSlice.ts`
- `src-tauri/src/store/media_schedule.rs`
- `src-tauri/src/commands/songs.rs`

Required tests:

- Chords never appear in default projected lyrics.
- Key metadata survives import and save.
- Invalid OpenLyrics reports an error.
- Empty import cannot be saved.
- Save failure keeps the editor open.
- Delete failure keeps the card visible.
- Hymn copy creates a fresh id.
- Quick Lyrics is not returned by `list_songs`.

Acceptance criteria:

- No song operation silently fails.
- No temporary quick-lyrics item appears in My Songs.
- Imported lyrics are safe for audience projection by default.

### Phase 3: Build the shared song components

Goal: break the 584-line `SongsTab` into understandable components.

Tasks:

- Create `src/components/songs/`.
- Extract `SongCard`.
- Extract `SongLibraryToolbar`.
- Extract `SongFilters`.
- Extract `SongPreviewModal`.
- Extract `SongEditorModal`.
- Extract `SongImportWizard`.
- Keep orchestration and authoritative list updates in `SongsTab`.
- Keep drafts local to the editor/import components where possible.
- Remove raw hard-coded modal styling in favor of shared UI primitives.

Suggested `SongsTab` responsibilities after extraction:

- Read `songs` and `hymnLibrary`.
- Own source, search, and filter state.
- Own selected song/preview/use state.
- Invoke save/delete/copy actions.
- Update global songs after successful persistence.
- Render the library.

Acceptance criteria:

- `SongsTab` is an orchestrator, not a large form implementation.
- Song cards have one consistent action vocabulary.
- All modal close behavior is keyboard accessible.
- Existing staging and schedule callbacks still work.

Verification:

```bash
npm run test
npm run build
```

### Phase 4: Modernize library UX

Goal: make finding and choosing songs fast.

Tasks:

- Add shared search across title, author, lyrics, key, CCLI, and section labels.
- Add My Songs and Hymn Library counts.
- Add loading and error states.
- Add empty states with clear next actions.
- Add filters for mode, metadata, and recent use where data exists.
- Render lyric preview thumbnails.
- Add direct Use, Preview, and Add to Service actions for hymns.
- Add duplicate for user songs.
- Add confirmation for delete.
- Add source and readiness badges.
- Keep all critical actions visible without hover.

Suggested files:

- `src/components/SongsTab.tsx`
- `src/components/songs/SongCard.tsx`
- `src/components/songs/SongLibraryToolbar.tsx`
- `src/components/songs/SongFilters.tsx`
- `src/components/shared/Renderers.tsx`
- `src/components/ui/*` as needed

Acceptance criteria:

- A volunteer can find a song by title or lyric text.
- A hymn can be used without first copying it.
- A user song can be duplicated without manually re-importing it.
- Empty, loading, and failed states are distinguishable.
- Card action labels are consistent across My Songs and Hymn Library.

### Phase 5: Modernize song editor

Goal: make editing a song faster than editing a slide deck.

Tasks:

- Replace one-input-per-line controls with multiline section editors.
- Add metadata form for title, author, copyright, CCLI, and key.
- Add section type/label controls.
- Add section duplicate, delete, collapse, and reorder.
- Add separate arrangement-step editor.
- Add display-defaults section.
- Add 16:9 full-screen preview.
- Add overlay preview using the selected lower-third template.
- Add explicit Save, Cancel, and unsaved-change confirmation.
- Validate title and at least one non-empty lyric section.
- Keep empty lines and line ordering behavior predictable.

Required tests:

- Textarea conversion preserves line order.
- Empty trailing lines are normalized correctly.
- Section ids remain stable after edits.
- Reordering source sections does not silently change arrangement steps.
- Reordering arrangement steps changes playback order only.
- Save validation prevents invalid empty songs.
- Cancel does not mutate the persistent library.
- Save failure keeps the draft and displays retry.

Acceptance criteria:

- A typical four-section song can be entered without repeated Add Line clicks.
- Arrangement repeats can be created without copying lyric content.
- Users can see the final output while editing.
- Song metadata is available without opening a separate settings screen.

### Phase 6: Build unified Use Song workflow

Goal: remove the split between Songs and Lower Thirds for normal song use.

Tasks:

- Create `SongUsePanel`.
- Add full-screen and overlay mode selection.
- Add sequence review.
- Add current and next preview.
- Add Preview, Stage, Go Live, Add to Service, Previous, Next, and Hide.
- Route all item creation through `buildSongDisplayItem`.
- Route all staging/live actions through `useItemActions` callbacks.
- Preserve lower-third template selection.
- Show operation loading and failure states.
- Keep Preview completely local.
- Make the current position visible in the panel.
- Audit and, if necessary, extend Rust `SongSlideData` so `style` survives
  `stage_item` and `commit_staged`.

Required tests:

- Preview never invokes `stage_item`, `commit_staged`, `show_lower_third`, or
  `hide_lower_third`.
- Stage creates the correct song item and index.
- Go Live cannot commit when stage fails.
- Full-screen output renders only the full-screen mode.
- Overlay output renders only the overlay mode.
- A committed full-screen item still has `style: "FullSlide"`.
- A committed overlay item still has `style: "LowerThird"`.
- Next and previous follow the arrangement steps.
- Hide failure does not claim the overlay is hidden.
- Add to Service uses the shared schedule mutation.

Acceptance criteria:

- A user can use a song without opening the Lower Third tab.
- Preview, Stage, and Go Live are clearly different actions.
- The operator always knows which section is current and which is next.

### Phase 7: Lower-third and designer cleanup

Goal: remove duplicated behavior while preserving advanced lower-third tools.

Tasks:

- Replace local song flattening in `LowerThirdTab` with `songUtils`.
- Replace local song flattening in `LtDesignerTab` with `songUtils`.
- Keep manual lower-third controls for operators who prefer them.
- Receive selected song state from `SongUsePanel` through shared store state.
- Keep Quick Lyrics transient.
- Add `Save as Song` only from an explicit button.
- Standardize lower-third Show/Hide status and failures.
- Ensure template changes do not silently alter a live overlay.
- Keep `ltSongId` and line index synchronized after song updates or deletion.

Acceptance criteria:

- LowerThird and Songs use identical sequence order.
- Deleting the selected song clears or safely resets the selected song state.
- A missing selected song never causes a render crash.
- Live overlay state is visible and truthful.

### Phase 8: Accessibility, performance, and release verification

Goal: finish the system for real operator hardware.

Tasks:

- Add accessible labels to icon controls.
- Ensure keyboard focus is visible.
- Support keyboard navigation of cards and section reorder.
- Add Escape behavior for previews, use panels, editors, and menus.
- Restore focus after modals close.
- Move new strings into i18n dictionaries.
- Measure library performance before adding virtualization.
- Preserve lazy loading of `SongsTab`.
- Avoid rendering full preview trees for cards that are not visible if a real
  performance issue is measured.
- Verify output, stage, and operator rendering separately.

Acceptance criteria:

- The common song workflow works with keyboard only.
- The library remains readable at 150% scaling.
- The song system remains responsive with a realistic library.
- No critical action requires hover.

## 13. Testing Plan

### 13.1 Unit tests

Add focused tests under:

```text
src/utils/__tests__/song.test.ts
src/utils/__tests__/songImporter.test.ts
src/components/songs/__tests__/songEditor.test.tsx
src/components/songs/__tests__/songUsePanel.test.tsx
```

Minimum utility coverage:

- Normalize legacy song.
- Assign missing section ids.
- Map legacy arrangement labels.
- Handle duplicate section labels.
- Resolve repeated arrangement steps.
- Natural section order.
- Flatten lyric lines.
- Count sections, sequence steps, and lines.
- Build first, middle, last, next, and previous display items.
- Handle missing section references.

Minimum importer coverage:

- Plain text.
- Section-labeled text.
- ChordPro metadata.
- ChordPro chord stripping.
- Chord-only line removal.
- OpenLyrics metadata.
- OpenLyrics malformed XML.
- Empty input.
- Parser warnings.

### 13.2 Component tests

Test behavior, not Tailwind class strings:

- Search filters by title and lyric content.
- Source switcher changes the visible collection.
- Hymn Use opens the use panel without copying first.
- User song Delete requires confirmation.
- Save failure keeps the editor open.
- Import failure keeps the wizard open.
- Preview opens for both full-screen and overlay modes.
- Section add/edit/delete works.
- Arrangement reorder works.
- Repeating a section does not duplicate source content.
- Quick Lyrics does not appear in the library.
- Save as Song explicitly creates a persistent song.
- Keyboard Previous and Next follow sequence order.
- Stage failure is visible.
- Preview does not broadcast.

### 13.3 Integration tests

Verify the full frontend action contract:

- `save_song` success updates local songs and emits `songs-sync`.
- `save_song` failure leaves local songs unchanged.
- `delete_song` success removes the song and emits `songs-sync`.
- `delete_song` failure leaves the song visible.
- Hymn copy generates a new id.
- Stage uses `useItemActions.stageItem`.
- Go Live uses `useItemActions.goLive` or `sendLive` transactionally.
- Add to Service uses the shared schedule path.
- Lower-third show/hide errors reach visible UI state.

### 13.4 Rust tests

When Rust types or persistence change, add tests for:

- Legacy song JSON deserialization.
- New song JSON deserialization.
- Optional section id fields.
- Optional key field.
- Optional arrangement steps.
- Save/load round trip.
- Existing `arrangement` compatibility.
- Hymn library loading.
- Fresh id behavior when saving an imported hymn.

Run:

```bash
cd src-tauri
cargo check
cargo clippy
cargo test
```

### 13.5 Manual verification matrix

| Area | Checks |
|---|---|
| Library | My Songs, Hymns, search, filters, empty state |
| Metadata | Title, author, key, copyright, CCLI |
| Editing | Add section, edit lyrics, duplicate, delete, reorder |
| Arrangement | Repeat chorus, reorder steps, reset natural order |
| Import | Plain, sections, ChordPro, OpenLyrics, invalid input |
| Preview | Full-screen, overlay, current, next, previous |
| Production | Preview, Stage, Go Live, Hide, Add to Service |
| Failure | Save, delete, import, stage, show/hide failures |
| State | Selected song deletion, restart, songs-sync |
| Displays | Operator, output, stage windows |
| Hardware | 1280x720, 1920x1080, 125%, 150% scaling |
| Accessibility | Keyboard navigation, focus, Escape, labels |

For each test record:

- Steps.
- Expected result.
- Actual result.
- Screenshot or log for failures.

## 14. AI Agent Execution Protocol

The implementation agent must:

1. Read `CLAUDE.md` before editing.
2. Inspect current files and `git diff` before each phase.
3. Never revert unrelated worktree changes.
4. Preserve command names, event names, and old song JSON compatibility.
5. Use `apply_patch` for manual code edits.
6. Reuse existing shared UI components and design tokens.
7. Keep one canonical song sequence utility.
8. Keep preview separate from stage and live commands.
9. Add tests for every correctness fix.
10. Run `npm run test` and `npm run build` after every frontend phase.
11. Run Rust checks after any Tauri or persistence change.
12. Review the diff for unrelated changes before completing a phase.
13. Test at 1280x720 and 1920x1080 before claiming UI completion.
14. Report skipped tests or known limitations explicitly.

## 15. Definition Of Done

The song modernization is complete when:

- Existing song JSON still loads.
- New songs have stable section identity.
- Repeated arrangement sections work reliably.
- Chord markers cannot accidentally reach audience output.
- Song key metadata is preserved.
- Quick Lyrics is not mixed into the persistent library.
- Save, import, delete, and hymn-copy failures are visible and recoverable.
- My Songs and Hymn Library share one understandable workflow.
- Every song has Preview and Use actions.
- Full-screen and overlay modes are both previewable.
- Stage, Go Live, Hide, and Add to Service are safe and distinct.
- LowerThirdTab and SongsTab use the same sequence logic.
- The song editor uses multiline section editing.
- Arrangement is a separate reorderable sequence.
- The UI is readable at target window sizes and scaling.
- Critical actions are not hover-only.
- Frontend tests pass.
- `npm run build` passes.
- Rust checks pass when Rust code changed.
- Manual production verification is recorded.

## 16. Recommended First Implementation Slice

If implementation must begin with a small, high-value slice, complete these
items first:

1. Create `src/utils/song.ts` and centralize sequence logic.
2. Add section ids and arrangement-step migration.
3. Fix ChordPro stripping and preserve key metadata.
4. Move Quick Lyrics out of `songs`.
5. Add error handling to song save, delete, import, and hymn copy.
6. Add the same Preview action for both song modes.
7. Add tests before redesigning the song editor.

This first slice improves correctness and creates the foundation for the modern
library and unified Use Song workflow without changing the existing output
commands.
