/**
 * `useCanvasScale`
 *
 * Returns the canvas's `clientHeight / REFERENCE_HEIGHT` so slide elements
 * (whose font sizes are authored against a 1080p reference) scale correctly
 * at any preview size — slide thumbnails, the editor canvas, and the
 * output window.
 *
 * Thin wrapper over the shared `useBoxScale` hook (which owns the
 * ResizeObserver + window-resize subscription); the canvas is just a box
 * whose measured height ratio is the slide renderer's scale.
 */

import type { RefObject } from "react";
import { useBoxScale } from "../../../hooks/useBoxScale";

const REFERENCE_HEIGHT = 1080;

export function useCanvasScale(canvasRef: RefObject<HTMLDivElement | null>): number {
  return useBoxScale(canvasRef, REFERENCE_HEIGHT);
}
