# Slide Editor Modernization Plan

Status: Proposed
Owner: Implementation agent
Scope: The authoring experience opened from `StudioTab` through `SlideEditor`
Last reviewed: 2026-08-11

## 1. Mission

Modernize the Wordlyte slide editor so a volunteer can create a clean slide
quickly, while an experienced operator can author, review, stage, and present
without leaving the safe Wordlyte workflow.

The target is not a clone of PowerPoint or Canva. The target is the useful
middle ground:

- PowerPoint-level slide organization, alignment, selection, and keyboard use.
- Canva-level templates, visual feedback, media handling, and simplicity.
- Wordlyte-level Bible insertion, service planning, stage/output separation,
  offline behavior, and production safety.

The existing renderer, Tiptap text editor, TypeScript slide model, Zustand
store, Tauri commands, and persisted presentation format are valuable assets.
Keep them unless a concrete correctness problem requires a change.

## 2. Non-goals

Do not build these in this modernization pass:

- Real-time collaboration or cloud documents.
- A full PowerPoint file importer/exporter.
- A freeform vector illustration or SVG path editor.
- A complex animation timeline.
- Charts, tables, diagrams, or spreadsheet-style authoring.
- A public template marketplace.
- A second rendering engine for the editor.
- A new frontend state library.

If a proposed change requires one of these, defer it and preserve the current
simple document model.

## 3. Current Architecture

### 3.1 Entry points

- `src/App.tsx` lazy-loads `SlideEditor` when a presentation is opened.
- `src/components/StudioTab.tsx` lists presentations, loads slide data, and
  exposes editing and presentation actions.
- `src/components/editors/SlideEditor.tsx` composes the editor shell.
- `src/components/editors/slide/useSlideEditor.ts` owns editor state and
  mutation handlers.
- `src/components/shared/Renderers` renders slides for the editor, thumbnails,
  stage, and output.

### 3.2 Existing editor components

- `slide/AppHeader.tsx`: title, close, undo, redo, import, export, save.
- `slide/SlideListPanel.tsx`: slide thumbnails, pointer reordering, add slide.
- `slide/EditorToolbar.tsx`: insert and contextual formatting controls.
- `slide/SlideCanvas.tsx`: 16:9 canvas, renderer, selection overlays, handles.
- `slide/PropertiesPanel.tsx`: slide, element, theme, notes, template, and
  master controls.
- `slide/SlideEditorModals.tsx`: templates, media pickers, Bible picker, and
  unsaved confirmation.
- `slide/InlineTextEditor.tsx`: Tiptap editing overlay.
- `slide/useSlideHistory.ts`: local undo/redo snapshots and text coalescing.
- `slide/useAutoSave.ts`: debounced Tauri persistence.
- `slide/useElementDragResize.ts`: pointer drag, resize, rotation, guides, and
  grid snapping.

### 3.3 Persistence contract

The frontend uses `CustomPresentation` and related types in
`src/types/slides.ts`. The Rust side round-trips the document through:

- `src-tauri/src/commands/studio_pres.rs`
- `src-tauri/src/store/media_schedule.rs`

Preserve these command names and event names:

- `list_studio_presentations`
- `load_studio_presentation`
- `save_studio_presentation`
- `delete_studio_presentation`
- `list_slide_templates`
- `save_slide_template`
- `delete_slide_template`
- `studio-sync`
- `studio-slides-sync`

Any data-model change must include a migration path in
`migratePresentation`, preserve old saved presentations, and pass a round-trip
test before the UI is changed.

## 4. Product Principles

1. **Make the common path obvious.** Add slide, choose a layout, edit text,
   add media, preview, stage.
2. **Use progressive disclosure.** Show common controls first. Put advanced
   animation, master, filter, and geometry controls in expandable sections.
3. **Never hide production actions behind hover.** Hover can enhance a control,
   but Preview, Stage, Add to Service, Save, Delete, and Close must be visible
   or keyboard accessible.
4. **Separate authoring from broadcast.** Editing changes the local document.
   Preview does not broadcast. Stage prepares content. Go Live remains an
   explicit operator action outside or alongside the editor.
5. **Make state explicit.** Saving, failure, selection, locked objects, staged
   content, and live content must have text and icon treatment, not color alone.
6. **Prefer reversible actions.** Undo should cover every document mutation.
   Destructive actions need confirmation when they cannot be undone.
7. **Optimize for real hardware.** Support 1280x720, 1920x1080, and 100-150%
   Windows scaling without forcing the operator to use tiny text.

## 5. Target Experience

### 5.1 Primary workflow

The first-time workflow should be:

1. Open `Presentations`.
2. Click `New Presentation`.
3. Choose a starter layout or template.
4. Click a text placeholder and type.
5. Add an image, video, shape, or Bible verse from the insert menu.
6. Use the inspector for precise styling only when needed.
7. Click `Preview` to inspect the current slide without broadcasting.
8. Click `Stage Current Slide` when the slide is ready for service.
9. Close or return to the presentation library with a visible saved state.

Experienced users should also be able to:

- Duplicate a slide with `Ctrl+D`.
- Duplicate an object with `Ctrl+D`.
- Move objects with arrow keys.
- Multi-select with `Ctrl`/`Cmd` click.
- Group with `Ctrl+G` and ungroup with `Ctrl+Shift+G` or the visible action.
- Navigate slides with `PageUp`, `PageDown`, and the slide rail.
- Undo and redo all document changes with `Ctrl+Z` and `Ctrl+Shift+Z`.

### 5.2 Target shell

```text
+------------------------------------------------------------------------+
| Back | Presentation name | Saved | Undo Redo | Preview | Stage | Close  |
+------------------------------------------------------------------------+
| Slides and templates |       Canvas / contextual toolbar       | Inspector|
|                       |                                      |           |
| [thumbnail]           |                                      | Layout    |
| [thumbnail]           |             16:9 slide                | Style     |
| [thumbnail]           |                                      | Text      |
|                       |                                      | Arrange   |
| + Add slide           |       zoom / fit / slide nav          | Motion    |
+------------------------------------------------------------------------+
```

Desktop behavior:

- Left rail: 208-248px, resizable only if simple to implement.
- Center canvas: flexible, always keeps 16:9 aspect ratio.
- Right inspector: 280-320px, collapsible.
- Top bar: 52-60px with visible labels on important actions.
- Contextual toolbar: 44-52px, horizontally scrollable only as a fallback.

Small-window behavior:

- At widths below approximately 1100px, the inspector collapses to a drawer.
- At widths below approximately 900px, the slide rail becomes a drawer or a
  horizontal thumbnail strip.
- The canvas remains the visual priority and must never be squeezed into an
  unreadable fixed-height region.
- Advanced inspector sections can scroll; the top bar and contextual toolbar
  remain visible.

### 5.3 Slide rail

Replace the current dense thumbnail rail with:

- `Slides` heading and slide count.
- A clear `+ Add slide` button with a menu containing:
  - Title slide
  - Title and content
  - Quote
  - Image with caption
  - Announcement
  - Blank
  - From template
- Thumbnail number and optional short slide title.
- Active slide indicated by a cyan/purple border plus an `Editing` label or
  accessible state, not color alone.
- Visible duplicate and delete actions on the active row or through a context
  menu that also works from keyboard.
- Pointer drag reorder plus keyboard move commands.
- Optional slide search only when the deck is large enough to need it.

Do not add a complicated storyboard or timeline. The slide rail is the source
of truth for order.

### 5.4 Canvas

Keep `CustomSlideRenderer` as the visual source of truth. The authoring canvas
must show the same backgrounds, text, shapes, media, fonts, sizing, and object
fit behavior used by output and stage renderers.

Add or preserve:

- Fit, 50%, 75%, 100%, and custom zoom controls.
- Centered 16:9 canvas with a neutral work surface.
- Optional grid, smart guides, and snap controls.
- Visible selection bounds and handles with a minimum 8px hit area.
- Rotation handle with an accessible numeric rotation field in the inspector.
- Clear locked-object treatment.
- Text editing on double click or Enter.
- Empty-canvas click to clear selection.
- Slide previous/next navigation that does not accidentally mutate content.

Do not render a second approximation of the slide for editing. If the editor
and output disagree, fix the shared renderer or its inputs.

### 5.5 Contextual toolbar

When nothing is selected, show:

- Add text
- Add media
- Add shape
- Add Bible verse
- Layout
- Background

When one text object is selected, show the most common text controls:

- Font family
- Font size
- Bold, italic, underline
- Text color
- Alignment
- More text settings

When an image or video is selected, show:

- Replace media
- Crop/fit
- Opacity
- More media settings

When multiple objects are selected, show:

- Group / ungroup
- Align
- Distribute, if implemented correctly
- Duplicate
- Delete

Controls that do not fit should move into the inspector, not shrink the toolbar
below readable sizes.

### 5.6 Inspector

Replace the current five equal-width tabs with a vertical inspector using
collapsible sections. The selected object should automatically open the most
relevant section, but users must be able to open another section without the
selection changing.

Recommended sections:

#### Layout

- X, Y, width, height.
- Lock aspect ratio where applicable.
- Rotation.
- Flip horizontal / vertical.
- Alignment to slide.
- Z-order.
- Lock object.

#### Style

- Fill or background.
- Border and radius.
- Opacity.
- Shadow.
- Image/video fit and focal position.

#### Text

- Font family, size, color.
- Paragraph alignment and vertical alignment.
- Line height and spacing.
- Auto-size: fixed, shrink, grow.
- Paragraph styles.

#### Motion

- None, fade, slide, zoom.
- Duration and delay.
- A small `Play animation` preview action.

#### Slide

- Background.
- Theme and layout.
- Speaker notes.
- Save as template.

#### Advanced

- Master layout.
- Raw/legacy migration diagnostics only if needed.

Do not use browser `window.prompt` for names. Use the existing modal pattern or
a small reusable text-input modal.

## 6. Visual Design System

### 6.1 Tokens

Use the existing semantic operator tokens from `src/index.css` and the
modernization plan. Do not introduce another color system inside the editor.

Use these meanings consistently:

- `tool.design`: presentation authoring accent, currently purple.
- `action.primary`: primary authoring action, currently amber.
- `state.stage`: staged/up-next state, cyan.
- `state.live`: on-air or destructive action, red.
- `state.success`: saved and confirmed state, green.
- `state.warning`: unsaved or attention state, amber.
- `focus.ring`: keyboard focus, cyan.

Audience slide colors remain in `SlideTheme` and must not use operator-console
tokens. A purple editor button must not cause a purple projected slide.

### 6.2 Surface hierarchy

Use a neutral blue-black foundation:

- Application canvas: `console.canvas`.
- Panels: `console.surface`.
- Raised controls and menus: `console.surfaceRaised`.
- Hover and selected surfaces: `console.surfaceStrong`.
- Borders: `console.border` and `console.borderStrong`.

Do not give every panel a different saturated color. Use borders, spacing,
labels, and icons to establish hierarchy.

### 6.3 Typography

- Body text: minimum 12px in the editor.
- Secondary text: minimum 11px when readable at 1280x720.
- Important action labels: 12-13px.
- Section headings: 11-12px, sentence case where possible.
- Avoid all-caps labels except short state badges such as `ON AIR`.
- Do not use Slate 600/700 for information users must read.

### 6.4 Controls

- Important buttons: at least 40px high; primary actions preferably 44px.
- Icon-only buttons: 40-44px square with `aria-label` and tooltip.
- Every selected/active state uses at least two signals: color plus border,
  icon, text, or position.
- All controls need `:focus-visible` styling using the shared focus token.
- Use the shared UI primitives where possible: `Button`, `IconButton`, `Panel`,
  `SectionHeader`, `ConfirmModal`, `SaveStatus`, and `PreviewSurface`.

### 6.5 Motion

- Use short 120-180ms transitions for panels and selection feedback.
- Do not animate the canvas or slide rail during ordinary editing.
- Respect reduced-motion preferences where feasible.
- Presentation entrance animation belongs to the slide model and preview/output,
  not to editor chrome.

## 7. State and Correctness Contract

This section is mandatory. Visual work must not begin until these invariants
are implemented and tested.

### 7.1 Dirty state

Every document mutation must mark the document dirty:

- Presentation name changes.
- Slide add, duplicate, delete, and reorder.
- Element add, edit, duplicate, delete, group, and ungroup.
- Drag, resize, rotate, align, z-order, and nudge.
- Background, theme, notes, master, template, and animation changes.
- Importing a presentation.

The dirty state must be owned by the editor controller, not inferred from
whether undo or redo was used.

Use an explicit state model:

```ts
type EditorSaveState =
  | "saved"
  | "dirty"
  | "saving"
  | "save-failed";
```

The UI must display the state as text and not only as a dot.

### 7.2 Autosave

Autosave must satisfy all of these rules:

- Save after a debounce period, for example 1500-3000ms.
- Save the latest presentation snapshot, not an outdated closure.
- If a mutation occurs while a save is in flight, do not clear dirty state
  until the newer revision is also persisted.
- If a save fails, stay in `save-failed`, retain dirty state, show an actionable
  error, and allow retry.
- Do not start unlimited overlapping saves.
- Closing while saving must wait for success, offer retry, or explicitly offer
  discard. It must never silently discard a pending save.
- Autosave and manual save must use the same persistence function.

Recommended implementation shape:

- Maintain a monotonically increasing local revision.
- Capture `{ revision, presentation }` when a save begins.
- On success, clear dirty state only if the saved revision equals the current
  revision. Otherwise schedule/save the latest revision.
- Keep the Tauri command contract unchanged.

### 7.3 Undo and redo

- Every user-visible document mutation creates one logical history entry.
- Pointer drag and resize create one entry on pointer-up, not one per frame.
- Consecutive text typing in one editing session is coalesced.
- Undo after autosave changes only the local document and marks it dirty again.
- Redo after a new mutation clears the redo branch.
- Selection changes, tab changes, zoom changes, and preview visibility do not
  create document history entries.
- Import should create one history entry or intentionally reset history with a
  clear user-facing explanation.

### 7.4 Master routing

When editing a master, every element mutation must target the master:

- Move, resize, rotate, align, z-order, group, ungroup, duplicate, delete,
  lock, style, and animation.
- Slide-only actions such as notes must remain unavailable or clearly target a
  dependent slide.
- Applying a master to a slide must be one atomic history entry.
- Master cascade changes must preserve dependent slide text content.
- Deleting a master must either detach dependent slides safely or require a
  clear confirmation explaining the result.

Add tests for each operation rather than assuming the shared handler covers it.

### 7.5 Broadcast separation

- `Preview` renders locally and never calls `stage_item`, `commit_staged`, or a
  live-output command.
- `Stage Current Slide` stages only the selected slide and reports failure.
- `Go Live` must remain an explicit action and must not happen on editor save.
- `Add to Service` adds the presentation slide through the existing schedule
  mutation path.
- The editor must visibly distinguish `Preview`, `Staged`, and `On Air`.

## 8. Implementation Phases

Each phase is independently verifiable. Do not combine a persistence phase
with a broad visual refactor in one change.

### Phase 0: Baseline and contract

Goal: establish a safe baseline before changing behavior.

Tasks:

- Read and preserve `CLAUDE.md` requirements.
- Capture screenshots at 1280x720, 1920x1080, 125%, and 150% scaling.
- Record the current editor flows for new, edit, save, autosave, close, import,
  export, preview, stage, and delete.
- Inventory all mutations in `useSlideEditor.ts`.
- Identify all callers of `CustomPresentation`, `CustomSlide`, and
  `SlideElement`.
- Record current presentation JSON fixtures, including legacy documents.
- Confirm whether current local changes exist before editing.

Files to inspect:

- `src/components/editors/SlideEditor.tsx`
- `src/components/editors/slide/useSlideEditor.ts`
- `src/components/editors/slide/useSlideHistory.ts`
- `src/components/editors/slide/useAutoSave.ts`
- `src/types/slides.ts`
- `src/utils/index.ts`
- `src-tauri/src/store/media_schedule.rs`

Acceptance criteria:

- A baseline screenshot and manual test record exists.
- Existing presentation files load before and after the phase.
- No persisted command or event names are changed.

Verification:

```bash
npm run test
npm run build
```

### Phase 1: Correctness and persistence safety

Goal: make editing trustworthy before modernizing the visuals.

Tasks:

- Refactor dirty tracking so all `setPres` mutations mark dirty.
- Route presentation name changes through the same mutation path.
- Add explicit `EditorSaveState` and expose it from `useSlideEditor`.
- Refactor `useAutoSave` to use revision-aware saves.
- Add save failure and retry behavior.
- Prevent close/discard from bypassing an active save.
- Ensure manual Save and autosave share one save function.
- Fix master-mode routing for align, z-order, grouping, duplication, deletion,
  movement, resizing, and rotation.
- Make master application one history transaction.
- Replace `window.prompt` used for master names with a modal.
- Ensure imports mark dirty and are undoable or explicitly reset history.
- Keep the existing backend command contract.

Suggested files:

- `src/components/editors/slide/useSlideHistory.ts`
- `src/components/editors/slide/useAutoSave.ts`
- `src/components/editors/slide/useSlideEditor.ts`
- `src/components/editors/slide/SlideEditor.tsx`
- `src/components/editors/slide/AppHeader.tsx`
- `src/components/editors/slide/PropertiesPanel.tsx`
- New: `src/components/editors/slide/EditorSaveStatus.tsx`
- New or existing shared modal component for text input

Required tests:

- `useSlideHistory` marks all mutation paths dirty through the controller.
- Name edits trigger dirty state and autosave.
- Save success changes `saving` to `saved`.
- Save failure changes `saving` to `save-failed` and preserves dirty state.
- A newer edit during an in-flight save is saved after the older snapshot.
- Close while saving does not silently lose changes.
- Undo after a save returns to dirty state.
- Redo branch is cleared after a new mutation.
- Every master mutation updates the master and not the active slide.
- Applying a master is one undo step.

Acceptance criteria:

- Normal edits always show `Dirty` or `Saving`.
- Closing after an ordinary edit shows the unsaved confirmation.
- Autosave never reports saved while a newer unsaved revision exists.
- A failed save is visible and recoverable.
- No stage or live command runs as a side effect of saving.

Verification:

```bash
npm run test
npm run build
```

### Phase 2: Modern visual foundation

Goal: replace the dense, inconsistent editor chrome without changing the
document model.

Tasks:

- Replace hard-coded editor colors with semantic console and design tokens.
- Introduce a shared editor shell surface and border treatment.
- Increase editor typography to the minimums in Section 6.
- Make important controls at least 40-44px high.
- Add focus-visible states and `aria-label` values to icon-only actions.
- Remove unnecessary uppercase micro-labels.
- Replace hover-only shape and grid menus with click/focus menus.
- Add tooltips that supplement, but do not replace, visible labels.
- Add a clear selected, locked, grouped, staged, and preview state.
- Preserve the separate audience theme styling.

Suggested components:

- `EditorShell`
- `EditorCommandBar`
- `EditorSaveStatus`
- `EditorToolbarButton`
- `EditorSection`
- `EditorMenu`
- `ZoomControls`

Suggested files:

- `src/components/editors/SlideEditor.tsx`
- `src/components/editors/slide/AppHeader.tsx`
- `src/components/editors/slide/components.tsx`
- `src/components/editors/slide/EditorToolbar.tsx`
- `src/components/editors/slide/PropertiesPanel.tsx`
- `src/index.css` only for shared tokens/utilities when necessary

Acceptance criteria:

- The editor looks like one coherent product, not a set of independent dark
  widgets.
- Critical controls are usable without hover.
- Keyboard focus is visible.
- No audience output component imports operator-console tokens.
- The editor remains usable at 1280x720 and 150% scaling.

Verification:

```bash
npm run test
npm run build
```

Manual checks:

- Tab through the top bar, slide rail, toolbar, canvas actions, and inspector.
- Open every menu with keyboard only.
- Confirm no label or action disappears on a small window.

### Phase 3: Rebuild the editor shell

Goal: establish the modern PowerPoint/Canva-style spatial model.

Tasks:

- Refactor the top bar into:
  - Back/close
  - Title
  - Save status
  - Undo/redo
  - Import/export under a secondary menu
  - Preview
  - Stage Current Slide
- Rebuild the slide rail with a clear Add Slide menu.
- Keep pointer drag reorder and add keyboard reorder actions.
- Add active slide context actions: duplicate, delete, move up, move down.
- Keep the center canvas flexible and preserve 16:9.
- Add fit/zoom controls.
- Make the inspector collapsible at smaller widths.
- Keep slide navigation visible but unobtrusive.

Suggested files:

- `src/components/editors/SlideEditor.tsx`
- `src/components/editors/slide/AppHeader.tsx`
- `src/components/editors/slide/SlideListPanel.tsx`
- `src/components/editors/slide/SlideCanvas.tsx`
- `src/components/editors/slide/PropertiesPanel.tsx`
- New: `src/components/editors/slide/EditorCommandBar.tsx`
- New: `src/components/editors/slide/SlideRail.tsx` if extraction improves clarity
- New: `src/components/editors/slide/ZoomControls.tsx`

Acceptance criteria:

- A volunteer can identify the presentation title, save state, slide list,
  canvas, inspector, Preview, and Stage without tooltips.
- Adding and duplicating slides remains one-click or two-click.
- Slide order can be changed by pointer and keyboard.
- The canvas remains readable at 1280x720.
- The inspector can be collapsed without losing document access.

Verification:

```bash
npm run test
npm run build
```

Manual checks:

- New presentation with one slide.
- Add each layout type.
- Duplicate, reorder, and delete slides.
- Close with no changes, with changes, and during save.

### Phase 4: Contextual editing and inspector simplification

Goal: make basic editing fast and advanced editing discoverable.

Tasks:

- Replace the current equal-width inspector tabs with collapsible sections.
- Keep the selected object visible in the inspector heading.
- Add `Layout`, `Style`, `Text`, `Motion`, `Slide`, and `Advanced` sections.
- Move common formatting to the contextual toolbar.
- Keep exact numeric controls in the inspector.
- Add a basic layers list under `Layout` or `Arrange`.
- Show object type and optional generated name, for example `Text 1` or
  `Image 2`.
- Support selecting, locking, hiding, renaming, and z-ordering from the layer
  list where the data model supports it.
- Do not add a second selection source that can disagree with canvas selection.
  The controller must own one authoritative `activeElementIds` state.

Suggested new components:

- `InspectorSection`
- `LayersPanel`
- `LayerRow`
- `ContextToolbar`
- `PositionFields`
- `ArrangeControls`

Acceptance criteria:

- Common changes take one or two obvious interactions.
- Advanced controls do not crowd the default view.
- Selecting an object on the canvas selects the same object in Layers.
- Selecting an object in Layers selects it on the canvas.
- Locked objects cannot be dragged, edited, or accidentally deleted.
- Multi-selection alignment creates one undo entry.

Required tests:

- Canvas and layer selection synchronization.
- Lock prevents mutation.
- Hide affects editor preview but not persisted deletion.
- Layer reorder changes z-order and persists.
- Multi-select align and group are undoable.

### Phase 5: Templates, layouts, themes, and media workflow

Goal: deliver Canva-like speed without building a complex design platform.

Tasks:

- Add a layout picker to the Add Slide flow.
- Define a small built-in layout set:
  - Title
  - Title and content
  - Quote
  - Image with caption
  - Announcement
  - Scripture
  - Blank
- Make layout application preserve user content where possible.
- Improve template gallery with larger previews, categories, and a clear
  `Insert` action.
- Show whether a template inserts one slide or a deck.
- Add a small set of presentation theme presets.
- Keep custom `SlideTheme` persistence compatible.
- Allow theme changes to update inherited text styles without overwriting
  explicit per-element overrides.
- Improve media insertion:
  - Select from library.
  - Upload/import.
  - Replace selected media.
  - Drag/drop onto canvas if feasible without destabilizing pointer editing.
  - Crop, fit, focal position, opacity, and border radius.
- Preserve centralized media path resolution through `src/utils/mediaPath.ts`.

Suggested files:

- `src/utils/index.ts`
- `src/types/slides.ts`
- `src/components/editors/slide/SlideEditorModals.tsx`
- `src/components/editors/slide/PropertiesPanel.tsx`
- `src/components/MediaPickerModal.tsx`
- New: `src/components/editors/slide/LayoutPicker.tsx`
- New: `src/components/editors/slide/ThemePicker.tsx`

Data rules:

- Every new field must have a default in migration.
- Existing presentation JSON must still load.
- New template fields must be optional for old templates.
- Do not store absolute media paths when the existing relativization rules can
  represent the path relatively.

Required tests:

- Legacy presentation migration.
- Theme inheritance versus explicit element overrides.
- Layout insertion preserves expected text/media.
- Template insertion creates fresh slide and element IDs.
- Media replacement does not leave stale paths.
- Missing media remains visible and recoverable.

Acceptance criteria:

- A new user can create a coherent slide without using the advanced inspector.
- Templates and layouts reduce work instead of adding another confusing menu.
- Theme changes do not unexpectedly rewrite explicit formatting.
- Output and editor render the same media and text proportions.

### Phase 6: Preview, stage, and service integration

Goal: connect authoring to production without blurring the safety boundary.

Tasks:

- Add an explicit local `Preview` action for the current slide or deck.
- Keep the existing preview PIP if it is reliable, but improve its size,
  controls, and status label.
- Add `Stage Current Slide` with loading and failure feedback.
- Add `Add to Service` using the shared schedule mutation and persistence path.
- If `Go Live` is exposed in the editor, make it visually secondary to Preview
  and Stage and require the same transactional live flow as the cockpit.
- Show whether the current slide is staged or on air without using color alone.
- Never invoke live commands from autosave, close, template insertion, or
  preview.
- Ensure `studio-slides-sync` updates other windows after a successful save.

Suggested files:

- `src/components/editors/SlideEditor.tsx`
- `src/components/editors/slide/useSlideEditor.ts`
- `src/components/editors/slide/LivePreviewPip` or extracted preview component
- `src/hooks/useItemActions.ts`
- `src/components/layout/Cockpit.tsx`
- `src/hooks/useAppInitialization.ts`

Required tests:

- Preview never calls stage/live commands.
- Stage failure leaves the previous staged item intact.
- Current slide stages the correct presentation id and slide index.
- Add to Service uses the same schedule mutation as Service Plan.
- Null and update synchronization events do not leave stale state.

Acceptance criteria:

- An operator can preview without broadcasting.
- An operator can stage the current slide with visible success/failure state.
- Saving a presentation never changes what is live.
- The cockpit and presentation editor agree on staged/live state.

### Phase 7: Accessibility, performance, and cleanup

Goal: make the modern editor robust on real operator hardware.

Tasks:

- Add accessible names to all icon controls.
- Verify keyboard-only slide navigation and object editing.
- Add focus restoration when menus, pickers, and modals close.
- Add Escape behavior for menus, inspector drawers, preview, and modals.
- Check reduced-motion behavior.
- Measure render cost for large decks before adding virtualization.
- Avoid rendering unnecessary thumbnail work when the slide rail is off-screen.
- Keep the lazy editor chunk behavior from `App.tsx`.
- Remove dead helpers and obsolete styling only after behavior is covered.
- Move new user-facing strings into the i18n dictionaries.

Acceptance criteria:

- The primary authoring workflow works without a mouse.
- The editor remains usable at 150% scaling.
- No critical action is hover-only.
- No performance optimization is added without a measured problem.

Verification:

```bash
npm run test
npm run build
```

## 9. Test Plan

### 9.1 Unit tests

Add tests under a focused editor test directory, for example:

- `src/components/editors/slide/__tests__/useSlideHistory.test.ts`
- `src/components/editors/slide/__tests__/useAutoSave.test.ts`
- `src/components/editors/slide/__tests__/useSlideEditor.mutations.test.ts`
- `src/components/editors/slide/__tests__/slideMigration.test.ts`
- `src/components/editors/slide/__tests__/layerSelection.test.ts`

Test pure helpers separately from React components when possible.

Minimum unit coverage:

- New document creation.
- Add, duplicate, reorder, and delete slide.
- Add, duplicate, delete, group, and ungroup element.
- Position, resize, rotate, align, and z-order.
- Text content commit and coalescing.
- Dirty state for every mutation.
- Save revision race.
- Save error and retry.
- Undo/redo and redo branch behavior.
- Master mutation and cascade behavior.
- Template insertion and fresh IDs.
- Legacy migration and round-trip shape.

### 9.2 Component tests

Use Testing Library for behavior visible to users:

- Save status changes from Dirty to Saving to Saved.
- Save failure renders an actionable retry.
- Close with unsaved changes opens the custom confirmation.
- Add Slide menu inserts the selected layout.
- Slide rail selection updates the canvas.
- Canvas selection updates the inspector.
- Inspector updates the selected object.
- Keyboard shortcuts work outside text inputs.
- Text editing keeps Ctrl+Z inside Tiptap until editing ends.
- Preview renders without broadcast invocation.
- Stage action is visible and reports failure.

Do not test Tailwind class strings as the primary behavior. Test roles, labels,
visible text, callbacks, and state transitions.

### 9.3 Backend contract tests

For Rust changes:

- Save/load preserves theme, masters, slides, elements, notes, and backgrounds.
- Old presentation JSON still deserializes.
- New optional fields receive safe defaults.
- `updated_at` and summary fields remain meaningful.
- Template save/load/delete remains compatible.

Run:

```bash
cd src-tauri
cargo check
cargo clippy
cargo test
```

### 9.4 Manual production matrix

Run the following before completing the modernization:

| Area | Checks |
|---|---|
| Window sizes | 1280x720, 1920x1080 |
| Windows scaling | 100%, 125%, 150% |
| Navigation | mouse, keyboard, collapsed drawers |
| Persistence | new, edit, autosave, manual save, restart |
| Failure | save failure, stage failure, missing media |
| Selection | single, multi, group, lock, layer selection |
| Text | typing, selection formatting, undo, long verse, auto-size |
| Media | image, video, replace, crop/fit, missing path |
| Slides | add, duplicate, reorder, delete, template insertion |
| Masters | create, edit, apply, cascade, delete |
| Preview | preview never broadcasts, animation behavior |
| Production | stage, live separation, Add to Service |
| Displays | operator, output, and stage windows |
| Recovery | close during save, backend unavailable, retry |

For each check record:

- Steps.
- Expected result.
- Actual result.
- Screenshot or log when it fails.

## 10. AI Agent Execution Protocol

The implementation agent must follow these rules:

1. Work on one phase at a time.
2. Before editing, inspect the current file and check `git diff` for user work.
3. Do not revert unrelated worktree changes.
4. Preserve Tauri command names, event names, persistence keys, and migrations.
5. Use `apply_patch` for manual edits.
6. Reuse existing React, Zustand, Tiptap, Framer Motion, Lucide, and shared UI
   primitives before adding dependencies.
7. Do not introduce a second slide renderer.
8. Do not mix broad visual changes with live-state correctness changes unless
   the phase explicitly requires both.
9. Add tests for every bug fixed and every new state transition.
10. Run `npm run test` and `npm run build` after each frontend phase.
11. Run `cargo check`, `cargo clippy`, and relevant Rust tests after Rust or
    Tauri contract changes.
12. Review the diff for unrelated changes before marking a phase complete.
13. Verify the acceptance criteria at 1280x720 and 1920x1080.
14. Report skipped checks and known limitations instead of claiming completion.

## 11. Definition Of Done

The modernization is complete only when all of the following are true:

- Ordinary edits reliably mark dirty and autosave.
- Save races cannot clear a newer unsaved revision.
- Save failure is visible and recoverable.
- Undo/redo covers all document mutations.
- Master editing routes every supported mutation correctly.
- The editor has a clear top bar, slide rail, canvas, and inspector.
- Typography and hit areas remain readable at target sizes and scaling.
- Important actions are visible without hover.
- Layers, layouts, templates, themes, and media workflows are understandable
  to a volunteer.
- Preview, stage, live, and service actions remain distinct.
- Editor rendering matches stage/output rendering.
- Frontend tests pass.
- `npm run build` passes.
- Rust checks pass when Rust/Tauri code was changed.
- The manual production matrix has been run and documented.

## 12. Recommended First Slice

If the agent must start with a small, high-value implementation slice, do this
in order:

1. Fix dirty tracking and revision-safe autosave.
2. Add `Saved`, `Saving`, and `Save failed` UI.
3. Replace the current top bar with a labeled, accessible command bar.
4. Increase editor control sizes and remove hover-only menus.
5. Rework the right panel into collapsible `Layout`, `Style`, `Text`, and
   `Slide` sections.
6. Add a simple Layers list.
7. Add tests before adding more design features.

This slice improves trust, readability, and daily speed without changing the
persisted slide format or introducing unnecessary product complexity.
