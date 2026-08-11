/**
 * AppHeader — the top status/command bar of the slide editor (P1.4).
 *
 * Phase 2: labeled, accessible command bar using semantic console tokens.
 * Phase 3 (SLIDE_EDITOR_MODERNIZATION_PLAN §5.2): Import/Export moved under
 * a secondary File menu, and Preview + Stage Current Slide surface here so
 * the operator can identify every primary action without tooltips.
 */

import React from "react";
import { Save, X, Undo2, Redo2, Upload, Download, Play, MonitorUp, ChevronDown, Loader2, Plus, Radio } from "lucide-react";
import { EditorSaveStatus } from "./EditorSaveStatus";
import { EditorMenu } from "./components";
import { useT } from "../../../i18n";
import type { EditorSaveState } from "./useAutoSave";

export interface AppHeaderProps {
  name: string;
  onNameChange: (value: string) => void;
  saveState: EditorSaveState;
  onRetrySave: () => void;
  slideIndex: number;
  slideCount: number;
  onClose: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onImport: () => void;
  onExport: () => void;
  onSaveAndClose: () => void;
  /** P3: in-editor live preview toggle (also Space). */
  previewOpen: boolean;
  onTogglePreview: () => void;
  /** P3: stage the active slide (no broadcast). */
  onStage: () => void;
  /** P6: add the active slide to the active service plan. */
  onAddToService?: () => void;
  /** P6: true while a stage request is in flight. */
  staging?: boolean;
  /** P6: whether the active slide is staged or live (textual status, never color alone). */
  slideStatus?: "live" | "staged" | "idle";
}

export function AppHeader({
  name,
  onNameChange,
  saveState,
  onRetrySave,
  slideIndex,
  slideCount,
  onClose,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onImport,
  onExport,
  onSaveAndClose,
  previewOpen,
  onTogglePreview,
  onStage,
  onAddToService,
  staging,
  slideStatus,
}: AppHeaderProps) {
  const t = useT();
  return (
    <header className="h-14 flex items-center gap-2 px-3 border-b border-console-border bg-console-surface shrink-0">
      <button
        onClick={onClose}
        className="w-10 h-10 hover:bg-console-surface-strong rounded-lg text-console-text-muted hover:text-console-text transition-all border border-transparent focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        title={t("editor.close")}
        aria-label={t("editor.close")}
      >
        <X size={18} />
      </button>
      <div className="h-6 w-px bg-console-border" />
      <EditorSaveStatus state={saveState} onRetry={onRetrySave} />
      <input
        value={name}
        onChange={e => onNameChange(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        className="bg-transparent text-sm font-semibold text-console-text focus:outline-none min-w-0 flex-1"
        placeholder="Untitled Presentation"
        aria-label={t("editor.presentationName")}
      />
      <span className="text-[11px] font-bold text-console-text-subtle tabular-nums whitespace-nowrap bg-console-surface-raised border border-console-border px-2 py-1 rounded">
        {slideIndex + 1} / {slideCount}
      </span>

      <div className="flex bg-console-surface-raised border border-console-border rounded-lg p-0.5 gap-0.5">
        <button onClick={onUndo} disabled={!canUndo} className="w-9 h-9 text-console-text-muted hover:text-console-text hover:bg-console-surface-strong rounded disabled:opacity-20 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title={`Undo (Ctrl+Z)`} aria-label={t("editor.undo")}>
          <Undo2 size={16} />
        </button>
        <button onClick={onRedo} disabled={!canRedo} className="w-9 h-9 text-console-text-muted hover:text-console-text hover:bg-console-surface-strong rounded disabled:opacity-20 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]" title={`Redo (Ctrl+Y)`} aria-label={t("editor.redo")}>
          <Redo2 size={16} />
        </button>
      </div>

      {/* P3: Import / Export under a secondary File menu. */}
      <EditorMenu
        label={t("editor.file")}
        trigger={<><Upload size={14} /> {t("editor.file")} <ChevronDown size={12} /></>}
        items={[
          { value: "import", label: <span className="flex items-center gap-2"><Upload size={13} /> {t("editor.import")}</span> },
          { value: "export", label: <span className="flex items-center gap-2"><Download size={13} /> {t("editor.export")}</span> },
        ]}
        onSelect={v => (v === "import" ? onImport() : onExport())}
      />

      <div className="h-6 w-px bg-console-border" />

      <button
        onClick={onTogglePreview}
        aria-pressed={previewOpen}
        title="Live preview (Space) — plays entrance animation, nothing is broadcast"
        className={`flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
          previewOpen
            ? "bg-state-success/20 text-state-success border-state-success/50"
            : "bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text border-console-border"
        }`}
      >
        <Play size={14} />
        <span className="text-xs font-bold">{previewOpen ? t("editor.previewing") : t("editor.preview")}</span>
      </button>

      {/* P6: staged / on-air indicator — text + icon, never color alone. */}
      {slideStatus === "live" && (
        <span className="flex items-center gap-1 px-2 h-9 rounded-lg bg-state-live/15 border border-state-live/40 text-[11px] font-black uppercase tracking-wide text-state-live" title="This slide is LIVE on air">
          <Radio size={13} /> {t("editor.onAir")}
        </span>
      )}
      {slideStatus === "staged" && (
        <span className="flex items-center gap-1 px-2 h-9 rounded-lg bg-state-stage/15 border border-state-stage/40 text-[11px] font-black uppercase tracking-wide text-state-stage" title="This slide is staged (up next)">
          <MonitorUp size={13} /> {t("editor.staged")}
        </span>
      )}

      <button
        onClick={onStage}
        disabled={staging}
        title="Stage current slide — puts it in the output queue without broadcasting"
        className="flex items-center gap-1.5 min-h-[40px] px-3 bg-state-stage/15 hover:bg-state-stage/25 text-state-stage border border-state-stage/40 rounded-lg transition-all font-bold text-xs focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
      >
        {staging ? <Loader2 size={14} className="animate-spin" /> : <MonitorUp size={14} />}
        {staging ? t("editor.staging") : t("editor.stageSlide")}
      </button>

      {onAddToService && (
        <button
          onClick={onAddToService}
          title="Add current slide to the active service plan"
          className="flex items-center gap-1.5 min-h-[40px] px-3 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text border border-console-border rounded-lg transition-all font-bold text-xs focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          <Plus size={14} />
          {t("editor.addToService")}
        </button>
      )}

      <button onClick={onSaveAndClose} className="flex items-center gap-1.5 min-h-[40px] px-4 bg-action-primary hover:bg-action-primary-hover text-black font-black uppercase text-[11px] rounded-lg transition-all shadow-lg shadow-action-primary/20 tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]">
        <Save size={14} /> {t("editor.saveClose")}
      </button>
    </header>
  );
}
