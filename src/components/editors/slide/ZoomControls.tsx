/**
 * ZoomControls — fit/zoom control for the slide canvas
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5.2 / Phase 3). The canvas always keeps
 * its 16:9 aspect ratio; `zoom` is a multiplier on the *fit* width (1 = fit
 * the available space). Zooming out shrinks the canvas, zooming in grows it
 * up to the container width.
 */

import React from "react";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";

export interface ZoomControlsProps {
  /** 1 = fit the available space. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 0.1;

export function ZoomControls({ zoom, onZoomChange }: ZoomControlsProps) {
  return (
    <div className="flex items-center gap-0.5 bg-console-surface/80 backdrop-blur border border-console-border rounded-full px-1.5 py-1">
      <button
        onClick={() => onZoomChange(Math.max(MIN_ZOOM, Math.round((zoom - ZOOM_STEP) * 100) / 100))}
        disabled={zoom <= MIN_ZOOM}
        aria-label="Zoom out"
        title="Zoom out"
        className="w-8 h-8 flex items-center justify-center rounded-full text-console-text-muted hover:text-console-text hover:bg-console-surface-strong disabled:opacity-20 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <ZoomOut size={15} />
      </button>
      <span className="text-[11px] font-bold text-console-text-muted tabular-nums w-12 text-center" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => onZoomChange(Math.min(MAX_ZOOM, Math.round((zoom + ZOOM_STEP) * 100) / 100))}
        disabled={zoom >= MAX_ZOOM}
        aria-label="Zoom in"
        title="Zoom in"
        className="w-8 h-8 flex items-center justify-center rounded-full text-console-text-muted hover:text-console-text hover:bg-console-surface-strong disabled:opacity-20 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <ZoomIn size={15} />
      </button>
      <div className="w-px h-5 bg-console-border mx-0.5" />
      <button
        onClick={() => onZoomChange(1)}
        disabled={zoom === 1}
        aria-label="Fit canvas"
        title="Fit canvas (100%)"
        className="w-8 h-8 flex items-center justify-center rounded-full text-console-text-muted hover:text-console-text hover:bg-console-surface-strong disabled:opacity-20 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <Maximize size={14} />
      </button>
    </div>
  );
}
