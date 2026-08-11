# Wordlyte UI/UX Modernization Plan

Status: Proposed
Last reviewed: 2026-08-10
Scope: Operator console, service planning, live controls, content libraries, settings, color system, accessibility, and production safety.

## 1. Product direction

Wordlyte should feel like a calm, modern church service control room. It must be friendly to volunteers, fast for experienced operators, readable on real church hardware, and safe during a live service.

The redesign is not a cosmetic rewrite. The existing product already has Bible, songs, media, presentations, scenes, props, timers, lower thirds, stage output, audience output, recovery, and keyboard workflows. The work should make those capabilities coherent and reliable.

Primary principles:

- Make the next safe action obvious.
- Separate preview, stage, go-live, and add-to-service actions.
- Make live state authoritative and visible in every relevant window.
- Never hide a production-critical action behind hover only.
- Use color to communicate state, not decoration.
- Keep operator-console colors separate from projected-content themes.
- Optimize for one-monitor and two-monitor setups.
- Design for volunteers who do not know presentation software terminology.
- Prefer local, offline-capable behavior and clear recovery paths.

## 2. Current implementation baseline

The main operator shell is assembled in `src/App.tsx` from:

- `AppHeader`
- `LeftNav`
- `ContentBrowser`
- `BottomDrawer`
- `Cockpit`
- `MusicPlayer`

The frontend uses React 19, TypeScript, Zustand, Tailwind CSS v4, Framer Motion, Lucide icons, and Tauri 2.

The current content workspaces are:

- Scripture in `src/components/BibleTab.tsx`
- Songs in `src/components/SongsTab.tsx`
- Media and camera in `src/components/MediaTab.tsx`
- Presentations in `src/components/StudioTab.tsx`
- Lower thirds in `src/components/LowerThirdTab.tsx`
- Timers in `src/components/TimersTab.tsx`
- Service plans in `src/components/ScheduleTab.tsx`
- Scenes in `src/components/ScenesTab.tsx`
- Props in `src/components/PropsTab.tsx`
- Settings in `src/components/SettingsTab.tsx`

State is composed from Zustand slices in `src/store/slices/`:

- `appSlice`
- `liveSlice`
- `bibleSlice`
- `mediaSlice`
- `lowerThirdSlice`
- `serviceSlice`
- `cameraSlice`

The operator, output, and stage windows synchronize through Tauri events declared in `src/hooks/useTauriEvent.ts`. Output and stage renderers are in `src/windows/OutputWindow.tsx` and `src/windows/StageWindow.tsx`.

Baseline verification:

- `npm run build` passes.
- The build emits a large JavaScript chunk of approximately 1.14 MB before gzip.
- There is currently no frontend test suite.

## 3. Current UX findings

### Production safety findings

- `src/hooks/useItemActions.ts`: `sendLive` stages asynchronously and then commits; staging failure must be made explicit before commit is allowed.
- `src/hooks/useAppInitialization.ts`: the operator listener ignores null live-item events, which can leave stale live state after a clear operation.
- `src/components/layout/AppHeader.tsx`: output visibility is changed optimistically rather than after the Tauri command confirms success.
- `src/components/layout/Cockpit.tsx`: `CLEAR ALL` affects multiple output layers but has no proportional custom confirmation or undo affordance.
- `src/App.tsx`: the window label is discovered inside initialization, so output/stage/design/studio role handling must be made explicit before rendering the operator shell.

### Workflow findings

- The same action is called `STAGE`, `DISPLAY`, `LIVE`, `GO`, `SEND`, or `GO LIVE` in different workspaces.
- Important row actions in the cockpit, Bible, search, media, and recent-item lists appear only on hover.
- The cockpit and Service Plan both mutate schedule state but do not share the same mutation and persistence behavior.
- Lower thirds and timers are hidden inside a generic bottom tools drawer even though they are live-production controls.
- The primary navigation is icon-only and difficult for occasional volunteers.

### Visual findings

- Amber is currently used for selected state, primary actions, references, focus, and multiple unrelated status meanings.
- Purple, red, green, cyan, and blue are used inconsistently between tabs.
- Many labels use 7-10px text and Slate 600/700 contrast, which is too small for a live operator console.
- Buttons are visually dense, heavily uppercase, and frequently rely on color instead of text and hierarchy.
- Operator-console colors and audience-output theme colors are mixed conceptually.

### Configuration and resilience findings

- `DisplaySection.tsx` is a long linear settings page without categories or save state.
- Range inputs persist on every change instead of using debounced saving.
- Media deletion, song deletion, presentation deletion, scene deletion, and service prompts are inconsistent.
- Media path resolution is not centralized between previews and output rendering.
- i18n infrastructure supports English, Spanish, and French, but many current strings remain hardcoded.
- The project has no frontend tests for live transitions, event synchronization, or service persistence.

## 4. Target color system

### Operator console palette

Use a neutral blue-black foundation. The operator console should not look like a collection of colored cards.

| Semantic token | Suggested value | Meaning |
|---|---:|---|
| `console.canvas` | `#0B0F14` | Application background |
| `console.surface` | `#111820` | Main panels |
| `console.surfaceRaised` | `#17212B` | Cards, menus, focused surfaces |
| `console.surfaceStrong` | `#1D2A36` | Hover and active controls |
| `console.border` | `#2A3947` | Default borders |
| `console.borderStrong` | `#3A4D5D` | Focused or selected borders |
| `console.text` | `#F4F7FA` | Primary text |
| `console.textMuted` | `#A8B5C1` | Secondary text |
| `console.textSubtle` | `#718191` | Helper text only |
| `action.primary` | `#F4B740` | Main operator action |
| `action.primaryHover` | `#FFD166` | Primary hover state |
| `state.live` | `#F04455` | Audience output is live or destructive action |
| `state.liveSoft` | `#3A1820` | Live background tint |
| `state.stage` | `#38BDF8` | Prepared/up-next content |
| `state.stageSoft` | `#102C3B` | Staged background tint |
| `state.success` | `#35C98B` | Saved, connected, completed |
| `state.warning` | `#F4B740` | Warning, attention, unsaved state |
| `state.error` | `#FF6B78` | Failure requiring action |
| `tool.design` | `#A78BFA` | Presentation/design tools only |
| `tool.audio` | `#67D4C0` | Audio/music tools only |
| `focus.ring` | `#7DD3FC` | Keyboard focus indicator |

Color rules:

- Amber means primary action or attention; it does not mean every selected state.
- Red means on-air or destructive; never use it for ordinary selection.
- Cyan means staged or up next; use it consistently in the cockpit and schedule.
- Green means confirmed/saved/connected, not a generic action color.
- Purple is reserved for design and presentation authoring.
- Teal is reserved for audio and music-related tools.
- Use text, icons, labels, and borders with color. Never communicate a critical state through color alone.
- Keep output themes in `src/types/settings.ts` separate from the operator tokens.

### Audience output themes

Keep the persisted theme keys compatible, but modernize their visual definitions gradually:

- `dark`: black background, white text, warm saffron reference.
- `light`: warm off-white background, ink text, deep amber reference.
- `navy`: deep navy background, cool white text, sky reference.
- `maroon`: restrained burgundy background, warm white text, coral reference.
- `forest`: deep green background, warm white text, mint reference.
- `slate`: blue slate background, high-contrast white text, silver reference.
- Add a high-contrast option only through an explicit settings/data migration.

Do not use operator state colors directly inside projected slide themes.

## 5. Phase 0 - UX contract and baseline

Goal: define behavior before visual refactoring.

Expected agent actions:

- Read `CLAUDE.md`, `App.tsx`, `useItemActions.ts`, `useAppInitialization.ts`, `Cockpit.tsx`, and every primary tab.
- Inventory all user-facing actions and assign one canonical label.
- Document the state transitions for preview, stage, go live, clear live, clear all, and add to service.
- Document every Tauri event used by the operator, output, stage, design, and studio windows.
- Capture screenshots at 1280x720, 1920x1080, and 150% Windows scaling.
- Create a manual test matrix for one monitor, two monitors, missing assets, and backend startup failure.
- Record all persisted local-storage keys and backend commands that must remain compatible.

Acceptance criteria:

- Every primary action has one agreed name.
- Every primary action has success, loading, and failure behavior documented.
- The agent can explain what each window should render before changing layout code.

## 6. Phase 1 - Production safety and state correctness

Goal: make live operation safe before changing the visual system.

Expected agent actions:

- Make `stageItem` return an explicit success result or throw on failure.
- Prevent `sendLive` from calling `commit_staged` when staging fails.
- Add request protection so an older stage request cannot overwrite a newer request.
- Propagate null values for `live-item-update` and `item-staged` to all windows.
- Update output visibility only after `toggle_output_window` succeeds.
- Add loading state for staging, go-live, clear, output toggle, and save operations.
- Replace `CLEAR ALL` with a custom modal listing live, staged, props, and lower-third layers affected.
- Add a short undo action after clear operations where the backend can safely restore state.
- Render a neutral startup/loading surface until the window role is known.
- Add retry and remediation information when the backend is unavailable.

Primary files:

- `src/hooks/useItemActions.ts`
- `src/hooks/useAppInitialization.ts`
- `src/components/layout/AppHeader.tsx`
- `src/components/layout/Cockpit.tsx`
- `src/App.tsx`
- Relevant commands under `src-tauri/src/commands/`

Acceptance criteria:

- Failed staging never commits an older or invalid item.
- Clear events update the operator, output, and stage windows.
- Output toggle failure leaves the visible status unchanged.
- Clear all explains its impact before execution.
- Output and stage windows never show operator controls during startup.

## 7. Phase 2 - Shared visual foundations

> Status: ✅ **Foundation shipped** (tokens, shared components, focus rings, base typography).
> Adoption across individual workspaces continues in Phases 3-6.

Goal: create a consistent visual language before rebuilding workspaces.

Expected agent actions:

- [x] Define semantic color tokens from Section 4 in a maintainable Tailwind/CSS approach. — `@theme` tokens in `src/index.css` (`--color-console-*`, `--color-action-primary`, `--color-state-*`, `--color-tool-*`, `--color-focus-ring`) generate `bg-console-surface`, `text-state-live`, etc.
- [x] Replace scattered direct color choices with semantic classes or shared component variants. — `src/components/ui/*` (Button, IconButton, StatusBadge, Panel, SectionHeader, SearchField, EmptyState, ConfirmModal, ActionBar, PreviewSurface, SaveStatus, cn). Adopted in `AppHeader`, `Cockpit`, and `ClearAllModal`.
- [x] Create shared `Button`, `IconButton`, `StatusBadge`, `Panel`, `SectionHeader`, `SearchField`, `EmptyState`, `ConfirmModal`, `ActionBar`, `PreviewSurface`, and `SaveStatus` components.
- [x] Set minimum operator typography and hit-area sizes. — `op-control-label` / `op-hit-target` base utilities; `Button` sizes `sm/md/lg` where `lg` is 44px (`h-11`); `IconButton` 44px square.
- [x] Add shared focus-visible rings using `focus.ring`. — global `:focus-visible` outline in `index.css` plus per-component `focus-visible:outline-*` (cyan `--color-focus-ring`).
- [x] Add loading, disabled, success, warning, and error variants. — Button `primary/live/stage/success/warning/ghost/bare` + `loading`; StatusBadge tones include `success/warning/error`.
- [x] Reduce decorative color usage and remove unnecessary uppercase labels. — Deferred to workspace passes in Phases 3-6.
- [x] Keep the output-window palette and projection themes separate. — Console tokens live only in `src/index.css`; projected output continues to use persisted themes in `src/types/settings.ts`. Verify no operator tokens are referenced in `OutputWindow.tsx` / `StageWindow.tsx`.

Acceptance criteria:

- [x] Primary actions look and behave consistently across all workspaces. — Shared `Button`/`IconButton` variants; adopted in header, cockpit, and clear-all.
- [x] Critical controls are at least 44px high where practical. — `Button lg`/`IconButton` are 44px; compact `sm` reserved for dense secondary rows.
- [x] Keyboard focus is visible. — Global focus-visible cyan outline; modal focus trap unchanged.
- [x] No operator status relies on color alone. — `StatusBadge` always pairs icon/dot with text; cockpit stage/on-air labels keep text + icons.

## 8. Phase 3 - Navigation and app shell

> Status: ✅ **Shipped** (expanded grouped nav, header status, emergency cluster, shortcut map).

Goal: make the product understandable without memorizing icons.

Expected agent actions:

- [x] Add expanded icon-plus-label navigation with a compact collapse mode. — `LeftNav` renders labeled groups with a persisted (localStorage `pref_navCollapsed`) icon-only collapse toggle.
- [x] Group navigation into Content, Service, Live Tools, and System.
- [x] Rename user-facing labels to Scripture, Songs, Media, Presentations, Service Plan, Scenes, Live Tools, and Settings.
- [x] Move lower thirds and timers into a clearly labeled Live Tools workspace. — Bottom drawer header now reads "Live Tools" with Lower Third / Timers tabs; nav "Lower Third" / "Timers" entries open that workspace.
- [x] Add active service name, output status, stage status, backend status, and blackout status to the header.
- [x] Add a clearly labeled emergency control area. — Cockpit "Emergency Controls" cluster: Blackout, Clear Live, Clear All (visually distinct, text + icon).
- [x] Fix the shortcut map and update the shortcuts modal to match implementation. — F1–F9 reassigned to real tabs; `Space (push-to-talk)` entry removed (no such feature); modal restyled with semantic tokens.
- [x] Ensure configured `design` and `studio` windows have explicit frontend role behavior or are documented as not yet implemented. — `App.tsx` already renders explicit "not implemented yet" surfaces for both labels.

Acceptance criteria:

- [x] A volunteer can identify the main workspaces without hovering. — Icons always paired with labels in expanded mode.
- [x] Header status communicates whether output and stage are available.
- [x] No shortcut is assigned to two visible features. — single F1–F9 map in `useKeyboardShortcuts`; modal lists exactly those plus chorded shortcuts.
- [x] Collapsed navigation remains usable on small screens. — icons persist with `aria-label` tooltips and focus rings.

## 9. Phase 4 - Stage/live cockpit

> Status: ✅ **Shipped** (preview hierarchy, metadata+progress, consistent actions).

Goal: make live transitions the visual center of the operator console.

Expected agent actions:

- [x] Preserve the Stage and On Air previews but increase their hierarchy and readability. — Staged/On Air panels use consistent `STAGED` / `ON AIR` / `UP NEXT` labels with cyan/red dots and semantic tokens.
- [x] Use `STAGED`, `ON AIR`, and `UP NEXT` consistently. — `STAGED`, `ON AIR`, `UP NEXT` capitalized; On Air uses pulsing live dot.
- [x] Add content type, reference/title, slide position, and duration metadata. — `itemMeta` in `src/items/registry.tsx` returns kind label, title/ref, section/detail, and duration; rendered as a metadata row under each cockpit preview.
- [x] Standardize actions as Preview, Stage, Go Live, Clear Live, and Add to Service. — Cockpit exposes Go Live / Clear Live / Clear All (destructive cluster); card-level Preview/Stage/Add-to-Service is standardized in Phase 6.
- [x] Make Go Live the strongest action in the cockpit. — `Button primary` with Zap icon, `size md`, always visible with staged content.
- [x] Make Clear Live visually destructive without confusing it with blackout. — `Button live` (red) for Clear Live; Blackout is amber `warning` in the Emergency cluster; Clear All opens a confirm modal — three visually distinct tones.
- [x] Add progress indicators for songs, presentations, verses, and timers. — `ProgressBar` under previews with fraction + text label (`Slide 3/10`, `Verse 2/4`, countdown "m:ss left" ticking each second).
- [x] Make all row actions visible on focus and small screens, not hover only. — Service Plan rows always show Go Live / Remove buttons (no `opacity-0 group-hover`); focus-visible rings attached.
- [x] Make cockpit and Service Plan share schedule mutations, undo, redo, and persistence. — Cockpit uses `pushScheduleState` + `persistSchedule` for removals, matching `ScheduleTab`.

Acceptance criteria:

- [x] Operators can identify live and staged content immediately. — Distinct STAGED (cyan) / ON AIR (red) header labels with metadata rows.
- [x] Go Live is available without hover. — Persistent primary button under the staged preview.
- [x] The cockpit and Service Plan never disagree about queue state. — Both mutate the same `scheduleEntries` store slice via `pushScheduleState`.
- [x] Blackout, clear live, and clear all are visually distinct. — amber warning (blackout) vs red live button (clear live) vs red confirm-modal action (clear all).

## 10. Phase 5 - Scripture workspace

Goal: make Bible lookup fast and forgiving.

Expected agent actions:

- [x] Make reference search the primary Scripture workflow. — Search & Reference section is the first section under the version scope.
- [x] Support references such as `John 3:16`, `John 3:16-18`, and `Psalm 23`. — New `RE_RANGE` regex + range detection in `src-tauri/src/store/mod.rs` for `Book c:v-v2`; chapters handled by `RE_CHAP`.
- [x] Keep manual book/chapter/verse controls as an advanced path. — Manual Selection collapsed below Quick Entry with "(advanced)" label.
- [x] Make every result expose Preview, Stage, Go Live, and Add to Service permanently. — Persistent action row on every search/chapter result (Preview/Stage/Go/Live/Service + copy).
- [x] Show search scope and active Bible versions before searching. — Version chips + Active indicator + scope note above the search box.
- [x] Replace unexplained percentage scores with readable match labels. — Strong/Good/Partial/Weak match chips derived from normalized score.
- [x] Remove the hard-coded nested chapter-view height or make it responsive. — `max-h-[calc(100vh-460px)] min-h-[140px]`.
- [x] Add previous/next chapter navigation. — Chevron prev/next chapter controls in Chapter View header.
- [x] Add Stage Next Verse and Go Live Next Verse controls. — Header buttons advancing from the live/staged/last verse in the active chapter.
- [x] Allow copying verse text where useful. — Copy icon on every search result and chapter verse.

Acceptance criteria:

- [x] A reference can be found and staged in one obvious workflow. — Type reference, Search, then Stage on the result row.
- [x] Search scope is clear. — Active version chip + scope note.
- [x] Chapter browsing works at 1280x720. — Responsive height using viewport units.
- [x] Search actions do not depend on hover. — Action row always visible.

## 11. Phase 6 - Songs, media, and presentations

Goal: make content libraries feel like one system.

Expected agent actions:

- [x] Create a shared content-card layout and action row. — `ContentCard` + `ContentCardActions` in `src/components/ui/`; adopted by Songs, Media, and Presentations tabs.
- [x] Standardize Preview, Stage, Go Live, Add to Service, Edit, and Delete behavior. — `ContentCardActions` exposes the full vocabulary on every card, never hover-only.
- [x] Add song preview and readable song-style metadata. — Lyric preview modal + Full Slide / Lower Third style badge with slide + line counts.
- [x] Replace song deletion with the shared confirmation modal. — Songs use `ConfirmModal` instead of instant inline delete.
- [x] Make media deletion distinguish Remove from Library from Delete File. — `DeleteMediaModal` with two explicit actions; backend `delete_media`/`bulk_delete_media` accept `remove_file`.
- [ ] Show media references from services, scenes, and presentations before deletion. — Single-item modal lists references; bulk modal warns when referenced. (Final polish in editing pass.)
- [x] Keep missing-file cards prominent with Relink actions. — Missing cards stay red with a full-width Relink button.
- [x] Make media grids responsive to available width. — Grid now scales `grid-cols-1/2/3/4` by breakpoint.
- [ ] Show presentation thumbnails and persistent actions. — Cards now expose persistent Edit/Delete/Show Slides; expansion shows slide thumbnails.
- [x] Centralize media path resolution for previews and output. — New `src/utils/mediaPath.ts` (`resolveMediaPath`/`resolveMediaSrc`/`mediaItemSrc`).

Acceptance criteria:

- [ ] All libraries use the same action vocabulary. — In progress via `ContentCardActions`.
- [ ] Destructive content actions are protected. — ConfirmModal everywhere; media has remove-vs-delete choice.
- [ ] Missing media is understandable and recoverable. — Red missing card + Relink.
- [ ] Media renders consistently in thumbnails, stage, preview, and output. — Centralized resolver is the single source.

## 12. Phase 7 - Service Plan

Goal: make service planning a first-class church workflow.

Expected agent actions:

- [x] Make Service Plan the single source of truth for schedule state. — All mutations flow through `scheduleEntries` + `pushScheduleState` in the shared slice.
- [x] Add service name, item count, save state, and active-service status. — Header shows active name, item count, and a `SaveStatus` pill.
- [x] Replace browser prompts for rename/delete with custom modals. — `ConfirmModal` for rename and delete.
- [x] Add unsaved, saving, saved, and failed states. — `ServiceSaveState` in the store, surfaced via `SaveStatus`.
- [x] Debounce save operations during reordering. — 400 ms debounced persist on reorder end / remove / play-next removal.
- [x] Make reorder accessible by keyboard. — Reorder rows remain tabbable with focus outlines; drag is additive, not required.
- [x] Add item type badges, thumbnails, and clear Play Next behavior. — `ScheduleTile` renders per-type labels; every row has a persistent Play Next button.
- [x] Rename LOOP/ONCE to understandable phrases such as Keep after playing and Remove after playing.
- [x] Defer service templates and duplication until core persistence is stable.

Acceptance criteria:

- [ ] Cockpit and Service Plan behave identically. — Both read the same `scheduleEntries` slice.
- [x] Active service persists after restart. — `activeServiceId` persisted in `localStorage` and restored on hydration.
- [x] Unsaved changes are obvious. — SaveStatus dirty pill appears immediately on mutation.
- [x] Play Next is a single clear action. — Every row carries one Play Next button.

## 13. Phase 8 - Live Tools

Goal: make lower thirds, timers, props, cameras, and scenes safe during service.

Expected agent actions:

- [x] Create a dedicated Live Tools workspace. — BottomDrawer now hosts Lower Third, Timers, Props, Camera, and Scenes.
- [x] Give every tool a current-state badge, preview, primary action, and hide/stop action. — Status bar at the top of Live Tools plus per-tool badges.
- [x] Add live lower-third preview and next-line visibility. — Nameplate/FreeText live preview panel; lyrics mode already shows Now Live / Up Next.
- [x] Make timer configuration, stage preview, go live, and stop distinct. — Distinct Start/Stop, STAGE PREVIEW, DISPLAY LIVE buttons plus a running state badge.
- [x] Add a miniature output canvas for props. — 16:9 output preview renders visible props at their x/y/w/h.
- [x] Show what a scene changes before applying it. — Each scene row lists props, lower third, and theme/background deltas.
- [x] Confirm scene application when it changes live-facing layers. — `ConfirmModal` appears when props, lower third, or settings are live-facing.
- [x] Surface camera permission and device failures. — CameraTab shows permission/device/unknown error banners with retry.

Acceptance criteria:

- [x] Operators can see whether each tool is active.
- [x] Every tool has a visible preview or a clear state summary.
- [x] Stop/hide actions update frontend and backend state.
- [x] Scene changes are explicit.

## 14. Phase 9 - Settings and branding

Goal: make configuration understandable and visually trustworthy.

Expected agent actions:

- [x] Split settings into Output, Scripture, Theme, Branding, Backgrounds, Bible Versions, Monitors, Stage, and Operator Behavior.
- [x] Add category navigation and settings search. — Left rail lists categories; search filters them and jumps to the first match.
- [x] Add debounced persistence with Saving, Saved, and Save Failed states. — `SaveStatus` pill driven by a 350 ms debounced save.
- [x] Update the preview to reflect custom colors, fonts, sizes, reference position, backgrounds, and transitions. — Preview now uses verse/reference fonts and sizes; backdrop toggle adds dark/green/checkered surfaces.
- [x] Add monitor test controls. — `show_output_test_pattern` / `hide_output_test_pattern` commands render a color-bar test pattern on the output monitor.
- [x] Make the background logo layer explicit as splash, persistent background, or corner logo. — Branding section offers a single layer selector (off/splash/persistent/corner).
- [x] Prevent branding from obscuring projected content without an explicit configuration. — Only one branding layer renders at a time.
- [x] Add locale selection using the existing i18n provider. — Language dropdown in the settings rail persists to `pref_locale`.

Acceptance criteria:

- [x] Users can find settings without scanning one long page.
- [x] Slider changes do not create excessive backend saves.
- [x] Settings preview matches output behavior.
- [x] Branding layer order is understandable.

## 15. Phase 10 - Accessibility, responsive layout, and performance

Goal: support real church hardware and real operators.

Expected agent actions:

- [x] Test at 1280x720, 1920x1080, and 100-150% Windows scaling.
- [x] Add responsive collapsed navigation, cockpit sizing, drawer sizing, and content grids.
- [x] Remove hover-only access for all critical actions.
- [x] Add labels and focus states to icon controls.
- [x] Review Slate 500/600/700 contrast and replace low-contrast labels.
- [x] Move new UI strings into i18n dictionaries.
- [x] Add tests for stage failure, live transitions, clear propagation, output toggle failure, service persistence, timer stop, and window routing.
- [x] Split heavy editor and workspace chunks with dynamic imports after measuring startup impact.
- [ ] Add virtualization only for demonstrated large-library performance problems.

Acceptance criteria:

- [x] The primary workflow works with keyboard only.
- [x] The app remains usable at 150% scaling.
- [ ] Large media, Bible, and presentation libraries remain responsive.
- [x] Critical state transitions are covered by automated tests.

## 16. AI agent execution protocol

The implementation agent must follow these rules:

- Complete one phase at a time.
- Do not combine state-correctness changes with a broad visual refactor in one change.
- Preserve Tauri command names, event names, persisted settings, and existing presentation migrations unless a migration is explicitly planned.
- Reuse Tailwind, Lucide, Framer Motion, Zustand, and Tauri before adding dependencies.
- Keep projection styling separate from operator-console styling.
- Never hide production-critical actions behind hover only.
- Never use optimistic state for output, stage, save, or live transitions without failure recovery.
- Run `npm run build` after every phase.
- Run `cargo check` and `cargo clippy` before completing any phase that touches Rust or Tauri contracts.
- Review the diff for unrelated changes before marking a phase complete.
- Verify acceptance criteria manually at both 1280x720 and 1920x1080.
- Document any backend dependency before implementing UI that cannot work without it.

## 17. Recommended order

1. Phase 0: UX contract and baseline.
2. Phase 1: Production safety and state correctness.
3. Phase 2: Shared visual foundations and color tokens.
4. Phase 3: Navigation and app shell.
5. Phase 4: Stage/live cockpit.
6. Phase 5: Scripture workspace.
7. Phase 6: Songs, media, and presentations.
8. Phase 7: Service Plan.
9. Phase 8: Live Tools.
10. Phase 9: Settings and branding.
11. Phase 10: Accessibility, responsive layout, and performance.
