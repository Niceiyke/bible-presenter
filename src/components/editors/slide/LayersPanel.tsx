/**
 * LayersPanel — the inspector's layer list
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5.6 / Phase 4). Lists every element on
 * the active slide sorted top-most first, with lock / hide / rename and
 * z-order controls. Selection is the single authoritative
 * `activeElementIds` owned by the controller (§5.6 / Phase 4 constraint):
 * clicking a row reuses the same callback as the canvas, so canvas and
 * layers can never disagree.
 */

import React, { useState } from "react";
import {
  Type as TypeIcon, Image as ImageIcon, Video, Square,
  Lock, Unlock, Eye, EyeOff, ChevronUp, ChevronDown, Pencil, Check, X,
} from "lucide-react";
import type { SlideElement } from "../../../types";
import type { ZDirection } from "./helpers";

export interface LayersPanelProps {
  elements: SlideElement[];
  activeElementIds: string[];
  onSelectElement: (id: string, additive: boolean) => void;
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onRenameElement: (id: string, name: string) => void;
  onZOrderElement: (id: string, dir: ZDirection) => void;
}

const KIND_ICON = {
  text: TypeIcon,
  image: ImageIcon,
  video: Video,
  shape: Square,
} as const;

/** "Text 1" / "Image 2" — the 1-based index of `el` among siblings of the
 *  same kind on the slide. Falls back to the kind title-cased when none. */
export function generatedLayerName(el: SlideElement, elements: SlideElement[]): string {
  if (el.name) return el.name;
  const kindIndex = elements.filter(e => e.kind === el.kind).indexOf(el);
  const cap = el.kind.charAt(0).toUpperCase() + el.kind.slice(1);
  return kindIndex >= 0 ? `${cap} ${kindIndex + 1}` : cap;
}

export function LayersPanel({
  elements,
  activeElementIds,
  onSelectElement,
  onToggleLock,
  onToggleHide,
  onRenameElement,
  onZOrderElement,
}: LayersPanelProps) {
  // Top-most (highest z) first — the way a layer list reads.
  const ordered = [...elements].sort((a, b) => b.z_index - a.z_index);
  const activeSet = new Set(activeElementIds);

  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto custom-scrollbar -mx-1 px-1">
      {ordered.length === 0 && (
        <p className="text-[10px] text-console-text-subtle text-center py-3">No elements on this slide.</p>
      )}
      {ordered.map((el, i) => (
        <LayerRow
          key={el.id}
          el={el}
          name={generatedLayerName(el, elements)}
          isActive={activeSet.has(el.id)}
          canMoveUp={i > 0}
          canMoveDown={i < ordered.length - 1}
          onSelectElement={onSelectElement}
          onToggleLock={onToggleLock}
          onToggleHide={onToggleHide}
          onRenameElement={onRenameElement}
          onZOrderElement={onZOrderElement}
        />
      ))}
    </div>
  );
}

function LayerRow({
  el,
  name,
  isActive,
  canMoveUp,
  canMoveDown,
  onSelectElement,
  onToggleLock,
  onToggleHide,
  onRenameElement,
  onZOrderElement,
}: {
  el: SlideElement;
  name: string;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelectElement: (id: string, additive: boolean) => void;
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onRenameElement: (id: string, name: string) => void;
  onZOrderElement: (id: string, dir: ZDirection) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const Icon = KIND_ICON[el.kind];

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-console-surface-strong border border-tool-design/50">
        <Icon size={13} className="text-console-text-subtle shrink-0" />
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") { onRenameElement(el.id, draft.trim()); setEditing(false); }
            else if (e.key === "Escape") { setEditing(false); setDraft(name); }
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent text-[11px] text-console-text outline-none"
          aria-label={`Rename ${name}`}
        />
        <button onClick={() => { onRenameElement(el.id, draft.trim()); setEditing(false); }} aria-label={`Confirm rename ${name}`} className="p-1 text-state-success hover:text-state-success rounded"><Check size={12} /></button>
        <button onClick={() => { setEditing(false); setDraft(name); }} aria-label={`Cancel rename ${name}`} className="p-1 text-console-text-muted hover:text-console-text rounded"><X size={12} /></button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      aria-label={`Layer ${name}${el.locked ? ", locked" : ""}${el.hidden ? ", hidden" : ""}`}
      onClick={e => onSelectElement(el.id, e.ctrlKey || e.metaKey)}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectElement(el.id, e.ctrlKey || e.metaKey); } }}
      className={`group flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg border cursor-pointer transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        isActive
          ? "bg-tool-design/15 border-tool-design/50"
          : "bg-console-surface-raised/60 border-transparent hover:bg-console-surface-strong"
      } ${el.hidden ? "opacity-50" : ""}`}
    >
      <Icon size={13} className={`shrink-0 ${isActive ? "text-tool-design" : "text-console-text-subtle"}`} />
      <span className="flex-1 min-w-0 text-[11px] font-semibold text-console-text truncate" onDoubleClick={e => { e.stopPropagation(); setDraft(name); setEditing(true); }} title={name}>
        {name}
      </span>
      <button onClick={e => { e.stopPropagation(); onZOrderElement(el.id, "forward"); }} disabled={!canMoveUp} aria-label={`Move ${name} up`} title="Bring forward" className="p-1 text-console-text-muted hover:text-console-text rounded disabled:opacity-20 transition-all"><ChevronUp size={12} /></button>
      <button onClick={e => { e.stopPropagation(); onZOrderElement(el.id, "backward"); }} disabled={!canMoveDown} aria-label={`Move ${name} down`} title="Send backward" className="p-1 text-console-text-muted hover:text-console-text rounded disabled:opacity-20 transition-all"><ChevronDown size={12} /></button>
      <button
        onClick={e => { e.stopPropagation(); onToggleHide(el.id); }}
        aria-label={el.hidden ? `Show ${name}` : `Hide ${name}`}
        title={el.hidden ? "Show" : "Hide"}
        aria-pressed={!!el.hidden}
        className={`p-1 rounded transition-all ${el.hidden ? "text-state-warning" : "text-console-text-muted hover:text-console-text"}`}
      >
        {el.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <button
        onClick={e => { e.stopPropagation(); onToggleLock(el.id); }}
        aria-label={el.locked ? `Unlock ${name}` : `Lock ${name}`}
        title={el.locked ? "Unlock" : "Lock"}
        aria-pressed={!!el.locked}
        className={`p-1 rounded transition-all ${el.locked ? "text-state-warning" : "text-console-text-muted hover:text-console-text"}`}
      >
        {el.locked ? <Lock size={12} /> : <Unlock size={12} />}
      </button>
      <button onClick={e => { e.stopPropagation(); setDraft(name); setEditing(true); }} aria-label={`Rename ${name}`} title="Rename" className="p-1 text-console-text-muted hover:text-console-text rounded opacity-0 group-hover:opacity-100 transition-all"><Pencil size={12} /></button>
    </div>
  );
}