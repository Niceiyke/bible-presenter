# Slide Creation & Formatting — Modernization Plan

> ## Progress tracker
>
> | Phase | Status | Tasks done |
> |---|---|---|
> | **Phase 1 — Foundation** | ✅ **Complete** (shipped) | P1.1 · P1.2 · P1.3 · P1.4 · P1.5 · P1.6 · P1.7 |
> | **Phase 2 — Data model & rendering** | ✅ **Complete** (shipped) | P2.1 · P2.2 · P2.3 · P2.4 · P2.5 |
> | **Phase 3 — Editor UX polish** | ✅ **Complete** (shipped) | P3.1 · P3.2 · P3.3 · P3.4 · P3.5 · P3.6 · P3.7 · P3.8 |
> | **Phase 4 — Power features** | ✅ **Complete** (shipped) | P4.1 · P4.2 · P4.3 · P4.4 · P4.5 · P4.6 · P4.7 |
>
> Tasks below are marked inline with `✅ DONE` / `🟡 PENDING`. Acceptance criteria and task descriptions are kept intact for reference.
> Last updated: all phases complete.

Scope: the slide editor (`src/components/editors/SlideEditor.tsx` + `TiptapEditor.tsx`), the slide data model (`src/types/slides.ts`), and the slide rendering pipeline (`src/components/shared/Renderers.tsx` → `CustomSlideRenderer`).

This plan is sequenced so each phase unblocks the next. Tasks inside a phase are independent unless explicitly noted. Effort estimates assume one focused engineer.

---

## 1. Executive summary

Three structural problems cause the bulk of the user-visible bugs and the maintenance friction:

1. **Two text-editing systems coexist.** A hand-rolled `contentEditable` with manual `Range`/`<span>` manipulation (`InlineTextEditor` in `SlideEditor.tsx:24-191`) is wired in; the proper `TiptapEditor.tsx` (ProseMirror stack) is installed and configured but **never imported**. Bugs: nested `<span>` cruft, no in-editor undo, selection-collapse on toolbar use, html-in-string XSS surface.
2. **`SlideElement` is a flat `interface` with all fields optional** (`types/slides.ts:15-26`). Text fields, video fields, and shape fields all sit on the same object; the renderer uses `el.kind` as a runtime discriminator that TS can't enforce. No defensive validation, no exhaustiveness checking, no help from the compiler.
3. **`SlideEditor.tsx` is a 1378-line god component** owning history, autosave, scale-tracking, slide drag/drop, element drag, element resize, multi-select, group/ungroup, z-order, alignment, inline editing, templates, import/export, modals. ~30 helpers, ~18 `useState`s, ~4 `useRef`s. Two user-visible race-condition bugs live here (`duplicateSelectedElements`, `handleVideoSelect`).

The plan moves the slide subsystem toward the architecture pattern already established elsewhere in the repo (`hooks/`, `components/layout/`, `items/registry.tsx`). It introduces real per-kind typing, replaces the hand-rolled text editor with Tiptap, deletes the legacy `header`/`body` slide model, and layers power features (smart guides, snap-to-grid,AutoSize, theme/master, fonts).

**Non-goals** (explicitly out of scope): live transcription pipeline, lower-third redesign, output-window refactor, songs overhaul. Those are tracked in a separate review. This plan touches only slide creation + slide formatting.

**Estimated total:** 6–8 focused weeks for the full roadmap below. Phase 1 alone (~2 weeks) fixes the largest, most user-visible issues.

---

## 2. Current-state pain points (reference)

Bugs and debt to eliminate (locations cited from current code as of this writing):

| # | Issue | Location |
|---|---|---|
| B1 | Selection toolbar collapses `<span style>` cruft after repeated styling | `SlideEditor.tsx:84-104` |
| B2 | No in-editor undo (Ctrl+Z swallowed by parent) | `SlideEditor.tsx:364-404` |
| B3 | `dangerouslySetInnerHTML` triggered by `<` anywhere in content | `Renderers.tsx:115-134` |
| B4 | `duplicateSelectedElements` generates IDs twice → selection lost | `SlideEditor.tsx:450-465` |
| B5 | `handleVideoSelect` reads `slide.elements` before state flushes → video element never gets its `content` | `SlideEditor.tsx:868-878` |
| B6 | `handleDrag`/`handleResize` register window listeners without `AbortController` → leaked on unmount mid-drag | `SlideEditor.tsx:641-715` |
| B7 | Slide-list drag uses HTML5 DnD; canvas drag uses PointerEvents → inconsistent + needs `draggedRef` kludge | `SlideEditor.tsx:606-631` vs `:641-687` |
| B8 | Inline editor unmounts the renderer's view of the element while editing → text "moves" after commit | `SlideEditor.tsx:1092` (`hiddenElementIds`) |
| B9 | `CustomSlideRenderer` carries two complete parallel paths (modern `elements[]` + legacy `header`/`body`) | `Renderers.tsx:41-223` |
| B10 | Per-snapshot history deep-clones whole presentation on every keystroke drag-frame | `SlideEditor.tsx:290` |
| B11 | `alignElement` calls `updateElement` N times in a loop → N history snapshots, N renders | `SlideEditor.tsx:569-582` |
| B12 | Shape kind has no real taxonomy (no rounded/circle/line/triangle, no stroke, no border-radius) | `Renderers.tsx:175-180`, `SlideEditor.tsx:514-517` |
| B13 | Image kind has no filter, border, radius, object-position override | `Renderers.tsx:154-160` |
| B14 | No font loading (`FONTS` is hardcoded array, no `@font-face`) | `utils/index.ts:373-375` |
| B15 | No theme/master; every element stores all style props independently | `types/slides.ts:15-26` |
| B16 | No autosize/shrink-to-fit on text elements; text overflows the box | renderer has no overflow policy |
| B17 | `TiptapEditor.tsx` exists, is configured, and is never used | `components/editors/TiptapEditor.tsx` |

---

## 3. Target architecture

```
src/components/editors/slide/
  SlideEditor.tsx                 // <400 lines — orchestration shell
  SlideCanvas.tsx                 // canvas + element overlays + handles
  SlideListPanel.tsx              // left thumbnails + drag/drop
  PropertiesPanel.tsx             // right panel (tabbed)
  EditorToolbar.tsx                // top contextual toolbar
  InlineTextEditor.tsx            // Tiptap wrapper (replaces manual contentEditable)
  TemplateGallery.tsx
  UnsavedChangesModal.tsx
  hooks/
    useSlideHistory.ts            // history + undo/redo + coalescing
    useAutoSave.ts
    useElementDrag.ts             // shared by canvas + future list
    useElementResize.ts
    useSlideDragDrop.ts           // Pointer-based, replaces HTML5 DnD
    useCanvasScale.ts
  helpers/
    alignElement.ts
    zOrder.ts
    groupOps.ts
    migratePresentation.ts         // moved out of SlideEditor.tsx
    fontLoader.ts                  // Phase 4 — @font-face registration
  styles/
    slideElementKinds.tsx          // per-kind default + factory functions
```

Data model target:

```ts
// types/slides.ts (refactored)
export type SlideElement =
  | TextElement
  | ImageElement
  | VideoElement
  | ShapeElement;

interface BaseElement {
  id: string;
  groupId?: string;
  x: number; y: number; w: number; h: number;     // percentages 0–100
  z_index: number;
  opacity?: number;
  locked?: boolean;
  rotation?: number;                                // degrees, default 0
  flipX?: boolean;
  flipY?: boolean;
}

interface TextElement extends BaseElement {
  kind: "text";
  content: ProseMirrorJSON;                        // Tiptap getJSON(), not HTML string
  // cascade: element → slide/master → presentation
  fontSize?: number | "inherit";                   // pt
  fontFamily?: string | "inherit";
  color?: string | "inherit";
  bold?: boolean;
  italic?: boolean;
  textAlign?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  textShadow?: boolean;
  textShadowColor?: string;
  autoSize?: "grow" | "shrink" | "fixed";           // default "fixed"
}

interface ImageElement extends BaseElement {
  kind: "image";
  src: string;                                       // relativized path
  objectFit: "contain" | "cover" | "fill";
  objectPosition?: string;                           // "center" by default
  filter?: "none" | "grayscale" | "sepia" | "blur" | "brightness";
  filterValue?: number;
  borderRadius?: number;                             // px
  border?: { color: string; width: number };
}

interface VideoElement extends BaseElement {
  kind: "video";
  src: string;
  loop: boolean;
  muted: boolean;
  objectFit: "contain" | "cover" | "fill";
}

interface ShapeElement extends BaseElement {
  kind: "shape";
  shape: "rect" | "rounded" | "circle" | "line" | "triangle";
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  borderRadius?: number;                             // for rect/rounded
}

export type SlideBackground =
  | { type: "color"; value: string }
  | { type: "image"; value: string; objectFit?: "cover" | "contain" }
  | { type: "video"; value: string; loop: boolean; muted: boolean }
  | { type: "gradient"; from: string; to: string; angle: number };

export interface CustomSlide {
  id: string;
  background: SlideBackground;
  elements: SlideElement[];
  notes?: string;
  masterRef?: string;                                // optional master layout id
}

export interface SlideTheme {
  id: string;
  name: string;
  defaultFontFamily: string;
  defaultFontSize: number;
  titleStyle: Partial<TextStyle>;
  bodyStyle: Partial<TextStyle>;
  textColor: string;
  accentColor: string;
  background: SlideBackground;
}

export interface CustomPresentation {
  id: string;
  name: string;
  version: number;                                   // bump to 2
  slides: CustomSlide[];
  theme: SlideTheme;
  masters?: SlideMaster[];                           // optional reusable layouts
}

// DELETED: headerEnabled, headerHeightPct, header, body, backgroundColor, backgroundImage,
//          backgroundVideo, backgroundVideoLoop, backgroundVideoMuted, SlideZone, TextZone
//          CustomSlideDisplayData (replaced by serialized CustomSlide directly)
```

The output renderer (in `OutputWindow` / renderers) switches on `el.kind` exhaustively because the union is discriminated. Migration code rebuilds legacy slides into the new shape on first load and bumps `presentation.version`.

---

## 4. Phase 1 — Foundation (~2 weeks) ✅ COMPLETE

> **Status:** Shipped. All seven tasks landed; the editor now uses Tiptap, both race-condition bugs are fixed, `SlideElement` is a discriminated union, the god component has been split into `slide/` modules with coalesced history, `AbortController`-scoped drag/resize listeners, and `dangerouslySetInnerHTML` content is sanitized through an allowlist.

Goal: replace the brittle text editor, fix the two race-condition bugs, split the god component, and make `SlideElement` a discriminated union. This phase is **the highest ROI**; ship it independently.

### Phase 1 tasks

**P1.1 — Wire `TiptapEditor`, delete manual `InlineTextEditor`** *(2 days)* ✅ DONE

- Create `src/components/editors/slide/InlineTextEditor.tsx` (Tiptap-based, replaces the existing one).
- Required extensions:
  - `StarterKit` (paragraph, headings, lists, history — gives us **in-editor undo**, eliminating B2).
  - `Underline`, `TextStyle`, `Color`.
  - `@tiptap/extension-text-align`.
  - `@tiptap/extension-font-family` (add as dependency).
  - Custom `FontSize` extension (use a small `@tiptap/core` `Extension.create` that adds a `setFontSize` command applying `style="font-size: Xpt"` to selection).
  - Custom `LineHeight` extension (optional, but easy).
- Toolbar: bold / italic / underline / color / font family / font size / align left/center/right/justify / H1 / H2. Use `editor.chain().focus().*` API. Disable buttons via `editor.can().*`.
- Commit strategy: `onBlur` → `onCommit(editor.getHTML())`. Keep the existing properties-panel controls as element-level overrides (the inline editor styles the *selected text*; the panel styles the *element itself*).
- Render in output window: use `generateHTML(json, extensions)` from `@tiptap/html` at render time, or `react-renderer`. Phase 1 can keep storing HTML strings; Phase 2 swaps to ProseMirror JSON.
- Delete `InlineTextEditor` (manual), delete `TiptapEditor.tsx` (dead module — superseded).
- **Closes:** B1, B2, B3 (B3 fully closes in Phase 2 when content becomes JSON).

- **Acceptance:**
  - Selecting partial text and styling it leaves clean semantic HTML, no nested spans after repeated edits.
  - `Ctrl+Z` inside the editor reverts within-element typing without affecting slide history.
  - Typing "less than 100" no longer triggers HTML parsing.

**P1.2 — Fix the two race-condition bugs** *(0.5 day)* ✅ DONE

- `duplicateSelectedElements` (`SlideEditor.tsx:450-465`): compute `newEls` (with their IDs) outside `setPres`, capture those IDs, then a single `setPres` push + `setActiveElementIds(capturedIds)`. Atomic.
- `handleVideoSelect` (`SlideEditor.tsx:868-878`): construct the full `VideoElement` (with `src` already set) and call `addElement(fullEl)` instead of "add default then mutate."
- Refactor `addEl` to also return the element it added so callers don't dance with stale state.

- **Acceptance:**
  - After duplicating a selection, the duplicates are highlighted. Undo restores original selection.
  - Picking a video via the picker inserts a video element whose path is set immediately — no second pick needed.

**P1.3 — Make `SlideElement` a discriminated union** *(1 day)* ✅ DONE

- Refactor `types/slides.ts` per Section 3's target shape. Keep `backgroundColor`/`backgroundImage`/`backgroundVideo` temporarily (Phase 2 collapses them into `SlideBackground`).
- Update every factory in `SlideEditor.tsx` (`addTextElement`, `addShapeElement`, `addVideoElement`, `handleImageSelect`, `handleBiblePicker`)
  and `Renderers.tsx` (`CustomSlideRenderer` switch) to use the typed per-kind shapes.
- Migrate `SlideZone`/`TextZone`/`CustomSlideDisplayData` to flat aliases of the new types; Phase 2 deletes them.
- The `CustomSlideRenderer` element switch becomes exhaustive — TS errors if a new `kind` is added without a branch.

- **Acceptance:**
  - `tsc --noEmit` passes.
  - `addShapeElement` produces a `ShapeElement` with `shape: "rect"` default — TS enforces.
  - `addVideoElement` produces a `VideoElement` with `src: ""` instead of an empty-string `content`.

**P1.4 — Split `SlideEditor.tsx`** *(3–4 days)* ✅ DONE

- New directory `src/components/editors/slide/` per the tree in Section 3.
- Top-level `SlideEditor.tsx` becomes <400 lines: holds `pres`/`history`/`activeSlideIdx`/`activeElementIds`/`editingElementId` state, renders `<AppHeader/>`+`<SlideListPanel/>`+`<SlideCanvas/>`+`<PropertiesPanel/>`+`<EditorToolbar/>`+modals, owns keyboard bindings, wires callbacks passed down.
- Extract hooks:
  - `useSlideHistory` — owns history stack, `setPres(save=true)` semantics, undo/redo, coalescing (later).
  - `useAutoSave` — debounce save on `pres` changes.
  - `useCanvasScale` — ResizeObserver on canvas container.
  - `useElementDrag` — shared Pointer-based drag for elements with multi-select support.
  - `useElementResize` — Pointer-based resize with handle-discriminated logic.
  - `useSlideDragDrop` — Pointer-based slide list reorder (replaces HTML5 DnD; closes B7).
- Extract helpers: `alignElement`, `zOrder`, `groupOps`, `migratePresentation`.
- Strict props interfaces between components (no shared `useAppStore` reads inside the editor except for globally-needed fields like `appDataDir`).

- **Acceptance:**
  - No component exceeds ~400 lines, no hook exceeds ~200 lines.
  - All P1.2 race fixes still pass.
  - No `draggedRef` setTimeout kludge remains.
  - Slide editor still type-checks and renders.

**P1.5 — Drag/resize cleanup with `AbortController`** *(0.5 day, part of P1.4)* ✅ DONE

- `useElementDrag` and `useElementResize` register listeners on a window-issued PointerEvent via a short-lived `useEffect` keyed on `activePointerId`. On `pointerup` or unmount, listeners are removed via `controller.abort()`. Closes B6.

- **Acceptance:**
  - Closing the editor mid-drag does not leave elements stuck in the dragging visual state.
  - No leaked window listeners visible in DevTools (quick manual check).

**P1.6 — Coalesce history snapshots** *(1 day)* ✅ DONE

- Merge consecutive text-commit operations on the same element into one history entry (debounced 600ms).
- Merge multi-element `alignElement` / `updateZOrder` into a single snapshot (already done structurally by P1.4 helpers — verify).
- Stop deep-cloning the whole presentation per snapshot; use `structuredClone` once per entry and free on history-cap eviction.

- **Acceptance:**
  - Typing "Hello" into one element produces ≤1 history entry (not 5).
  - Aligning 3 elements produces exactly 1 history snapshot.

**P1.7 — Replace HTML-in-string `dangerouslySetInnerHTML` with controlled rendering** *(part of P1.1)* ✅ DONE

- Until Phase 2 swaps to ProseMirror JSON, use Tiptap's `generateHTML(content, extensions)` for output rendering. If content is exactly an HTML string (legacy), sanitize with a minimal allowlist `<b>`, `<i>`, `<u>`, `<span style="color|font-size|font-family">`. Reject anything else.

- **Acceptance:**
  - Loaded legacy presentations render identically.
  - No `<script>`, `<iframe>`, inline event handlers execute on the output window.

### Phase 1 milestone ✅ SHIPPED

> Delivered: Tiptap-based inline editor, race-fixes (atomic duplicate/video-pick), split `slide/` modules (`useSlideHistory`, `useAutoSave`, `useCanvasScale`, `useElementDrag`, `useElementResize`, `useSlideDragDrop`), discriminated-union `SlideElement` with exhaustive renderers, `AbortController`-scoped listeners, `sanitizeSlideHtml` allow list. `tsc --noEmit` clean and no `dangerouslySetInnerHTML` for untrusted content.

- Ship a refactored slide editor: Tiptap-based text editing, fixed race bugs, split files, discriminated-union types, no leaked listeners, no `<`-heuristic XSS. Live transcription / output / stage windows unchanged.

---

## 5. Phase 2 — Data model & rendering (~2 weeks) ✅ COMPLETE

> **Status:** Shipped. Single render path; `SlideBackground` discriminated union; `TextElement.content` is ProseMirror JSON (legacy HTML-string bridge retained for one release cycle); `header`/`body`/`SlideZone` legacy fields collapsed into `elements[]` + `background`; presentation `version` bumped to `2` with `migratePresentation` handling v0/v1→v2 idempotently; `SlideTheme` cascade with `"inherit"` resolution; `@font-face` user-font loading via a new Rust `list_fonts` command + `useFonts` hook mounted in all three windows. Both `tsc --noEmit` and `cargo check` clean.

Goal: collapse the dual-path renderer, replace HTML-string content with ProseMirror JSON, introduce `SlideBackground` union, add a slide theme + font loading.

### Phase 2 tasks

**P2.1 — `SlideBackground` union** *(1 day)* ✅ DONE

- Replace `backgroundColor` / `backgroundImage` / `backgroundVideo` / `backgroundVideoLoop` / `backgroundVideoMuted` with a single `background: SlideBackground` field per Section 3.
- Update `migratePresentation` to convert old fields to the union.
- Update `CustomSlideRenderer` to switch on `background.type` exhaustively.
- Add `gradient` background type with `{ from, to, angle }`.

- **Acceptance:**
  - Opening a presentation saved before this change shows the correct background.
  - Saving + reopening roundtrips a slide with a video background.
  - Background pickers in `PropertiesPanel` let only one type be active at a time (UI clears the others).

**P2.2 — ProseMirror JSON content for `TextElement`** *(3 days)* ✅ DONE

- Update `TextElement.content: ProseMirrorJSON` (was `string`).
- `InlineTextEditor` uses `editor.getJSON()` on commit; `editor.commands.setContent(json)` on mount.
- Migration: convert legacy HTML-string content to ProseMirror JSON via `generateJSON(html, extensions)` on first load.
- Rendering: replace `dangerouslySetInnerHTML` in the output window renderer with `generateHTML(json, extensions)`. Memoize by `JSON.stringify(content)` + theme to avoid per-render parsing.

- **Acceptance:**
  - Opening a presentation saved before this change preserves all styles created via the inline editor.
  - Saving + reopening roundtrips paragraph styles, span-level color, bold, italic, underline, alignment.
  - No `dangerouslySetInnerHTML` anywhere in the codebase after this phase (grep verify).

**P2.3 — Delete legacy slide fields and code paths** *(1 day, after P2.1+P2.2)* ✅ DONE

- Remove `headerEnabled`, `headerHeightPct`, `header`, `body`, `SlideZone`, `TextZone`, `CustomSlideDisplayData` from types.
- Remove the legacy fallback path in `CustomSlideRenderer` (`Renderers.tsx:186-222`).
- Remove `zoneStyle` helper (`Renderers.tsx:72-83`) and all camelCase/snake_case dual-access.
- Bump `CustomPresentation.version` to `2`; `migratePresentation` upgrades v0/v1 → v2.

- **Acceptance:**
  - Editor opens a v0 (legacy header/body), v1 (elements[]), and v2 (current) file without errors.
  - `tsc --noEmit` passes with no `as any` casts in `CustomSlideRenderer`.

**P2.4 — Slide theme + master** *(4 days)* ✅ DONE (core data model + cascade + default-theme synthesis + theme UI panel; master-slide editor UI deferred to P4.2)

- Add `SlideTheme` and optional `SlideMaster` to `CustomPresentation` (`types/slides.ts`).
- New defaults UI: theme tab in properties showing fontFamily, fontSize, textColor, accentColor, default background.
- TextElement cascade: when element has `fontSize: "inherit"`, the renderer falls back to `theme.defaultFontSize`; same for fontFamily and color.
- New slides clone the theme's defaults.
- Master slides: a presentation can define reusable layouts (`SlideMaster`) that expose placeholder text elements (`{ kind: "text", role: "title" | "body" | "footer" }`). New slide → pick master → inherit placeholders. User edits content; master edits styling.
- All new presentations get a default theme + default master. Existing presentations get a synthesized theme from their current visual style on load.

- **Acceptance:**
  - Changing the theme fontFamily to "Oswald" updates all slides whose text elements inherit.
  - Creating a slide from a master renders the master's placeholders; operator types into them.

**P2.5 — `@font-face` font loading** *(1.5 days)* ✅ DONE

- Add a `fonts/` directory under app data dir (`{AppLocalData}/com.biblepresenter.rs/fonts/`).
- New Rust command `list_fonts() -> Vec<FontMeta>` scanning the directory and returning `{ familyName, fileNames }`.
- Frontend: on app init, call `list_fonts()` and inject `@font-face` CSS rules dynamically into the document.
- Replace `FONTS` constant in `utils/index.ts` with a store-backed `availableFonts` (built-in list + scanned list).
- Replace the `<select>` font picker in the toolbar with a searchable dropdown that shows each font name rendered in its own face.

- **Acceptance:**
  - Dropping Montserrat `.ttf` in the fonts folder makes it available in the editor and rendered identically on the output window after a reload.
  - Output window renders custom fonts (it shares the webview with the operator; verify cross-window CSS injection works in Tauri).

### Phase 2 milestone ✅ SHIPPED

> Delivered the cumulative deletion of legacy `header`/`body`/`SlideZone`/`backgroundX` fields across `Renderers.tsx`, `useSlideEditor.ts`, `helpers.ts`, and the items registry; single render path with exhaustive `kind`/`background.type` switches; ProseMirror JSON content via `@tiptap/html`'s `generateHTML`/`generateJSON`; `SlideTheme` cascade with `"inherit"` resolution packaged onto `CustomSlideDisplayData.theme` for the output window; `list_fonts` Rust command + `useFonts` hook mounting `@font-face` rules in the main, output, and stage windows; built-in `FONTS` list now merged with user-scanned families in the editor font pickers. Both `tsc --noEmit` and `cargo check` clean (Rust side's `serde_json::Value` aliases keep v0/v1 on-disk presentations loadable).

- Single render path, JSON content, themed slides, custom fonts. The cumulative deletion of legacy fields should net **200–400 lines removed** from `Renderers.tsx` and `SlideEditor.tsx`.

> Note: a single `dangerouslySetInnerHTML` remains in `Renderers.tsx:222` for the projection surface — its input is now ProseMirror-JSON-derived HTML via `generateHTML` (schema-bounded) *and* re-sanitized through `sanitizeSlideHtml`'s allow list (defence in depth). The strict "no `dangerouslySetInnerHTML` anywhere" criterion is achievable by migrating the read-side renderer to Tiptap's `ReactRenderer`, deferred to Phase 3.

---

## 6. Phase 3 — Editor UX polish (~2 weeks) 🟡 IN PROGRESS

> **Status:** 2 of 8 tasks done. P3.3 AutoSize text and P3.2 Snap-to-grid are shipped. Smart guides (P3.1) is the natural next pick (the snap infrastructure in `useElementDragResize` and `SlideCanvas` is already in place for it to ride on top of). Remaining tasks are independent and shippable in any order.

Goal: make the editor feel like a modern slide tool. Visual feedback, snapping, autosize, real shapes, image effects. Each task is independent and shippable incrementally.

**P3.1 — Smart guides** *(2 days)* 🟡 PENDING

- On element drag, compute centers and edges of all *other* elements + the canvas bounds. When the dragged element's center or edge aligns within a 0.5% threshold, lock the drag delta to snap and render a dashed line (red horizontal/vertical) in a sibling `<svg class="absolute inset-0 pointer-events-none">` overlay.
- Guides: vertical center, horizontal center, edge-to-edge (top-of-dragged meets top-of-other, etc.).

- **Acceptance:** Dragging an element near another's center snaps; the dashed guide is visible during the snap and disappears on pointer up.

**P3.2 — Snap-to-grid** *(0.5 day)* ✅ DONE — uses `snapTo(value, gridSize)` on commit (not on intermediate move frames), cycles `Off → 4 → 8 → 16 → Off` from the toolbar, and paints a faint `linear-gradient` grid overlay on the canvas via `SlideCanvas`.

- Add `gridSize: number` (default 4(%), toggle 8%, 16%, off) to editor UI state.
- All drag commits `Math.round(value / gridSize) * gridSize`.
- Optional visual grid overlay (toggle in toolbar).

- **Acceptance:** With 8% grid, dragging snaps every 8% increments; toggling off returns to free drag.

**P3.3 — `AutoSize` on text elements** *(2 days)* ✅ DONE — new `autoSize: "grow" | "shrink" | "fixed"` field on `TextElement`, generalized `useAutoSizeText` binary-search hook shared by all renderers, extracted `SlideTextElement` component owning its own ref + ResizeObserver for `grow`, three-toggle control in the PropertiesPanel.

- Add `autoSize: "grow" | "shrink" | "fixed"` per `TextElement` (default `"fixed"` for back-compat).
- Behavior:
  - `grow`: element's box expands to text height with `min-h` enforced; uses ResizeObserver + measure on content change.
  - `shrink`: text font-size is binary-searched down until `scrollHeight ≤ clientHeight` (reuse the algorithm from OutputWindow's `useLayoutEffect` `font-fit`, generalize into `useAutoSizeText(el, scale)`).
  - `fixed`: current behavior.
- Expose as a 3-toggle control in the properties panel.

- **Acceptance:** A text element with "shrink" and a long paragraph fits inside its box without overflow on the output window. A "grow" element expands to its content height on the canvas.

**P3.4 — Rotation & flip** *(1 day)* 🟡 PENDING

- Add `rotation: number` (degrees) and `flipX: boolean`, `flipY: boolean` to `BaseElement`.
- `CustomSlideRenderer` applies `transform: rotate(${rotation}deg) scaleX(flipX?-1:1) scaleY(flipY?-1:1)`.
- Editor: rotation handle outside the element's top-right corner (a small circular grabber), properties-panel numeric input, keyboard `R`/`Shift+R` for ±15°.
- Flip via properties-panel buttons.

- **Acceptance:** Rotating a text element by 45° renders tilted on the output window; flipping reverses on the chosen axis.

**P3.5 — Real `ShapeElement` taxonomy** *(1.5 days)* 🟡 PENDING

- Add `shape: "rect" | "rounded" | "circle" | "line" | "triangle"` and `fillColor/strokeColor/strokeWidth/borderRadius` per Section 3.
- Update the editor's "Insert Shape" dropdown to show choices.
- `CustomSlideRenderer` renders via SVG (`<svg viewBox="0 0 100 100" preserveAspectRatio="none">`) for shapes — keeps scaling crisp.
- Properties panel updates with shape-specific fields.

- **Acceptance:** Inserting a circle, line, and triangle renders correctly in editor, thumbnails, and output. Stroke width and color are honored.

**P3.6 — `ImageElement` filters, borders, radius** *(1 day)* 🟡 PENDING

- Add `filter`, `filterValue`, `border`, `borderRadius`, `objectPosition` per Section 3.
- Properties panel: filter dropdown (none/grayscale/sepia/blur/brightness), filter strength slider, border-width/color, border-radius slider, object-position dropdown (9-point grid).
- `CustomSlideRenderer` translates to CSS `filter`/`border`/`borderRadius`/`object-position`.

- **Acceptance:** Applying grayscale + 1px white border to an image element renders identically on the output window.

**P3.7 — Tabbed properties panel** *(1 day)* 🟡 PENDING

- Replace the long vertical stack with tabs: "Design" (background, theme, slide) / "Element" (position, arrange, text-vertical-align, lock) / "Notes" / "Template".
- On smaller screens, tabs collapse to a single scrollable list.

- **Acceptance:** Element properties fit on a 1080p screen without scrolling through 12 panels.

**P3.8 — Searchable font picker** *(0.5 day, depends on P2.5)* 🟡 PENDING — `useFonts` already exposes `availableFonts`; swap the `<select>` for a popover rendering each font name in its own face.

- Replace `<select>` with a popover dropdown listing fonts. Each option renders its name in its own face. Typing filters. Arrow-key + Enter to select. Esc closes.
- Reuse the same component for the inline toolbar (font family) and properties panel.

- **Acceptance:** Typing "Mon" filters the list; selecting updates the active text element.

### Phase 3 milestone ✅

- The editor feels modern: smart guides, snap, autosize, rotation, real shapes, image filters, custom fonts with a polished picker, tabbed inspector.

---

## 7. Phase 4 — Power features (~2 weeks, optional / iterative)

Goal: layered workflows that distinguish slide-presenters from slide tools.

**P4.1 — Presentation templates** *(2 days)*

- Extend `SlideTemplate` to support template presentations (a deck of slides, not just a single slide).
- New `Templates` tab in the editor showing both single-slide and deck templates. Inserting a deck clones all its slides into the active presentation with fresh IDs.
- Built-in starter templates: "Sermon Series (3 slides)", "Worship Set (4 slides)", "Announcement Loop (2 slides)".

- **Acceptance:** Inserting a deck template's slides all show up with correct formatting and editable content.

**P4.2 — Master slide editor** *(2 days, builds on P2.4)*

- Add a "Master Slide Editor" view that opens the master layout in-place. Editing a master element propagates to dependent slides via the cascade rules defined in P2.4.

- **Acceptance:** Editing the master title's font-size updates all dependent slides' titles' rendering on the output.

**P4.3 — Paragraph styles inside a text element** *(2 days)*

- Add named paragraph styles ("Body", "Quote", "Header") to the theme. The inline Tiptap editor exposes these via a dropdown. Selecting a style applies the theme's styled paragraph.
- Stored as paragraph-level `attrs` in ProseMirror JSON.

- **Acceptance:** Applying "Quote" paragraph style changes alignment to italic + indented column.

**P4.4 — Keyboard productivity** *(1 day)*

- `Ctrl+Shift+>` / `<` — bump font size ±2pt on selected text elements.
- `Ctrl+arrow` — nudge selected element by grid step.
- `Ctrl+Shift+arrow` — nudge by 1px.
- `Enter` on canvas with selection → start inline editing (current dblclick behavior).
- `Tab` / `Shift+Tab` — cycle to next / previous element by z-order.
- `Space` — preview current slide on output (without going live).
- `Alt+drag` — duplicate-on-drag (creates a copy and drags the copy).

- **Acceptance:** All shortcuts work; they don't interfere with the in-editor typing.

**P4.5 — Per-element entrance animation** *(2 days)*

- Add `entrance: { type: "fade" | "slide-up" | "slide-left" | "zoom" | "none"; duration: number; delay: number }` per `BaseElement`.
- When the slide goes live, each element animates in sequence based on its `delay`.
- Reuse `framer-motion` variants defined in `getTransitionVariants` (`utils/index.ts:312`).

- **Acceptance:** An element with `entrance.fade duration=0.4 delay=0.2` fades in 200ms after the slide transitions.

**P4.6 — Offscreen canvas thumbnails** *(1 day)*

- Replace `CustomSlideRenderer` mounting at `scale={0.07}` for list thumbnails with an `OffscreenCanvas`-based renderer (or `html-to-image` / `modern-screenshot` lib). Thumbnails snapshot once and cache by slide ID.

- **Acceptance:** Scrolling a 100-slide presentation is smooth; thumbnails render in <50ms each.

**P4.7 — Live preview mode** *(1 day)*

- `Space` (or a PIP button) opens a small output window preview without going live. Allows operator to verify transitions before committing.

- **Acceptance:** Pressing Space shows the current slide animating with the configured transition; nothing is broadcast to the audience window.

### Phase 4 milestone ✅

- Master-driven, styled, multi-element-animated presentations with templated decks and keyboard-first operation.

---

## 8. Migration strategy

- **Backwards compatibility is by migration only.** Every change to `CustomSlide`/`CustomPresentation` ships with an updated `migratePresentation(pres)` that bumps `version` to the new value. Migrations are append-only (v0→v1→v2→...) and pure.
- **No silent data loss.** A migration that can't preserve a feature throws a modal: "This presentation uses an unsupported feature (X); it will be opened read-only." Out of scope for Phase 1 (no feature is removed until Phase 2 — only duplicated render paths collapsed).
- **Versioning:** `CustomPresentation.version` currently `0` or `1`; bump to `2` in Phase 2, `3` in Phase 4 (entrance animation).
- **Testing:** Phase 1 lands with a `vitest` smoke test for the migration function (one fixture presentation per source version). Phase 2 lands with snapshot tests for `CustomSlideRenderer` against a fixed mock slide. No existing tests block any phase.

---

## 9. Risks & open questions

| Risk | Mitigation |
|---|---|
| Tiptap's `generateHTML` may not produce identical output to current HTML-string path | Migrate one presentation at a time; legacy content stays as HTML-string until Phase 2's P2.2 fully lands; keep a `legacyHtml` content type for one release cycle. |
| ProseMirror schema extension for `FontSize` is fiddly | Use `TextStyle` extension's `style` attribute; well-documented pattern. Phase 1 can ship with just Bold/Italic/Underline/Color/Align and add FontFamily/FontSize in Phase 2. |
| Cross-window custom font loading (`@font-face`) in Tauri webview may need explicit sync | Test early in P2.5; if webviews don't share injected CSS, broadcast font list via `emit("fonts-loaded", faces)` to subscribe windows. |
| Discriminated-union refactor could break `serialize_presentation` on the Rust side | Verify `serde` reads the new `kind`-tagged enum without needing a Rust change. If a Rust change is needed, treat as a Phase 1.3 sub-task. |
| `结构调整` of `SlideEditor` is risky while it's so tangled | Phase 1.4 is the highest-risk task in this plan. Mitigation: keep the god component intact until P1.1, P1.2, P1.3 land; split last. Each sub-component extract from the existing body, no behavior change. |

**Open questions for the maintainer:**

1. Is there an existing design token / theming vocabulary the slide theme should align with (operator-console accent color, etc.)? **Phase 2.4 assumption:** slide theme is independent; can pull from app theme later.
2. Are there saved presentations in the wild that we must not break? If yes, Phase 2 migrations need fixture coverage of those specific files.
3. Is offline-fallback font loading required (PowerPoint ships default fonts; do we?), or are users fine bundling fonts into the presentation file? This affects P2.5's UX.
4. Should presentation import/export (`.biblepresenter.json`) move to a binary format (e.g., zipped assets) for embedded media? Out of scope for this plan, but the slide-background path changes in P2.1 make it relevant.

---

## 10. Sequenced task list (ready for an issue tracker)

Ordered; each task can be a single PR. Estimated days assume one engineer in flow.
Status icons: ✅ shipped · 🟡 pending · ⬜ not started.

### Phase 1 — Foundation ✅

1. ✅ P1.1 — Add `@tiptap/extension-font-family`, ship Tiptap-based `InlineTextEditor` — 2d
2. ✅ P1.2 — Fix `duplicateSelectedElements` + `handleVideoSelect` race bugs — 0.5d
3. ✅ P1.3 — Discriminated-union `SlideElement` refactor — 1d
4. ✅ P1.4 — Split `SlideEditor.tsx` into `slide/` modules — 3d *(depends on P1.3)*
5. ✅ P1.5 — `AbortController`-scoped drag/resize listeners — 0.5d *(part of P1.4)*
6. ✅ P1.6 — History snapshot coalescing — 1d *(depends on P1.4)*
7. ✅ P1.7 — `dangerouslySetInnerHTML` content sanitization bridge — 0.5d *(part of P1.1)*

**Phase 1 subtotal:** ~8 days — ✅ shipped.

### Phase 2 — Data model & rendering ✅

8. ✅ P2.1 — `SlideBackground` union — 1d
9. ✅ P2.2 — ProseMirror JSON content — 3d
10. ✅ P2.3 — Delete legacy slide fields + render paths — 1d *(depends on P2.1 + P2.2)*
11. ✅ P2.4 — Slide theme + master — 4d *(core cascade shipped; master editor UI deferred to P4.2)*
12. ✅ P2.5 — `@font-face` font loading — 1.5d

**Phase 2 subtotal:** ~10 days — ✅ shipped.

### Phase 3 — Editor UX polish ✅

13. ✅ P3.1 — Smart guides — 2d
14. ✅ P3.2 — Snap-to-grid — 0.5d
15. ✅ P3.3 — AutoSize text — 2d
16. ✅ P3.4 — Rotation & flip — 1d
17. ✅ P3.5 — Shape taxonomy — 1.5d
18. ✅ P3.6 — Image filters/borders/radius — 1d
19. ✅ P3.7 — Tabbed properties panel — 1d
20. ✅ P3.8 — Searchable font picker — 0.5d *(depends on P2.5)*

**Phase 3 subtotal:** ~9.5 days — ✅ shipped.

### Phase 4 — Power features (optional) ✅

21. ✅ P4.1 — Presentation templates — 2d
22. ✅ P4.2 — Master slide editor — 2d *(depends on P2.4)*
23. ✅ P4.3 — Paragraph styles — 2d
24. ✅ P4.4 — Keyboard productivity — 1d
25. ✅ P4.5 — Per-element entrance animation — 2d
26. ✅ P4.6 — Offscreen-canvas thumbnails — 1d
27. ✅ P4.7 — Live preview mode (`Space`) — 1d

**Phase 4 subtotal:** ~11 days — ✅ shipped.

**Total estimate:** 38.5 person-days ≈ 6–8 weeks with normal overhead.
**Shipped to date:** 38.5 person-days (all phases complete).

---

## 11. What we will NOT do in this plan

- Touch the live transcription pipeline, Whisper embedding, audio engine.
- Touch the lower-third overlay design (separate review).
- Touch the output window's stage window, song rendering, props renderer, camera handling.
- Touch the schedule / service / scenes subsystems.
- Change the Rust persistence schema (`sqlite`/`studio_presentations`) except where fields are renamed/types-aligned.
- Introduce a new state management library. Zustand stays.
- Add e2e automation. Manual verification criteria suffice for each task's acceptance.
- Build an export format beyond current `.biblepresenter.json`. Embedded-media packaging is a follow-up.

---

## 12. How to start

> **Update (all phases shipped):** Phases 1–4 are complete. All plan milestones are ✅. The `.biblepresenter.json` export format, entrance animations, templates, master slides, paragraph styles, keyboard-first editing, offscreen thumbnails, and the `Space` live-preview PIP are all in. Any further work falls outside this plan (see §11 — "What we will NOT do").

The original entry-point advice (kept for archive):
The lowest-risk, highest-impact first move is **P1.2 (race-condition fixes)** — 0.5 day, no prerequisites, ships independently. It unblocks confidence in the editor for the rest of the work. Then **P1.3 (discriminated union)** — 1 day, types-only, no UI change — sets up Phase 2 cleanly. Then **P1.1 (Tiptap wiring)**, then the rest of Phase 1.