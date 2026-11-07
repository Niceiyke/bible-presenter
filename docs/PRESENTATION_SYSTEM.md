# Presentation System

## Product vision

Wordlyte Presentations is a complete message-production workspace, not a file list or a drawing canvas. It connects five distinct jobs without collapsing their safety boundaries:

1. **Create** — start blank, use a template, generate an AI-assisted draft, or import content.
2. **Structure** — arrange the narrative, slides, Scripture, notes, and reusable layouts.
3. **Design** — edit the visual system and individual elements with predictable inheritance.
4. **Rehearse** — review the deck as an audience will see it and detect projection problems.
5. **Deliver** — add specific slides to a service plan, stage them, and explicitly take them live.

AI and import workflows are authoring tools. They never stage content, send content live, or bypass the normal output command path.

## Experience architecture

### Presentation Workspace

The workspace is the home for all decks. Its hierarchy is deliberately task-oriented:

- **Workspace header** — creation entry points and library health at a glance.
- **Creation launchpad** — blank deck, AI draft, Prayer DOCX, and rendered PowerPoint import.
- **Library controls** — search, sort, grid/list view, and favorites. View preferences persist locally.
- **Deck library** — real cover previews for recent decks, clear metadata, and direct editing.
- **Deck detail panel** — rehearsal-oriented slide strip with explicit Stage, Live, and Service actions.

Selecting a deck is not an output action. Clicking a slide stages it; sending it live remains a separately labeled operator action.

### Slide Editor

The editor follows a stable four-region model:

```text
┌──────────────── presentation command bar ────────────────┐
│ slides │ contextual tools + canvas       │ inspector     │
│ rail   │                                  │ layers/style  │
│        │                                  │ notes/theme   │
└──────────────── status / zoom / warnings ────────────────┘
```

- The slide rail owns sequence and slide-level actions.
- The contextual toolbar changes with selection, avoiding a permanently crowded ribbon.
- The canvas is the visual priority and uses the same canonical renderer as thumbnails and output.
- The inspector owns document structure, theme inheritance, element properties, and notes.
- Preview and Stage are visible in the command bar. Go Live is intentionally not an editor-default action.

The editor also provides deterministic smart layouts, persistent local brand kits, narrative sections, live preflight overlays, private rehearsal mode, and per-slide transition overrides. Each authoring mutation is recorded through normal presentation history; advisory and rehearsal surfaces do not mutate output.

## Software architecture

The presentation system is being separated into four layers:

```text
Presentation UI
  components/presentations/*
  components/editors/slide/*
          ↓
Application workflows
  create / duplicate / import / save / rehearse / stage
          ↓
Presentation domain
  presentations/library.ts
  types/slides.ts
          ↓
Infrastructure
  presentations/repository.ts
  Tauri commands + SQLite/JSON persistence
```

### Domain layer

The domain owns deterministic operations that do not require React or Tauri:

- creating a valid versioned blank presentation
- duplicating decks while regenerating presentation, theme, master, slide, element, and group identities
- filtering and sorting summaries
- validated local workspace preferences
- future validation, diagnostics, and migrations

These operations are unit-testable and must not stage or broadcast output.

### Repository boundary

`PresentationRepository` is the persistence contract:

```ts
interface PresentationRepository {
  list(): Promise<PresentationSummary[]>;
  load(id: string): Promise<CustomPresentation>;
  save(presentation: CustomPresentation): Promise<void>;
  remove(id: string): Promise<void>;
}
```

React components should not embed backend command names. The current implementation uses Tauri; the boundary allows transactional storage, revision history, collaboration, or cloud sync to be introduced later without rewriting the workspace.

### Document model

`CustomPresentation` remains the durable document root:

- versioned presentation
- ordered slides
- presentation theme
- optional reusable masters
- speaker notes
- discriminated background and element unions
- ProseMirror JSON for rich text

Element geometry remains percentage-based so a deck is resolution-independent. Audience rendering uses a reference output height for stable typography and effects.

### Rendering

There must be one visual interpretation of a slide:

- editor canvas
- slide rail thumbnails
- library cover previews
- rehearsal preview
- stage window
- output window

All surfaces use `CustomSlideRenderer` or the shared program surface. Thumbnail systems must not create a second HTML/CSS interpretation of presentation data.

## Design system

Operator chrome uses semantic console tokens, never hard-coded audience-theme colors:

- **canvas / surface / raised surface** establish depth
- **action primary** marks the next constructive operator action
- **tool design** identifies authoring and AI tools
- **state stage** identifies prepared output
- **state live** identifies on-air and destructive actions
- **success / warning / error** communicate system state

Presentation themes belong to audience content and remain separate from the operator UI. Changing the application appearance must never restyle projected slides.

### Interaction rules

- Every important action has a text label, not color or icon alone.
- A 40–44 px target is preferred for primary controls.
- Keyboard focus is always visible.
- Nested actions do not use invalid nested buttons.
- Hover affordances also appear on keyboard focus.
- Destructive actions require confirmation.
- Loading, empty, error, and partial-data states are designed surfaces, not alerts or blank regions.

## Reliability and safety

- Autosave and explicit Save & Close remain independent of live output.
- A failed import or AI request cannot alter an existing deck.
- A deck duplicate receives independent mutable identities while media files remain shared references.
- Imported Scripture text is resolved from installed Bible data.
- Stage and Live continue through the authoritative backend presentation path.
- Output hydration and revision behavior remain outside the editor document lifecycle.
- Recent deck covers are warmed with a fixed upper bound; large libraries are not eagerly loaded in full.

## Feature direction

### Quality and rehearsal

- Live preflight currently checks blank slides, missing media, unsafe geometry, small text, and text density, with title/action-safe guides and presentation-wide issue navigation.
- Full-screen rehearsal currently provides keyboard navigation, elapsed time, speaker notes, and next-slide preview without touching stage or live output.
- Future work can add measured DOM overflow, contrast scoring, per-slide rehearsal timing, and confidence-monitor integration.

### Next: reusable systems

- branded theme packs with locked church fonts/colors/logos
- master-layout editor with explicit placeholder contracts
- deck and slide template browser with categories and search
- presentation sections for sermon points, worship, announcements, and response
- bulk theme and layout updates with an impact preview

### Next: workflow and history

- service-plan add for an entire deck or a selected range
- version history, named checkpoints, and restore
- archive, tags, folders/collections, and duplicate detection
- transactional save with optimistic concurrency revision
- portable package export including referenced media and fonts

### Next: assisted authoring

- local projection-readability suggestions
- regenerate or rewrite selected slides with side-by-side approval
- narrative outline view separate from visual canvas
- source/citation tracking for imported notes
- AI actions remain draft-only and always require operator acceptance

## Migration strategy

The redesign is evolutionary:

1. Keep the existing version-2 document shape readable and writable.
2. Move deterministic operations from components into the domain layer.
3. Route persistence through the repository boundary.
4. Add validation and revision metadata without changing render semantics.
5. Introduce new optional fields with migration defaults.
6. Preserve the explicit Stage and Go Live command paths throughout.

This approach modernizes the workflow while protecting existing decks and the production-critical output system.
