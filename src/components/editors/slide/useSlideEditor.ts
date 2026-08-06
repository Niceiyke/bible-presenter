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

import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useSlideHistory, textCoalesceKey } from "./useSlideHistory";
import { useAutoSave } from "./useAutoSave";
import { useCanvasScale } from "./useCanvasScale";
import { useElementDrag, useElementResize } from "./useElementDragResize";
import { useSlideDragDrop } from "./useSlideDragDrop";
import { migratePresentation, alignElements, adjustZOrder, collectGroupMembers, type AlignmentAxis, type ZDirection } from "./helpers";
import { newDefaultSlide, newTitleSlide, newBlankSlide, stableId, relativizePath, exportPresentation, importPresentation, deepCloneSlide, newTextElement, newImageElement, newVideoElement, newShapeElement } from "../../../utils";
import { useAppStore } from "../../../store";
import { useKeyboardBinding } from "../../../hooks/keyboardRegistry";
import type { CustomPresentation, CustomSlide, MediaItem, SlideElement, SlideTemplate } from "../../../types";

export interface UseSlideEditorArgs {
  initialPres: CustomPresentation;
  onClose: (saved: boolean) => void;
}

export function useSlideEditor({ initialPres, onClose }: UseSlideEditorArgs) {
  const { appDataDir, stagedItem, setToast, setIsDirty, templates, setTemplates } = useAppStore();

  const init = () => migratePresentation(JSON.parse(JSON.stringify(initialPres)));
  // P1.4 + P1.6: history + coalescing live in the hook. `setPres` accepts
  // `(next, { save, coalesceKey })`; `undo`/`redo` operate the stack.
  const { present: pres, setPres, undo, redo, canUndo, canRedo } = useSlideHistory(init());

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

  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasScale = useCanvasScale(canvasRef);

  const isDirtyRef = useRef(false);
  const savePendingRef = useRef(false);
  const suppressClickRef = useRef(false);

  const activeElementId = activeElementIds.length === 1 ? activeElementIds[0] : null;

  const slide = pres.slides[activeSlideIdx] ?? pres.slides[0];

  // ── Auto-save debounce (P1.4) ───────────────────────────────────────────────
  useAutoSave({
    pres,
    dirtyRef: isDirtyRef,
    savingRef: savePendingRef,
    onSaveOK: () => setIsDirty(false),
  });

  // ── Undo / redo wrappers — the history stack itself lives in
  //    useSlideHistory (P1.6). These just mark the doc dirty. ──────────────────
  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    undo();
    isDirtyRef.current = true;
    setIsDirty(true);
  }, [canUndo, undo, setIsDirty]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    redo();
    isDirtyRef.current = true;
    setIsDirty(true);
  }, [canRedo, redo, setIsDirty]);

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

  // ── Global keyboard shortcuts (priority 20 — overrides operator defaults) ──
  useKeyboardBinding("slide-editor", 20, () => true, (e) => {
    const tgt = e.target as HTMLElement;
    const typing =
      tgt.tagName === "INPUT" ||
      tgt.tagName === "TEXTAREA" ||
      tgt.tagName === "SELECT" ||
      tgt.contentEditable === "true";

    if (typing) return;

    // Slide panel keyboard navigation
    if (focusedSlidePanel) {
      if (e.key === "ArrowUp") {
        e.preventDefault(); setActiveSlideIdx(i => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); setActiveSlideIdx(i => Math.min(pres.slides.length - 1, i + 1));
      } else if (e.key === "Delete") {
        e.preventDefault(); handleDeleteSlide();
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault(); e.shiftKey ? handleRedo() : handleUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
      e.preventDefault(); handleRedo();
    } else if (e.key === "Escape") {
      e.preventDefault();
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
    }
  });

  // ── Element helper: get all selected elements ───────────────────────────────
  const getSelectedElements = (): SlideElement[] =>
    slide.elements.filter(e => activeElementIds.some(id => allSelectedIds.has(id)) || activeElementIds.includes(e.id)) as SlideElement[];

  // ── Slide/element helpers ───────────────────────────────────────────────────
  const updateSlide = (next: CustomSlide) =>
    setPres(prev => { const s = [...prev.slides]; s[activeSlideIdx] = next; return { ...prev, slides: s }; });

  // `Partial<SlideElement>` widens `kind` (the discriminator) so a literal
  // spread `{ ...e, ...updates }` is no longer a `SlideElement`. Callers
  // always branch on `activeEl?.kind === "text"` (etc.) before invoking
  // kind-specific updates, so we cast back to `SlideElement` at the spread
  // site. Phase 2 can introduce a per-kind contract if needed.
  const updateElement = (id: string, updates: Partial<SlideElement>, save = true, coalesceKey: string | null = null) =>
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => e.id === id ? ({ ...e, ...updates } as SlideElement) : e) };
      return { ...prev, slides: ns };
    }, { save, coalesceKey });

  const updateElements = (ids: string[], updates: Partial<SlideElement>, save = true) =>
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => ids.includes(e.id) ? ({ ...e, ...updates } as SlideElement) : e) };
      return { ...prev, slides: ns };
    }, { save });

  const deleteElement = (id: string) => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.filter(e => e.id !== id) };
      return { ...prev, slides: ns };
    });
    setActiveElementIds(prev => prev.filter(i => i !== id));
  };

  const deleteSelectedElements = () => {
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.filter(e => !allSelectedIds.has(e.id)) };
      return { ...prev, slides: ns };
    });
    setActiveElementIds([]);
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
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, ...newEls] };
      return { ...prev, slides: ns };
    });
    setActiveElementIds(newIds);
  };

  const duplicateElement = (el: SlideElement) => {
    const n: SlideElement = { ...(el as SlideElement), id: stableId(), x: el.x + 3, y: el.y + 3, z_index: slide.elements.length + 1 };
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, n] };
      return { ...prev, slides: ns };
    });
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
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: [...cs.elements, el] };
      return { ...prev, slides: ns };
    });
    setActiveElementIds([el.id]);
    return el;
  };

  const addTextElement = () => addEl(newTextElement({ z_index: slide.elements.length + 1 }));
  const addShapeElement = () => addEl(newShapeElement({ z_index: slide.elements.length + 1 }));

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

  const handleAddSlide = (type: "default" | "title" | "blank") => {
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0,
        type === "title" ? newTitleSlide() : type === "blank" ? newBlankSlide() : newDefaultSlide());
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

  const alignElement = (type: AlignmentAxis) => {
    if (activeElementIds.length === 0) return;
    const els = slide.elements.filter(e => activeElementIds.includes(e.id));
    const updates = alignElements(els, type);
    // Commit all align deltas in a single history entry.
    setPres(prev => {
      const cs = prev.slides[activeSlideIdx];
      const ns = [...prev.slides];
      ns[activeSlideIdx] = { ...cs, elements: cs.elements.map(e => updates[e.id] ? ({ ...e, ...updates[e.id] } as SlideElement) : e) };
      return { ...prev, slides: ns };
    });
  };

  const updateZOrder = (dir: ZDirection) => {
    if (activeElementIds.length === 0) return;
    const ids = new Set(activeElementIds);
    // Behaviour parity with the pre-P1.4 code: operate on the selected
    // element that is lowest in z-order.
    const target = [...slide.elements].sort((a, b) => a.z_index - b.z_index).find(e => ids.has(e.id));
    if (!target) return;
    updateSlide({ ...slide, elements: adjustZOrder(slide.elements, target.id, dir) });
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

  // ── Element drag / resize (P1.4 + P1.5 AbortController) ─────────────────────
  const handleDrag = useElementDrag({
    canvasRef,
    activeElementIds,
    elements: slide.elements,
    onMoved: (id, updates) => updateElement(id, updates, false),
    onCommitted: (id, updates) => updateElement(id, updates, true),
  });

  const handleResize = useElementResize({
    canvasRef,
    activeElementIds,
    elements: slide.elements,
    onMoved: (id, updates) => updateElement(id, updates, false),
    onCommitted: (id, updates) => updateElement(id, updates, true),
  });

  const handleCanvasClick = (e: React.MouseEvent) => {
    setActiveElementIds([]);
  };

  const handleElementClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

  const commitInline = (id: string, html: string) => {
    // P1.6: consecutive text-edit commits on the same element within
    // COALESCE_WINDOW_MS fold into one history entry.
    updateElement(id, { content: html }, true, textCoalesceKey(id));
    setEditingElementId(null);
  };

  // ── Save / Close ────────────────────────────────────────────────────────────
  const handleSaveAndClose = async () => {
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      isDirtyRef.current = false;
      setIsDirty(false);
      onClose(true);
    } catch (err) {
      console.error("Save failed", err);
      setToast("Save failed");
    }
  };

  const handleCloseRequest = () => {
    if (isDirtyRef.current) setShowUnsavedConfirm(true);
    else onClose(false);
  };

  const handleDiscardChanges = () => {
    isDirtyRef.current = false;
    setIsDirty(false);
    setShowUnsavedConfirm(false);
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
    };
    try {
      const saved = await invoke<SlideTemplate>("save_slide_template", { template: tpl });
      setTemplates(prev => [...prev, saved]);
      setToast("Slide saved as template");
    } catch (err) { setToast("Failed to save template"); }
  };

  const handleInsertTemplate = (tpl: SlideTemplate) => {
    const cloned = deepCloneSlide(tpl.slide);
    cloned.id = stableId();
    cloned.elements.forEach(e => (e.id = stableId()));
    setPres(prev => {
      const ns = [...prev.slides];
      ns.splice(activeSlideIdx + 1, 0, cloned);
      return { ...prev, slides: ns };
    });
    setActiveSlideIdx(i => i + 1);
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
    updateSlide({ ...slide, backgroundVideo: rel, backgroundVideoLoop: true, backgroundVideoMuted: true });
    setShowBgVideoPicker(false);
  };

  const handleBgImageSelect = (path: string) => {
    updateSlide({ ...slide, backgroundImage: relativizePath(path, appDataDir) });
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
    // refs / scale
    canvasRef, canvasScale, isDirtyRef,
    // interactions
    slideDragDrop, handleSlidePointerDown, handleSlidePointerUp, handleSlideClick,
    handleDrag, handleResize,
    handleCanvasClick, handleElementClick, handleDblClick, commitInline,
    handleCloseRequest, handleSaveAndClose, handleDiscardChanges,
    handleImport, handleExport,
    handleAddSlide, handleDuplicateSlide, handleDeleteSlide,
    handleSaveAsTemplate, handleInsertTemplate, handleDeleteTemplate,
    handleImageSelect, handleVideoSelect, handleBgVideoSelect, handleBgImageSelect, handleAddVerse,
    handleInsertVerse,
    addTextElement, addShapeElement,
    updateSlide, updateElement,
    groupSelectedElements, ungroupSelectedElements,
    duplicateSelectedElements, duplicateElement,
    deleteElement, deleteSelectedElements,
    alignElement, updateZOrder,
    // global / store data
    appDataDir, templates, stagedItem,
  };
}

export type UseSlideEditor = ReturnType<typeof useSlideEditor>;