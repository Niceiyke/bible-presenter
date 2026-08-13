import React, { useRef, useState, useLayoutEffect, useEffect } from "react";
import { X, PanelRightClose, PanelLeftOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { useSlideEditor } from "./slide/useSlideEditor";
import { CustomSlideRenderer } from "../shared/Renderers";
import { AppHeader } from "./slide/AppHeader";
import { SlideListPanel } from "./slide/SlideListPanel";
import { EditorToolbar } from "./slide/EditorToolbar";
import { SlideCanvas } from "./slide/SlideCanvas";
import { PropertiesPanel } from "./slide/PropertiesPanel";
import { ZoomControls } from "./slide/ZoomControls";
import { SlideEditorModals } from "./slide/SlideEditorModals";
import { useReferenceHeight } from "../../hooks/useReferenceHeight";
import type { CustomPresentation, CustomSlide, MediaItem, SlideTheme, DisplayItem } from "../../types";

// ─── Main SlideEditor ────────────────────────────────────────────────────────
// P1.4: this component is presentational. All state + mutation handlers live
// in the `useSlideEditor` controller hook; this file only owns the markup and
// wires the returned callbacks into the split sub-components.
interface SlideEditorProps {
  initialPres: CustomPresentation;
  mediaImages: MediaItem[];
  media: MediaItem[];
  onClose: (saved: boolean) => void;
  /** P3: stage the active slide into the output queue (never broadcasts). */
  onStageSlide?: (item: DisplayItem) => Promise<boolean> | boolean;
  /** P6: add the active slide to the active service plan (shared schedule path). */
  onAddToService?: (item: DisplayItem) => Promise<void> | void;
}

// P3: below this window width the inspector collapses to a reopen strip so the
// canvas stays the visual priority on small operator windows.
const INSPECTOR_COLLAPSE_BREAKPOINT = 1100;

export function SlideEditor({ initialPres, media, mediaImages, onClose, onStageSlide, onAddToService }: SlideEditorProps) {
  const {
    pres, setPres, handleUndo, handleRedo, canUndo, canRedo,
    activeSlideIdx, setActiveSlideIdx, activeElementIds, setActiveElementIds, editingElementId,
    focusedSlidePanel, setFocusedSlidePanel,
    slide, activeEl, selectedCount, hasGroup, multiSelectActive,
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
    canvasRef, canvasScale,
    zoom, setZoom,
    saveState, handleRetrySave,
    slideDragDrop, handleSlidePointerDown, handleSlidePointerUp, handleSlideClick,
    handleDrag, handleResize, handleRotate,
    handleCanvasClick, handleElementClick, handleDblClick, commitInline,
    handleCloseRequest, handleSaveAndClose, handleDiscardChanges,
    handleImport, handleExport,
    handleAddSlide, handleDuplicateSlide, handleDeleteSlide,
    handleMoveActiveSlide, canMoveSlideUp, canMoveSlideDown,
    stageCurrentSlide, addToServiceCurrentSlide, currentSlideStatus, staging,
    handleZOrderElement,
    handleSaveAsTemplate, handleInsertTemplate, handleDeleteTemplate,
    handleImageSelect, handleVideoSelect, handleBgVideoSelect, handleBgImageSelect, handleAddVerse,
    handleInsertVerse,
    addTextElement, addShapeElement,
    updateSlide, updateElement,
    groupSelectedElements, ungroupSelectedElements,
    duplicateSelectedElements, duplicateElement,
    deleteElement, deleteSelectedElements,
    alignElement, updateZOrder,
    setSlideBackground,
    updateTheme,
    editingMasterId, enterMasterEdit, exitMasterEdit,
    handleCreateMaster, handleApplyMasterToSlide, handleDeleteMaster,
    previewOpen, setPreviewOpen,
    // global / store data
    appDataDir, templates, stagedItem,
  } = useSlideEditor({ initialPres, onClose, onStageSlide });

  // P3: inspector collapsibility. Auto-collapse below the breakpoint so the
  // canvas never gets squeezed on a 1280×720 operator window with scaling.
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => {
    const check = () => setInspectorOpen(window.innerWidth >= INSPECTOR_COLLAPSE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <div className="fixed inset-0 z-[60] bg-console-canvas flex flex-col font-sans">

      {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
      <AppHeader
        name={pres.name}
        onNameChange={v => setPres({ ...pres, name: v }, { coalesceKey: "presentation:name" })}
        saveState={saveState}
        onRetrySave={handleRetrySave}
        slideIndex={activeSlideIdx}
        slideCount={pres.slides.length}
        onClose={handleCloseRequest}
        onUndo={handleUndo}
        canUndo={canUndo}
        onRedo={handleRedo}
        canRedo={canRedo}
        onImport={handleImport}
        onExport={handleExport}
        onSaveAndClose={handleSaveAndClose}
        previewOpen={previewOpen}
        onTogglePreview={() => setPreviewOpen(p => !p)}
        onStage={stageCurrentSlide}
        onAddToService={onAddToService ? addToServiceCurrentSlide : undefined}
        staging={staging}
        slideStatus={currentSlideStatus}
      />

      <div className="flex-1 flex overflow-hidden">

        {/* ══ LEFT: SLIDE PANEL + TEMPLATES ════════════════════════════════════ */}
        <SlideListPanel
          slides={pres.slides}
          activeSlideIdx={activeSlideIdx}
          dragSlideIdx={dragSlideIdx}
          dragOverSlideIdx={dragOverSlideIdx}
          onFocusChange={setFocusedSlidePanel}
          onPointerDownSlide={handleSlidePointerDown}
          onPointerMoveSlide={slideDragDrop.onPointerMoveSlide}
          onPointerEnterSlide={slideDragDrop.onPointerEnterSlide}
          onPointerUpSlide={handleSlidePointerUp}
          onSelect={handleSlideClick}
          onAddSlide={handleAddSlide}
          onOpenTemplates={() => setShowTemplateGallery(true)}
          onDuplicateSlide={handleDuplicateSlide}
          onDeleteSlide={handleDeleteSlide}
          onMoveSlide={handleMoveActiveSlide}
          canMoveUp={canMoveSlideUp}
          canMoveDown={canMoveSlideDown}
          canDeleteSlide={pres.slides.length > 1}
          appDataDir={appDataDir}
          theme={pres.theme}
        />

        {/* ══ CENTER: TOOLBAR + CANVAS ═══════════════════════════════════════ */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <EditorToolbar
            activeEl={activeEl}
            selectedCount={selectedCount}
            multiSelectActive={multiSelectActive}
            hasGroup={hasGroup}
            insertVerseEnabled={stagedItem?.type === "Verse"}
            canDeleteSlide={pres.slides.length > 1}
            gridSize={gridSize}
            onSetGridSize={setGridSize}
            onInsertVerse={handleInsertVerse}
            onAddText={addTextElement}
            onAddShape={addShapeElement}
            onAddVideo={() => setShowVideoPicker(true)}
            onOpenImgPicker={() => setShowImgPicker(true)}
            onOpenVideoPicker={() => setShowVideoPicker(true)}
            onOpenBiblePicker={() => setShowBiblePicker(true)}
            onGroup={groupSelectedElements}
            onUngroup={ungroupSelectedElements}
            onDuplicateSelected={duplicateSelectedElements}
            onDeleteSelected={deleteSelectedElements}
            onUpdateElement={updateElement}
            onDuplicateSlide={handleDuplicateSlide}
            onDeleteSlide={handleDeleteSlide}
          />

          <SlideCanvas
            slide={slide}
            canvasRef={canvasRef}
            canvasScale={canvasScale}
            zoom={zoom}
            appDataDir={appDataDir}
            activeElementIds={activeElementIds}
            editingElementId={editingElementId}
            slideIndex={activeSlideIdx}
            slideCount={pres.slides.length}
            gridSize={gridSize}
            guides={guides}
            theme={pres.theme}
            onCanvasClick={handleCanvasClick}
            onElementClick={handleElementClick}
            onDblClick={handleDblClick}
            onDrag={handleDrag}
            onResize={handleResize}
            onRotate={handleRotate}
            onCommit={commitInline}
            onNavigate={delta => { setActiveSlideIdx(i => i + delta); setActiveElementIds([]); }}
          />

          <div className="absolute bottom-5 right-5 z-[70] pointer-events-auto">
            <ZoomControls zoom={zoom} onZoomChange={setZoom} />
          </div>
        </div>

        {/* ══ RIGHT: PROPERTIES + NOTES PANEL ════════════════════════════════════ */}
        {inspectorOpen ? (
          <div className="flex shrink-0">
            <PropertiesPanel
              activeEl={activeEl}
              selectedCount={selectedCount}
              hasGroup={hasGroup}
              slide={slide}
              theme={pres.theme}
              masters={pres.masters}
              editingMasterId={editingMasterId}
              onUpdateSlide={updateSlide}
              onUpdateTheme={updateTheme}
              onApplyThemePreset={(p) => {
                updateTheme({ textColor: p.textColor, accentColor: p.accentColor, defaultFontFamily: p.defaultFontFamily, defaultFontSize: p.defaultFontSize });
                setSlideBackground({ type: "color", value: p.background });
              }}
              onUpdateElement={updateElement}
              onOpenBgPicker={() => setShowBgPicker(true)}
              onOpenBgVideoPicker={() => setShowBgVideoPicker(true)}
              onSetBackground={setSlideBackground}
              onSaveAsTemplate={handleSaveAsTemplate}
              onAlign={alignElement}
              onZOrder={updateZOrder}
              onZOrderElement={handleZOrderElement}
              onSelectElement={(id, additive) => setActiveElementIds(prev => additive ? (prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]) : [id])}
              onLock={() => activeEl && updateElement(activeEl.id, { locked: !activeEl.locked })}
              onDuplicateElement={() => activeEl && duplicateElement(activeEl)}
              onDeleteElement={() => activeEl && deleteElement(activeEl.id)}
              onGroup={groupSelectedElements}
              onUngroup={ungroupSelectedElements}
              onEnterMasterEdit={enterMasterEdit}
              onExitMasterEdit={exitMasterEdit}
              onCreateMaster={handleCreateMaster}
              onApplyMaster={handleApplyMasterToSlide}
              onDeleteMaster={handleDeleteMaster}
            />
            <button
              onClick={() => setInspectorOpen(false)}
              aria-label="Collapse inspector"
              title="Collapse inspector"
              className="w-5 border-l border-console-border bg-console-surface hover:bg-console-surface-strong flex items-center justify-center transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <PanelRightClose size={14} className="text-console-text-muted" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setInspectorOpen(true)}
            aria-label="Expand inspector"
            title="Expand inspector"
            className="w-10 border-l border-console-border bg-console-surface hover:bg-console-surface-strong flex flex-col items-center justify-center gap-2 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <PanelLeftOpen size={15} className="text-console-text-muted" />
            <span className="text-[8px] font-bold text-console-text-subtle" style={{ writingMode: "vertical-rl" }}>
              Inspector
            </span>
          </button>
        )}
      </div>

      {/* ══ MODALS ═══════════════════════════════════════════════════════════ */}
      <SlideEditorModals
        pres={pres}
        slide={slide}
        media={media}
        mediaImages={mediaImages}
        appDataDir={appDataDir}
        templates={templates}
        showTemplateGallery={showTemplateGallery}
        setShowTemplateGallery={setShowTemplateGallery}
        showUnsavedConfirm={showUnsavedConfirm}
        setShowUnsavedConfirm={setShowUnsavedConfirm}
        saving={saveState === "saving"}
        showBgPicker={showBgPicker}
        setShowBgPicker={setShowBgPicker}
        showBgVideoPicker={showBgVideoPicker}
        setShowBgVideoPicker={setShowBgVideoPicker}
        showImgPicker={showImgPicker}
        setShowImgPicker={setShowImgPicker}
        showVideoPicker={showVideoPicker}
        setShowVideoPicker={setShowVideoPicker}
        showBiblePicker={showBiblePicker}
        setShowBiblePicker={setShowBiblePicker}
        onInsertTemplate={handleInsertTemplate}
        onDeleteTemplate={handleDeleteTemplate}
        onDiscardChanges={handleDiscardChanges}
        onSaveAndClose={handleSaveAndClose}
        onBgImageSelect={handleBgImageSelect}
        onBgVideoSelect={handleBgVideoSelect}
        onImageSelect={handleImageSelect}
        onVideoSelect={handleVideoSelect}
        onAddVerse={handleAddVerse}
      />

      {/* ══ LIVE PREVIEW PIP (P4.7) ═══════════════════════════════════════ */}
      {previewOpen && (
        <LivePreviewPip
          slide={pres.slides[activeSlideIdx]}
          slideIndex={activeSlideIdx}
          slideCount={pres.slides.length}
          appDataDir={appDataDir}
          theme={pres.theme}
          onClose={() => setPreviewOpen(false)}
          onNavigate={delta => setActiveSlideIdx(i => Math.max(0, Math.min(pres.slides.length - 1, i + delta)))}
        />
      )}
    </div>
  );
}

/**
 * LivePreviewPip — the in-editor "live preview" box (P4.7). Renders the
 * active slide with its entrance animations. The renderer authors font
 * sizes against a 1080p reference, so the scale is the box's *measured*
 * height ratio — measuring the slot (ResizeObserver) instead of assuming
 * a fixed width keeps text proportions identical to the main canvas and
 * lets the box shrink on small windows without overflowing.
 */
function LivePreviewPip({
  slide,
  slideIndex,
  slideCount,
  appDataDir,
  theme,
  onClose,
  onNavigate,
}: {
  slide?: CustomSlide;
  slideIndex: number;
  slideCount: number;
  appDataDir: string | null;
  theme?: SlideTheme;
  onClose: () => void;
  onNavigate: (delta: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const referenceHeight = useReferenceHeight();
  const [pipScale, setPipScale] = useState(0.2);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setPipScale(el.clientHeight / referenceHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [referenceHeight]);

  return (
    <div
      ref={boxRef}
      className="absolute bottom-4 right-4 w-[min(560px,40vw)] aspect-video rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-console-border-strong z-[80]"
      title="Live preview (Space) — not broadcast"
    >
      {slide ? (
        <CustomSlideRenderer
          slide={slide}
          scale={pipScale}
          appDataDir={appDataDir}
          theme={theme}
          entranceEnabled
        />
      ) : null}
      {/* P6: status label — text + icon + color, never color alone. */}
      <span className="absolute top-1.5 left-1.5 flex items-center gap-1 px-2 py-1 bg-black/70 text-[9px] font-bold rounded">
        <span className="w-1.5 h-1.5 rounded-full bg-state-success" />
        Preview — not broadcast
      </span>
      {/* P6: preview controls — prev/next/close. */}
      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 rounded-full px-1.5 py-1">
        <button disabled={slideIndex <= 0} onClick={() => onNavigate(-1)} aria-label="Preview previous slide" title="Previous slide" className="w-7 h-7 flex items-center justify-center rounded-full text-console-text hover:text-console-canvas disabled:opacity-30 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"><ChevronLeft size={14} /></button>
        <span className="text-[10px] font-bold text-console-text tabular-nums min-w-[40px] text-center">{slideIndex + 1} / {slideCount}</span>
        <button disabled={slideIndex >= slideCount - 1} onClick={() => onNavigate(1)} aria-label="Preview next slide" title="Next slide" className="w-7 h-7 flex items-center justify-center rounded-full text-console-text hover:text-console-canvas disabled:opacity-30 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"><ChevronRight size={14} /></button>
      </div>
      <button
        onClick={onClose}
        className="absolute top-1.5 right-1.5 p-1.5 bg-black/60 hover:bg-black/80 text-console-text rounded-full transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        title="Close preview (Esc)"
        aria-label="Close preview"
      >
        <X size={12} />
      </button>
    </div>
  );
}