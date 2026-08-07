import React from "react";
import { X } from "lucide-react";
import { useSlideEditor } from "./slide/useSlideEditor";
import { CustomSlideRenderer } from "../shared/Renderers";
import { AppHeader } from "./slide/AppHeader";
import { SlideListPanel } from "./slide/SlideListPanel";
import { EditorToolbar } from "./slide/EditorToolbar";
import { SlideCanvas } from "./slide/SlideCanvas";
import { PropertiesPanel } from "./slide/PropertiesPanel";
import { SlideEditorModals } from "./slide/SlideEditorModals";
import type { CustomPresentation, MediaItem } from "../../types";

// ─── Main SlideEditor ────────────────────────────────────────────────────────
// P1.4: this component is presentational. All state + mutation handlers live
// in the `useSlideEditor` controller hook; this file only owns the markup and
// wires the returned callbacks into the split sub-components.
interface SlideEditorProps {
  initialPres: CustomPresentation;
  mediaImages: MediaItem[];
  media: MediaItem[];
  onClose: (saved: boolean) => void;
}

export function SlideEditor({ initialPres, media, mediaImages, onClose }: SlideEditorProps) {
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
    canvasRef, canvasScale, isDirtyRef,
    slideDragDrop, handleSlidePointerDown, handleSlidePointerUp, handleSlideClick,
    handleDrag, handleResize, handleRotate,
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
    setSlideBackground,
    updateTheme,
    editingMasterId, enterMasterEdit, exitMasterEdit,
    handleCreateMaster, handleApplyMasterToSlide, handleDeleteMaster,
    previewOpen, setPreviewOpen,
    // global / store data
    appDataDir, templates, stagedItem,
  } = useSlideEditor({ initialPres, onClose });

  return (
    <div className="fixed inset-0 z-[60] bg-[#0e0e1c] flex flex-col font-sans">

      {/* ══ TOP BAR ══════════════════════════════════════════════════════════ */}
      <AppHeader
        name={pres.name}
        onNameChange={v => setPres({ ...pres, name: v })}
        isDirty={isDirtyRef.current}
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
          appDataDir={appDataDir}
          theme={pres.theme}
        />

        {/* ══ CENTER: TOOLBAR + CANVAS ═════════════════════════════════════════ */}
        <div className="flex-1 flex flex-col overflow-hidden">
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
            previewOpen={previewOpen}
            onTogglePreview={() => setPreviewOpen(p => !p)}
          />

          <SlideCanvas
            slide={slide}
            canvasRef={canvasRef}
            canvasScale={canvasScale}
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
        </div>

        {/* ══ RIGHT: PROPERTIES + NOTES PANEL ════════════════════════════════════ */}
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
          onUpdateElement={updateElement}
          onOpenBgPicker={() => setShowBgPicker(true)}
          onOpenBgVideoPicker={() => setShowBgVideoPicker(true)}
          onSetBackground={setSlideBackground}
          onSaveAsTemplate={handleSaveAsTemplate}
          onAlign={alignElement}
          onZOrder={updateZOrder}
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
      {previewOpen && (() => {
        // The renderer authors font sizes against a 1080p reference; the
        // 16:9 box is ~236px tall at 420px wide, so the scale must match
        // (height/1080) or text renders 2× too large and overflows.
        const pipScale = (420 * 9 / 16) / 1080;
        return (
          <div
            className="absolute bottom-4 right-4 w-[420px] aspect-video rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-white/20 z-[80]"
            title="Live preview (Space) — not broadcast"
          >
            {pres.slides[activeSlideIdx] ? (
              <CustomSlideRenderer
                slide={pres.slides[activeSlideIdx]}
                scale={pipScale}
                appDataDir={appDataDir}
                theme={pres.theme}
                entranceEnabled
              />
            ) : null}
            <button
              onClick={() => setPreviewOpen(false)}
              className="absolute top-1.5 right-1.5 p-1 bg-black/60 hover:bg-black/80 text-white rounded-full"
              title="Close preview (Esc)"
            >
              <X size={12} />
            </button>
            <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/60 text-[8px] text-emerald-300 rounded">
              ● Preview — not broadcast
            </span>
          </div>
        );
      })()}
    </div>
  );
}