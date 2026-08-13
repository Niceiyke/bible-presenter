/**
 * `useSlideEditor` — the SlideEditor controller hook (P1.4).
 *
 * Owns the presentation state + history (`useSlideHistory`), autosave,
 * canvas scale, element drag/resize, slide drag/drop, keyboard bindings,
 * and every mutation handler. The SlideEditor component and its
 * sub-components are presentational: they receive state + callbacks from
 * here and never mutate the store directly (except appDataDir, stagedItem,
 * toasts and templates, which are genuinely global).
 *
 * The 6 extraction hooks from the plan (history / autosave / scale /
 * drag / resize / slide-drag-drop) all live in this directory and are
 * used here; this hook only *wires* them together.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useSlideHistory, textCoalesceKey } from "./useSlideHistory";
import { useAutoSave, type EditorSaveState } from "./useAutoSave";
import { useCanvasScale } from "./useCanvasScale";
import { useElementDrag, useElementResize, useElementRotation } from "./useElementDragResize";
import type { GuideLine } from "./useElementDragResize";
import { useSlideDragDrop } from "./useSlideDragDrop";
import { migratePresentation, alignElements, adjustZOrder, collectGroupMembers, synthesizeDefaultTheme, type AlignmentAxis, type ZDirection } from "./helpers";
import { elementFontSize, stepFontSize } from "./textStyleSystem";
import { newDefaultSlide, newTitleSlide, newBlankSlide, newQuoteSlide, newAnnouncementSlide, newImageCaptionSlide, newScriptureSlide, stableId, relativizePath, exportPresentation, importPresentation, deepCloneSlide, newTextElement, newImageElement, newVideoElement, newShapeElement, buildCustomSlideItem } from "../../../utils";
import { useAppStore } from "../../../store";
import { useKeyboardBinding } from "../../../hooks/keyboardRegistry";
import type { CustomPresentation, CustomSlide, MediaItem, SlideElement, SlideMaster, SlideTemplate, ProseMirrorJSON, SlideBackground, DisplayItem } from "../../../types";

export interface UseSlideEditorArgs {
  initialPres: CustomPresentation;
  onClose: (saved: boolean) => void;
  /** P3: stage the active slide into the output queue (never broadcasts). */
  onStageSlide?: (item: DisplayItem) => Promise<boolean> | boolean;
  /** P6: add the active slide to the active service plan. */
  onAddToService?: (item: DisplayItem) => Promise<void> | void;
}

/** P3: the "+ Add slide" menu layouts offered by the slide rail. */
export type AddSlideKind = "title" | "default" | "blank" | "quote" | "announcement" | "imageCaption" | "scripture";

export function useSlideEditor({ initialPres, onClose, onStageSlide, onAddToService }: UseSlideEditorArgs) {
  const { appDataDir, stagedItem, liveItem, setToast, templates, setTemplates } = useAppStore();

  const init = () => migratePresentation(JSON.parse(JSON.stringify(initialPres)));
  // P1.4 + P1.6: history + coalescing live in the hook. `setPres` accepts
  // `(next, { save, coalesceKey })`; `undo`/`redo` operate the stack.
  // The history's `setPres` is wrapped below so every document mutation
  // marks the presentation dirty and bumps the save revision.
  const { present: pres, setPres: commitPres, undo, redo, canUndo, canRedo } = useSlideHistory(init());

  // ── Save state machine (P1.x) ─────────────────────────────────────────────
  // `saveState` drives the top-bar status and the close/discard guards.
  // `revisionRef` is bumped on every document mutation; autosave clears
  // dirty only when the saved snapshot's revision is still current.
  const [saveState, setSaveState] = useState<EditorSaveState>("saved");
  const saveStateRef = useRef<EditorSaveState>("saved");
  const revisionRef = useRef(0);
  const presRef = useRef(pres);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);

  useEffect(() => { presRef.current = pres; }, [pres]);

  // Wrapped mutation entry point. Every call that reaches the history's
  // `setPres` bumps the save revision and marks the document dirty (unless
  // a save is already in flight — the revision guard still prevents the
  // pending save from clearing dirty for the newer revision).
  const setPres = useCallback<typeof commitPres>((next, opts) => {
    revisionRef.current += 1;
    if (saveStateRef.current !== "saving") {
      saveStateRef.current = "dirty";
      setSaveState("dirty");
    }
    commitPres(next, opts);
  }, [commitPres]);

  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [activeElementIds, setActiveElementIds] = useState<string[]>([]);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [focusedSlidePanel, setFocusedSlidePanel] = useState(false);

  const [showBgPicker, setShowBgPicker] = useState(false);
  const [showBgVideoPicker, setShowBgVideoPicker] = useState(false);
  const [showImgPicker, setShowImgPicker] = useState(false);
  const [showVideoPicker, setShowVideoPicker] = useState(false);
  const [showBiblePicker, setShowBiblePicker] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [dragOverSlideIdx, setDragOverSlideIdx] = useState<number | null>(null);
  const [dragSlideIdx, setDragSlideIdx] = useState<number | null>(null);

  // P3.2: snap-to-grid size in canvas-% units. `0` disables snapping.
  // Choices surfaced in the toolbar: 0 (off), 4, 8, 16.
  const [gridSize, setGridSize] = useState<number>(0);

  // P3.1: active-smart-guide overlay. Updated from inside the drag
  // lifecycle; `null` means no guides are snapping.
  const [guides, setGuides] = useState<GuideLine[] | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasScale = useCanvasScale(canvasRef);

  // P3: canvas zoom as a multiplier on the fit width (1 = fit). Changing it
  // resizes the canvas element itself, so `useCanvasScale` re-measures and
  // element coordinates, inline editing, and drag/resize stay correct.
  const [zoom, setZoom] = useState(1);

  const suppressClickRef = useRef(false);

  const activeElementId = activeElementIds.length === 1 ? activeElementIds[0] : null;

  // P4.2 — master editing. When `editingMasterId` is set the hook routes
  // every element mutation at the matching `pres.masters[...]` layout
  // instead of the active slide. The `slide` object the canvas/property
  // panel receive is a projection of the master so the existing editor
  // UI (drag/resize/properties/inline text) works unchanged.
  const [editingMasterId, setEditingMasterId] = useState<string | null>(null);
  const editingMaster = editingMasterId ? pres.masters?.find(m => m.id === editingMasterId) ?? null : null;
  const editingIsMaster = !!editingMasterId && !!editingMaster;
  const slide = editingIsMaster
    ? { id: editingMaster!.id, background: editingMaster!.background, elements: editingMaster!.elements } as CustomSlide
    : pres.slides[activeSlideIdx] ?? pres.slides[0];

  // P4.7 — in-editor live preview PIP. Toggled by `Space`; shows the active
  // slide animating with its configured entrance transitions without ever
  // broadcasting to the audience/output window.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Commit an element-list mutation against whichever target is active
  // (master layout or the current slide). Returns the new element list.
  const commitElements = useCallback((fn: (els: SlideElement[]) => SlideElement[]): void => {
    setPres(prev => {
      if (editingMasterId) {
        const masters = [...(prev.masters ?? [])];
        const idx = masters.findIndex(m => m.id === editingMasterId);
        if (idx < 0) return prev;
        masters[idx] = { ...masters[idx], elements: fn(masters[idx].elements) };
        return { ...prev, masters };
      }
      const slides = [...prev.slides];
      const si = prev.slides[activeSlideIdx] ? activeSlideIdx : 0;
      slides[si] = { ...slides[si], elements: fn(slides[si].elements) };
      return { ...prev, slides };
    });
  }, [activeSlideIdx, editingMasterId]);

  // ── Auto-save debounce (P1.4 + revision-safe P1.x) ────────────────────────
  const savePresentation = useCallback(async (p: CustomPresentation) => {
    await invoke("save_studio_presentation", { presentation: p });
  }, []);

  useAutoSave({
    pres,
    saveState,
    saveStateRef,
    setSaveState,
    revisionRef,
    save: savePresentation,
    inFlightRef: inFlightSaveRef,
    onSaveError: () => setToast("Auto-save failed"),
  });

  // ── Undo / redo wrappers — the history stack itself lives in
  //    useSlideHistory (P1.6). Undoing a saved change makes the doc dirty
  //    again and bumps the revision so the reverted state is persisted. ──────
  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    undo();
    revisionRef.current += 1;
    if (saveStateRef.current !== "saving") {
      saveStateRef.current = "dirty";
      setSaveState("dirty");
    }
  }, [canUndo, undo]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    redo();
    revisionRef.current += 1;
    if (saveStateRef.current !== "saving") {
      saveStateRef.current = "dirty";
      setSaveState("dirty");
    }
  }, [canRedo, redo]);

  // ── Get IDs to move (element + all group members) ───────────────────────────
  const getGroupIds = useCallback((id: string): string[] => {
    const el = slide.elements.find(e => e.id === id);
    if (el?.groupId) {
      return collectGroupMembers(slide.elements, el.groupId);
    }
    return [id];
  }, [slide.elements]);

  // ── All selected IDs including group members ───────────────────────────────
  const allSelectedIds = new Set<string>();
  activeElementIds.forEach(id => {
    getGroupIds(id).forEach(gid => allSelectedIds.add(gid));
  });

  // ── P4.4 ───────────────────────────────────────────────────────────────────
  // Bump font-size of every selected *text* element by `delta` points,
  // clamped through the shared typography policy. `elementFontSize`
  // resolves the `"inherit"` cascade so elements inheriting the theme
  // size step from the actual painted size, not a hard-coded 32.
  const bumpSelectedFontSize = (delta: number) => {
    for (const el of getSelectedElements()) {
      if (el.kind !== "text" || el.locked) continue;
      const base = elementFontSize(el, pres.theme);
      updateElement(el.id, { font_size: stepFontSize(base, delta) }, true, "font-size");
    }
  };

  // Nudge selected elements by a canvas-% delta. P4.4 distinguishes grid-step
  // (`Ctrl+arrow`, gridSize or 1) from fine 1px (`Ctrl+Shift+arrow`, computed
  // from the on-screen canvas width so 1 editor px ≈ 1 design px).
  const nudgeSelected = (dx: number, dy: number) => {
    const els = getSelectedElements().filter(e => !e.locked);
    if (els.length === 0) return;
    for (const el of els) {
      updateElement(el.id, { x: Math.round((el.x + dx) * 100) / 100, y: Math.round((el.y + dy) * 100) / 100 });
    }
  };

  // 1 editor-pixel in canvas-% units (canvas scales with the viewport).
  const pxToCanvas = () => {
    const w = canvasRef.current?.clientWidth ?? 800;
    return 100 / w;
  };

  // ── Global keyboard shortcuts (priority 20 — overrides operator defaults) ──
  useKeyboardBinding("slide-editor", 20, () => true, (e) => {
    const tgt = e.target as HTMLElement;
    const typing =
      tgt.tagName === "INPUT" ||
      tgt.tagName === "TEXTAREA" ||
      tgt.tagName === "SELECT" ||
      tgt.contentEditable === "true";

    if (typing) return;

    // Slide panel keyboard navigation (Alt is reserved for reordering below)
    if (focusedSlidePanel && !(e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault(); setActiveSlideIdx(i => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); setActiveSlideIdx(i => Math.min(pres.slides.length - 1, i + 1));
      } else if (e.key === "Delete") {
        e.preventDefault(); handleDeleteSlide();
      }
    }

    // P3: Alt+ArrowUp/ArrowDown reorders the active slide in the rail
    // (keyboard reorder actions per §5.3). Ctrl+Arrow stays reserved for
    // nudging selected elements.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      handleMoveActiveSlide(e.key === "ArrowUp" ? -1 : 1);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault(); e.shiftKey ? handleRedo() : handleUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
      e.preventDefault(); handleRedo();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (previewOpen) { setPreviewOpen(false); return; }
      setActiveElementIds([]); setEditingElementId(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (activeElementIds.length > 0) { e.preventDefault(); deleteSelectedElements(); }
    } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
      e.preventDefault();
      if (activeElementIds.length > 0) duplicateSelectedElements();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "g") {
      e.preventDefault();
      if (activeElementIds.length > 1) groupSelectedElements();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "u") {
      e.preventDefault();
      ungroupSelectedElements();
    } else if (e.key === "r" || e.key === "R") {
      // P3.4: rotate the active element(s) by ±15°. `R` = clockwise
      // (Shift held), `r` = counter-clockwise.
      if (activeElementIds.length === 0) return;
      e.preventDefault();
      const delta = e.shiftKey ? 15 : -15;
      for (const id of activeElementIds) {
        const el = slide.elements.find(x => x.id === id);
        if (el && !el.locked) updateElement(id, { rotation: ((el.rotation ?? 0) + delta + 540) % 360 - 180 });
      }
    }
    // ── P4.4 keyboard productivity ──────────────────────────────────────────
    else if ((e.ctrlKey || e.metaKey) && (e.key === ">" || e.key === ".") && e.shiftKey) {
      e.preventDefault(); bumpSelectedFontSize(2);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "<" || e.key === ",") && e.shiftKey) {
      e.preventDefault(); bumpSelectedFontSize(-2);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const step = e.shiftKey ? pxToCanvas() : (gridSize > 0 ? gridSize : 1);
      const dir = e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : e.key === "ArrowLeft" ? [-step, 0] : [step, 0];
      nudgeSelected(dir[0], dir[1]);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const mediaEls = slide.elements.slice().sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
      if (mediaEls.length === 0) return;
      if (e.key === "Tab") {
        const curIdx = mediaEls.findIndex(el => activeElementIds.includes(el.id));
        const step = e.shiftKey ? -1 : 1;
        const next = mediaEls[(curIdx + step + mediaEls.length) % mediaEls.length];
        setActiveElementIds([next.id]);
        setEditingElementId(null);
      } else {
        // Enter → start inline editing the first selected *text* element.
        const t = mediaEls.find(el => activeElementIds.includes(el.id) && el.kind === "text");
        if (t) setEditingElementId(t.id);
      }
    } else if (e.code === "Space" && !(e.ctrlKey || e.metaKey || e.altKey)) {
      // P4.7 — live preview: toggle the in-editor PIP that plays the
      // current slide's entrance transitions. Nothing goes to the
      // audience/output window.
      e.preventDefault();
      setPreviewOpen(p => !p);
    }
  });

  // ── Element helper: get all selected elements ───────────────────────────────
  const getSelectedElements = (): SlideElement[] =>
    slide.elements.filter(e => activeElementIds.some(id => allSelectedIds.has(id)) || activeElementIds.includes(e.id)) as SlideElement[];

  // ── Slide/element helpers ───────────────────────────────────────────────────
  const updateSlide = (next: CustomSlide) => {
    if (editingIsMaster) {
      const master = editingMaster;
      // When editing a master, the only "slide-level" mutation reachable via
      // the panel is background styling. Route to the master layout.
      setPres(prev => {
        const masters = [...(prev.masters ?? [])];
        const idx = masters.findIndex(m => m.id === master.id);
        if (idx < 0) return prev;
        masters[idx] = { ...masters[idx], background: next.background };
        return { ...prev, masters };
      });
      return;
    }
    setPres(prev => { const s = [...prev.slides]; s[activeSlideIdx] = next; return { ...prev, slides: s }; });
  };

  // `Partial<SlideElement>` widens `kind` (the discriminator) so a literal
  // spread `{ ...e, ...updates }` is no longer a `SlideElement`. Callers
  // always branch on `activeEl?.kind === "text"` (etc.) before invoking
  // kind-specific updates, so we cast back to `SlideElement` at the spread
  // site. Phase 2 can introduce a per-kind contract if needed.
  const updateElement = (id: string, updates: Partial<SlideElement>, save = true, coalesceKey: string | null = null) =>
    setPres(prev => {
      if (editingMasterId) {
        const masters = [...(prev.masters ?? [])];
        const mi = masters.findIndex(m => m.id === editingMasterId);
        if (mi < 0) return prev;
        // Find the touched master element to learn its role for cascading.
        const touched = masters[mi].elements.find(e => e.id === id);
        const role = touched?.kind === "text" ? touched.role : undefined;
        let nextMasters = masters;
        nextMasters[mi] = { ...masters[mi], elements: masters[mi].elements.map(e => e.id === id ? ({ ...e, ...updates } as SlideElement) : e) };
        // P4.2 cascade: when a master element is edited, dependent slides
        // with the same role inherit geometry + style but keep their text.
        const slides = prev.slides.map(s =>
          s.masterRef === editingMasterId && role
            ? { ...s, elements: s.elements.map(e => e.kind === "text" && e.role === role ? ({ ...e, ...updates } as SlideElement) : e) }
            : s
        );
        return { ...prev, masters: nextMasters, slides };
      }
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => e.id === id ? ({ ...e, ...updates } as SlideElement) : e) };
      return { ...prev, slides: ns };
    }, { save, coalesceKey });

  const updateElements = (ids: string[], updates: Partial<SlideElement>, save = true) =>
    setPres(prev => {
      if (editingMasterId) {
        const masters = [...(prev.masters ?? [])];
        const mi = masters.findIndex(m => m.id === editingMasterId);
        if (mi < 0) return prev;
        masters[mi] = { ...masters[mi], elements: masters[mi].elements.map(e => ids.includes(e.id) ? ({ ...e, ...updates } as SlideElement) : e) };
        return { ...prev, masters };
      }
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => ids.includes(e.id) ? ({ ...e, ...updates } as SlideElement) : e) };
      return { ...prev, slides: ns };
    }, { save });

  const deleteElement = (id: string) => {
    commitElements(els => els.filter(e => e.id !== id));
    setActiveElementIds(prev => prev.filter(i => i !== id));
  };

  const deleteSelectedElements = () => {
    // P4: locked elements cannot be accidentally deleted — skip them so a
    // stray Delete only removes unlocked members of the selection.
    commitElements(els => els.filter(e => !allSelectedIds.has(e.id) || e.locked));
    setActiveElementIds(prev => prev.filter(id => {
      const el = slide.elements.find(e => e.id === id);
      return el?.locked;
    }));
  };

  const duplicateSelectedElements = () => {
    const toDup = getSelectedElements();
    if (toDup.length === 0) return;
    // P1.2 fix: compute duplicates (with stable IDs) up front so the same
    // IDs are used both for the slide update and the selection update.
    // Previously `setActiveElementIds` generated IDs independently of
    // `setPres`, producing IDs that pointed at nothing.
    let z = slide.elements.length + 1;
    const newEls: SlideElement[] = toDup.map(el => ({
      ...(el as SlideElement),
      id: stableId(),
      x: el.x + 3,
      y: el.y + 3,
      z_index: z++,
    }));
    const newIds = newEls.map(e => e.id);
    commitElements(els => [...els, ...newEls]);
    setActiveElementIds(newIds);
  };

  const duplicateElement = (el: SlideElement) => {
    const n: SlideElement = { ...(el as SlideElement), id: stableId(), x: el.x + 3, y: el.y + 3, z_index: slide.elements.length + 1 };
    commitElements(els => [...els, n]);
    setActiveElementIds([n.id]);
  };

  const groupSelectedElements = () => {
    const toGroup = activeElementIds.filter(id => slide.elements.find(e => e.id === id && !e.groupId));
    if (toGroup.length < 2) return;
    const groupId = stableId();
    updateElements(toGroup, { groupId });
    setToast(`${toGroup.length} elements grouped (Ctrl+G)`);
  };

  const ungroupSelectedElements = () => {
    const toUngroup = activeElementIds
      .map(id => slide.elements.find(e => e.id === id))
      .filter((e): e is SlideElement => !!e?.groupId)
      .flatMap(e => slide.elements.filter(x => x.groupId === e.groupId).map(x => x.id));
    if (toUngroup.length === 0) return;
    updateElements([...new Set(toUngroup)], { groupId: undefined });
    setToast("Group ungrouped (Ctrl+U)");
  };

  // `addEl` returns the element it added so callers that need to mutate it
  // in the *same tick* (e.g. setting src immediately after picking a video)
  // can do so without reading stale slide state. See P1.2 race fix on
  // `handleVideoSelect`.
  const addEl = (el: SlideElement): SlideElement => {
    commitElements(els => [...els, el]);
    setActiveElementIds([el.id]);
    return el;
  };

  const addTextElement = () => addEl(newTextElement({ z_index: slide.elements.length + 1 }));
  // P3.5: shape insertion now accepts a kind so the toolbar dropdown
  // can stub `rect`/`circle`/… directly into the new element.
  const addShapeElement = (shape: "rect" | "rounded" | "circle" | "line" | "triangle" = "rect") =>
    addEl(newShapeElement({ z_index: slide.elements.length + 1, shape }));

  const handleInsertVerse = () => {
    if (stagedItem?.type !== "Verse") return;
    const v = stagedItem.data;
    addEl(newTextElement({
      x: 10, y: 10, w: 80, h: 80, z_index: slide.elements.length + 1,
      content: `${v.text}\n— ${v.book} ${v.chapter}:${v.verse}`,
      font_size: 40, font_family: "Georgia", align: "center", v_align: "middle",
      italic: true, shadow: true, shadow_color: "#000",
    }));
  };

  const handleAddSlide = (type: AddSlideKind) => {
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0,
        type === "title" ? newTitleSlide()
          : type === "blank" ? newBlankSlide()
            : type === "quote" ? newQuoteSlide()
              : type === "announcement" ? newAnnouncementSlide()
                : type === "imageCaption" ? newImageCaptionSlide()
                  : type === "scripture" ? newScriptureSlide()
                    : newDefaultSlide());
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementIds([]);
  };

  const handleDuplicateSlide = () => {
    setPres(prev => {
      const ns = [...prev.slides];
      const copy: CustomSlide = JSON.parse(JSON.stringify(ns[activeSlideIdx]));
      copy.id = stableId();
      copy.elements.forEach((e: SlideElement) => (e.id = stableId()));
      ns.splice(activeSlideIdx + 1, 0, copy);
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
    setActiveElementIds([]);
  };

  const handleDeleteSlide = () => {
    if (pres.slides.length <= 1) return;
    setPres(prev => ({ ...prev, slides: prev.slides.filter((_, i) => i !== activeSlideIdx) }));
    setActiveSlideIdx(i => Math.max(0, i - 1));
    setActiveElementIds([]);
  };

  const handleMoveSlide = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    setPres(prev => {
      const ns = [...prev.slides];
      const [moved] = ns.splice(fromIdx, 1);
      ns.splice(toIdx, 0, moved);
      return { ...prev, slides: ns };
    });
    if (fromIdx === activeSlideIdx) setActiveSlideIdx(toIdx);
    else if (fromIdx < activeSlideIdx && toIdx >= activeSlideIdx) setActiveSlideIdx(i => i - 1);
    else if (fromIdx > activeSlideIdx && toIdx <= activeSlideIdx) setActiveSlideIdx(i => i + 1);
  };

  /** P3: stage the active slide into the output queue. Uses the in-memory
   *  presentation (with any unsaved edits) so the operator can preview the
   *  exact slide they are looking at. */
  const stageCurrentSlide = useCallback(async () => {
    const presCurrent = presRef.current;
    const slideIdx = Math.min(activeSlideIdx, presCurrent.slides.length - 1);
    const summary = { id: presCurrent.id, name: presCurrent.name, slide_count: presCurrent.slides.length };
    const item = buildCustomSlideItem(summary, presCurrent.slides, slideIdx, presCurrent.theme);
    setStaging(true);
    try {
      const ok = await onStageSlide?.(item);
      if (ok !== false) setToast(`Slide ${slideIdx + 1} staged`);
    } catch (err) {
      setToast("Failed to stage slide: " + String(err));
    } finally {
      setStaging(false);
    }
  }, [activeSlideIdx, onStageSlide, setToast]);

  /** P6: add the active slide to the active service plan via the shared
   *  `addToSchedule` path (same mutation + persistence as Service Plan). */
  const addToServiceCurrentSlide = useCallback(async () => {
    const presCurrent = presRef.current;
    const slideIdx = Math.min(activeSlideIdx, presCurrent.slides.length - 1);
    const item = buildCustomSlideItem({ id: presCurrent.id, name: presCurrent.name, slide_count: presCurrent.slides.length }, presCurrent.slides, slideIdx, presCurrent.theme);
    try {
      await onAddToService?.(item);
    } catch (err) {
      setToast("Failed to add to service: " + String(err));
    }
  }, [activeSlideIdx, onAddToService, setToast]);

  /** P6: is the active slide the one currently staged or on air? Returns a
   *  textual status (never color alone) so the header can show an indicator. */
  const currentSlideStatus: "live" | "staged" | "idle" = (() => {
    const isMatch = (it: DisplayItem | null): boolean =>
      it?.type === "CustomSlide" && it.data.presentation_id === pres.id && it.data.slide_index === activeSlideIdx;
    if (isMatch(liveItem)) return "live";
    if (isMatch(stagedItem)) return "staged";
    return "idle";
  })();

  const [staging, setStaging] = useState(false);

  const canMoveSlideUp = activeSlideIdx > 0;
  const canMoveSlideDown = activeSlideIdx < pres.slides.length - 1;
  const handleMoveActiveSlide = (dir: -1 | 1) => {
    if (dir === -1 ? !canMoveSlideUp : !canMoveSlideDown) return;
    handleMoveSlide(activeSlideIdx, activeSlideIdx + dir);
  };

  const alignElement = (type: AlignmentAxis) => {
    if (activeElementIds.length === 0) return;
    const els = slide.elements.filter(e => activeElementIds.includes(e.id));
    const updates = alignElements(els, type);
    // Route through `commitElements` so aligning inside a master edits the
    // master layout (not the active slide) and produces a single history entry.
    commitElements(prev => prev.map(e => updates[e.id] ? ({ ...e, ...updates[e.id] } as SlideElement) : e));
  };

  const updateZOrder = (dir: ZDirection) => {
    if (activeElementIds.length === 0) return;
    const ids = new Set(activeElementIds);
    // Behaviour parity with the pre-P1.4 code: operate on the selected
    // element that is lowest in z-order. `commitElements` routes to the
    // master when editing a master layout.
    const target = [...slide.elements].sort((a, b) => a.z_index - b.z_index).find(e => ids.has(e.id));
    if (!target) return;
    commitElements(els => adjustZOrder(els, target.id, dir));
  };

  /** P4: move a specific element (by id) in the z-order, invoked from the
   *  Layers panel. `commitElements` routes to the master layout when a
   *  master is being edited, and produces a single undo entry. */
  const handleZOrderElement = (id: string, dir: ZDirection) => {
    if (!slide.elements.some(e => e.id === id)) return;
    commitElements(els => adjustZOrder(els, id, dir));
  };

  // ── Slide reordering via pointer drag (P1.4) ────────────────────────────────
  const slideDragDrop = useSlideDragDrop({
    onMove: handleMoveSlide,
    onDragStateChange: (state) => {
      setDragSlideIdx(state ? state.from : null);
      setDragOverSlideIdx(state ? state.over : null);
    },
  });

  const handleSlidePointerDown = (i: number, ev: React.PointerEvent) => {
    // A new pointer cycle always starts with a clean click-suppression flag
    // (no setTimeout needed — the flag is consumed by the click that follows
    // a drag, or cleared here on the next pointerdown).
    suppressClickRef.current = false;
    slideDragDrop.onPointerDownSlide(i, ev);
  };

  const handleSlidePointerUp = (i: number, ev: React.PointerEvent) => {
    const wasDragging = slideDragDrop.isDragging();
    slideDragDrop.onPointerUpSlide(i, ev);
    // A pointerup after a drag is followed by a synthetic `click` on the
    // origin button; arm the suppression flag so a drag doesn't also select
    // the slide. The flag is consumed by `handleSlideClick` if the click
    // fires on a slide button, or cleared by the next pointerdown otherwise.
    if (wasDragging) suppressClickRef.current = true;
  };

  const handleSlideClick = (i: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setActiveSlideIdx(i);
    setActiveElementIds([]);
    setEditingElementId(null);
  };

  // ── Element drag / resize (P1.4 + P1.5 AbortController + P3.2 snap + P3.1 guides) ──
  const handleDrag = useElementDrag({
    canvasRef,
    activeElementIds,
    elements: slide.elements,
    onMoved: (id, updates) => updateElement(id, updates, false),
    onCommitted: (id, updates) => updateElement(id, updates, true),
    gridSize,
    onGuides: setGuides,
    // P4.4 — Alt+drag: duplicate the clicked element first, then drag the
    // copy. The hook commits the copy through `onMoved`/`onCommitted`, so
    // the duplicate becomes part of the drag's single history entry.
    altDuplicate: (id) => {
      const el = slide.elements.find(e => e.id === id);
      if (!el || el.locked) return null;
      const n: SlideElement = {
        ...(el as SlideElement),
        id: stableId(),
        x: el.x,
        y: el.y,
        z_index: slide.elements.length + 1,
      };
      setPres(prev => {
        if (editingMasterId) {
          const masters = [...(prev.masters ?? [])];
          const mi = masters.findIndex(m => m.id === editingMasterId);
          if (mi < 0) return prev;
          masters[mi] = { ...masters[mi], elements: [...masters[mi].elements, n] };
          return { ...prev, masters };
        }
        const cs = prev.slides[activeSlideIdx];
        const ns = [...prev.slides];
        ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, n] };
        return { ...prev, slides: ns };
      }, { save: false });
      setActiveElementIds([n.id]);
      setEditingElementId(null);
      return { id: n.id, x: n.x, y: n.y };
    },
  });

  const handleResize = useElementResize({
    canvasRef,
    activeElementIds,
    elements: slide.elements,
    onMoved: (id, updates) => updateElement(id, updates, false),
    onCommitted: (id, updates) => updateElement(id, updates, true),
    gridSize,
  });

  // P3.4 — rotation hook
  const handleRotate = useElementRotation({
    canvasRef,
    elements: slide.elements,
    onMoved: (id, updates) => updateElement(id, updates, false),
    onCommitted: (id, updates) => updateElement(id, updates, true),
  });

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Clicking empty canvas clears the selection AND ends inline editing
    // (the green ring). Ending editing here unmounts the InlineTextEditor,
    // whose cleanup effect commits its content — so further text changes
    // aren't lost.
    setActiveElementIds([]);
    setEditingElementId(null);
  };

  const handleElementClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Clicking a (possibly different) element also ends inline editing,
    // committing the active editor. `editingElementId` is cleared so the
    // green editing ring doesn't linger under the new selection.
    setEditingElementId(null);
    if (e.ctrlKey || e.metaKey) {
      setActiveElementIds(prev =>
        prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
      );
    } else {
      setActiveElementIds([id]);
    }
  };

  const handleDblClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const el = slide.elements.find(x => x.id === id);
    if (el?.kind === "text" && !el.locked) setEditingElementId(id);
  };

  const commitInline = (id: string, doc: ProseMirrorJSON) => {
    // P1.6: consecutive text-edit commits on the same element within
    // COALESCE_WINDOW_MS fold into one history entry.
    //
    // P2.2: content is now a ProseMirror JSON doc (Tiptap `getJSON`).
    // The inline editor still represents bold/italic as Tiptap marks
    // (seeded across the doc on open and dropped from the box-level
    // font-weight force). Clearing `el.bold`/`el.italic` here makes the
    // projection renderer stop force-bolding the whole element, so
    // per-word <strong>/<em> marks (and their absence after un-bold)
    // are honoured.
    updateElement(id, { content: doc, bold: false, italic: false }, true, textCoalesceKey(id));
    setEditingElementId(null);
  };

  // ── Save / Close ────────────────────────────────────────────────────────────
  // Manual save, autosave, retry, and Save & Close all share
  // `savePresentation`. Close never silently abandons an in-flight save.
  const handleRetrySave = async () => {
    if (saveStateRef.current === "saving") return;
    try {
      await savePresentation(presRef.current);
      saveStateRef.current = "saved";
      setSaveState("saved");
      setToast("Saved");
    } catch (err) {
      console.error("Save failed", err);
      saveStateRef.current = "save-failed";
      setSaveState("save-failed");
      setToast("Save failed — try again");
    }
  };

  const handleSaveAndClose = async () => {
    try {
      if (inFlightSaveRef.current) {
        // Wait for the pending autosave to finish (its failure is ignored;
        // we always persist a fresh snapshot below before closing).
        await inFlightSaveRef.current.catch(() => {});
      }
      await savePresentation(presRef.current);
      saveStateRef.current = "saved";
      setSaveState("saved");
      onClose(true);
    } catch (err) {
      console.error("Save failed", err);
      saveStateRef.current = "save-failed";
      setSaveState("save-failed");
      setToast("Save failed — try again");
    }
  };

  const handleCloseRequest = () => {
    if (saveStateRef.current !== "saved") setShowUnsavedConfirm(true);
    else onClose(false);
  };

  const handleDiscardChanges = async () => {
    setShowUnsavedConfirm(false);
    if (inFlightSaveRef.current) {
      // Never abandon a pending save silently: wait for it so we know what
      // actually reached disk before closing.
      try {
        await inFlightSaveRef.current;
      } catch {
        setToast("A pending save failed; changes may not be on disk");
      }
    }
    saveStateRef.current = "saved";
    onClose(false);
  };

  // ── Export / Import ─────────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      const filePath = await saveDialog({
        defaultPath: `${pres.name.replace(/[^a-zA-Z0-9]/g, "_")}.biblepresenter.json`,
        filters: [{ name: "Bible Presenter File", extensions: ["json"] }],
      });
      if (!filePath) return;
      const exp = exportPresentation({ presentation: pres });
      const json = JSON.stringify(exp, null, 2);
      // Write via invoke to get filesystem access
      await invoke("write_text_file", { path: filePath, content: json });
      setToast("Presentation exported");
    } catch (err) { setToast("Export failed: " + String(err)); }
  };

  const handleImport = async () => {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "Bible Presenter Files", extensions: ["json"] }],
      });
      if (!sel || typeof sel !== "string") return;
      const content = await invoke<string>("read_text_file", { path: sel });
      const data = JSON.parse(content);
      const result = importPresentation(data);
      if (!result.success || !result.presentation) {
        setToast(result.error || "Import failed");
        return;
      }
      const imported = result.presentation as CustomPresentation;
      imported.id = stableId();
      imported.name = imported.name + " (Imported)";
      imported.slides.forEach(s => {
        s.id = stableId();
        s.elements.forEach(e => (e.id = stableId()));
      });
      setPres(imported);
      setActiveSlideIdx(0);
      setActiveElementIds([]);
      setToast("Imported successfully — press Save to keep");
    } catch (err) { setToast("Import failed: " + String(err)); }
  };

  // ── Templates ───────────────────────────────────────────────────────────────
  const handleSaveAsTemplate = async () => {
    const slide = pres.slides[activeSlideIdx];
    const templateSlide = deepCloneSlide(slide);
    templateSlide.id = stableId();
    templateSlide.elements.forEach(e => (e.id = stableId()));
    const tpl: SlideTemplate = {
      id: stableId(),
      name: `Template ${templates.length + 1}`,
      category: "Custom",
      slide: templateSlide,
      created_at: Date.now(),
    };    try {
      const saved = await invoke<SlideTemplate>("save_slide_template", { template: tpl });
      setTemplates(prev => [...prev, saved]);
      setToast("Slide saved as template");
    } catch (err) { setToast("Failed to save template"); }
  };

  const handleInsertTemplate = (tpl: SlideTemplate) => {
    // P4.1: templates may be single-slide (`slide`) or a deck (`slides`).
    // Inserting a deck splice-clones every slide into the presentation
    // right after the active slide, each with fresh IDs.
    const slides = tpl.slides && tpl.slides.length > 0 ? tpl.slides : tpl.slide ? [tpl.slide] : [];
    const clones = slides.map(s => {
      const cloned = deepCloneSlide(s);
      cloned.id = stableId();
      cloned.elements.forEach(e => (e.id = stableId()));
      return cloned;
    });
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0, ...clones);
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + clones.length);
    setActiveElementIds([]);
    setShowTemplateGallery(false);
    setToast(`Inserted template: ${tpl.name}`);
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await invoke("delete_slide_template", { id });
      setTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { setToast("Failed to delete template"); }
  };

  // ── Selection-derived values passed down to the sub-components ──────────────
  const activeEl: SlideElement | null = activeElementId
    ? slide.elements.find(e => e.id === activeElementId) ?? null
    : null;

  const selectedCount = activeElementIds.length;
  const hasGroup = activeElementIds.some(id => !!slide.elements.find(e => e.id === id)?.groupId);
  const multiSelectActive = selectedCount > 1;

  const handleImageSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    if (activeEl?.kind === "image") {
      updateElement(activeEl.id, { content: rel });
    } else {
      addEl(newImageElement({ z_index: slide.elements.length + 1, content: rel }));
    }
    setShowImgPicker(false);
  };

  const handleVideoSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    if (activeEl?.kind === "video") {
      updateElement(activeEl.id, { content: rel });
    } else {
      // P1.2 fix: previously called `addVideoElement()` then immediately
      // read the *previous render's* `slide.elements[...]` to update its
      // content — but state hadn't flushed, so the new video element kept
      // an empty `content` and the user had to re-pick. Now we build the
      // full element upfront and add it atomically.
      addEl(newVideoElement({ z_index: slide.elements.length + 1, content: rel }));
    }
    setShowVideoPicker(false);
  };

  const handleBgVideoSelect = (path: string) => {
    const rel = relativizePath(path, appDataDir);
    updateSlide({ ...slide, background: { type: "video", value: rel, loop: true, muted: true } });
    setShowBgVideoPicker(false);
  };

  const handleBgImageSelect = (path: string) => {
    updateSlide({ ...slide, background: { type: "image", value: relativizePath(path, appDataDir), objectFit: "cover" } });
  };

  /** P2.1: builder for any kind of background swap from the PropertiesPanel.
   *  Single source of truth so the panel UI's "one type at a time"
   *  invariant stays atomic in the history stack. */
  const setSlideBackground = (bg: SlideBackground) => updateSlide({ ...slide, background: bg });

  /**
   * P2.4: patch the presentation-level `SlideTheme`. Single-entry-commit
   * so theme edits produce one history entry each (no per-element array
   * stamping). Callers pass a partial `SlideTheme` to update specific
   * fields; missing fields stay inherited-as-before.
   */
  const updateTheme = (next: Partial<CustomPresentation["theme"]>) =>
    setPres(prev => ({ ...prev, theme: { ...(prev.theme ?? synthesizeDefaultTheme()), ...next } as CustomPresentation["theme"] }));

  // ── P4.2 — Master slide editing ─────────────────────────────────────────────
  // The master is a reusable layout (`pres.masters[]`). Editing it in-place
  // routes every element mutation through the shared `updateElement` /
  // `commitElements` above (they target the master when `editingMasterId`
  // is set). Dependent slides — those with `masterRef === master.id` and an
  // element carrying the same `role` — receive style/geometry updates from
  // the master element while keeping their own text content.
  const enterMasterEdit = (masterId: string) => {
    setEditingMasterId(masterId);
    setActiveElementIds([]);
    setEditingElementId(null);
  };

  const exitMasterEdit = () => {
    setEditingMasterId(null);
    setActiveElementIds([]);
    setEditingElementId(null);
  };

  /** P4.2: build a `SlideMaster` from the current slide. Text elements get
   *  an auto-assigned role (title → first text, body → rest, footer → last)
   *  so dependent slides can later be styled by the cascade. */
  const handleCreateMaster = (name: string) => {
    const src = pres.slides[activeSlideIdx];
    if (!src) return;
    const textEls = src.elements.filter(e => e.kind === "text");
    const roles = new Map<string, "title" | "body" | "footer">();
    textEls.forEach((el, i) => {
      roles.set(el.id, i === 0 ? "title" : i === textEls.length - 1 && textEls.length > 2 ? "footer" : "body");
    });
    const master: SlideMaster = {
      id: stableId(),
      name: name || `${pres.name} Master ${(pres.masters?.length ?? 0) + 1}`,
      background: deepCloneSlide(src).background,
      elements: src.elements.map(e => {
        const el = deepCloneSlide(src).elements.find(x => x.id === e.id)!;
        const r = roles.get(e.id);
        return r ? { ...el, role: r } : el;
      }),
    };
    setPres(prev => ({ ...prev, masters: [...(prev.masters ?? []), master] }));
    setEditingMasterId(master.id);
    setActiveElementIds([]);
    setToast("Master created — editing it now (styles cascade to slides)");
  };

  /** P4.2: copy the master layout onto the active slide as editable
   *  placeholders, tagging each with its `role` so later master edits
   *  cascade into it. The slide keeps its own background/text. One atomic
   *  history entry: both the element clone and the `masterRef` stamp are
   *  committed in a single `setPres`. */
  const handleApplyMasterToSlide = (masterId: string) => {
    const master = pres.masters?.find(m => m.id === masterId);
    if (!master) return;
    const clones: SlideElement[] = master.elements.map(e => ({ ...JSON.parse(JSON.stringify(e)) as SlideElement, id: stableId() }));
    setPres(prev => {
      const slides = [...prev.slides];
      const cs = slides[activeSlideIdx];
      slides[activeSlideIdx] = {
        ...cs,
        masterRef: masterId,
        elements: [...cs.elements.filter(el => el.kind !== "text" || !(el as any).role), ...clones],
      };
      return { ...prev, slides };
    });
    setToast("Master applied to this slide");
  };

  const handleDeleteMaster = (masterId: string) => {
    setPres(prev => ({ ...prev, masters: (prev.masters ?? []).filter(m => m.id !== masterId) }));
    if (editingMasterId === masterId) setEditingMasterId(null);
  };

  const handleAddVerse = (verse: { text: string; book: string; chapter: number; verse: number; version: string }) => {
    addEl(newTextElement({
      x: 10, y: 10, w: 80, h: 80, z_index: slide.elements.length + 1,
      content: `${verse.text}\n\n— ${verse.book} ${verse.chapter}:${verse.verse} (${verse.version})`,
      font_size: 40, font_family: "Georgia", align: "center", v_align: "middle",
      italic: true, shadow: true, shadow_color: "#000",
    }));
    setShowBiblePicker(false);
  };

  return {
    // presentation state
    pres, setPres, handleUndo, handleRedo, canUndo, canRedo,
    // selection / editing state
    activeSlideIdx, setActiveSlideIdx,
    activeElementIds, setActiveElementIds,
    editingElementId, setEditingElementId,
    focusedSlidePanel, setFocusedSlidePanel,
    slide, activeEl, selectedCount, hasGroup, multiSelectActive,
    // modal visibility
    showBgPicker, setShowBgPicker,
    showBgVideoPicker, setShowBgVideoPicker,
    showImgPicker, setShowImgPicker,
    showVideoPicker, setShowVideoPicker,
    showBiblePicker, setShowBiblePicker,
    showUnsavedConfirm, setShowUnsavedConfirm,
    showTemplateGallery, setShowTemplateGallery,
    dragSlideIdx, dragOverSlideIdx,
    gridSize, setGridSize,
    guides,
    // refs / scale
    canvasRef, canvasScale,
    // P3 — canvas zoom (1 = fit)
    zoom, setZoom,
    // save state
    saveState, handleRetrySave,
    // interactions
    slideDragDrop, handleSlidePointerDown, handleSlidePointerUp, handleSlideClick,
    handleDrag, handleResize, handleRotate,
    handleCanvasClick, handleElementClick, handleDblClick, commitInline,
    handleCloseRequest, handleSaveAndClose, handleDiscardChanges,
    handleImport, handleExport,
    handleAddSlide, handleDuplicateSlide, handleDeleteSlide,
    handleMoveSlide, handleMoveActiveSlide, canMoveSlideUp, canMoveSlideDown,
    stageCurrentSlide, addToServiceCurrentSlide, currentSlideStatus, staging,
    handleSaveAsTemplate, handleInsertTemplate, handleDeleteTemplate,
    handleImageSelect, handleVideoSelect, handleBgVideoSelect, handleBgImageSelect, handleAddVerse,
    handleInsertVerse,
    addTextElement, addShapeElement,
    updateSlide, updateElement,
    groupSelectedElements, ungroupSelectedElements,
    duplicateSelectedElements, duplicateElement,
    deleteElement, deleteSelectedElements,
    alignElement, updateZOrder, handleZOrderElement,
    setSlideBackground,
    updateTheme,
    // P4.2 — master editing
    editingMasterId, enterMasterEdit, exitMasterEdit,
    handleCreateMaster, handleApplyMasterToSlide, handleDeleteMaster,
    // P4.7 — in-editor live preview
    previewOpen, setPreviewOpen,
    // global / store data
    appDataDir, templates, stagedItem,
  };
}

export type UseSlideEditor = ReturnType<typeof useSlideEditor>;