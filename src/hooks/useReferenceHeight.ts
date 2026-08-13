/**
 * `useReferenceHeight`
 *
 * Single source of truth for the design-reference height every rich
 * renderer (slides, songs) scales against. Reads the operator's
 * `reference_output_height` setting (default 1080p) so all surfaces —
 * output window, editor canvas, thumbnails, cockpit previews, PiP, and
 * stage window — agree by construction instead of each hardcoding 1080.
 */
import { useAppStore } from "../store";

export function useReferenceHeight(): number {
  const reference_output_height = useAppStore((s) => s.settings.reference_output_height);
  return reference_output_height ?? 1080;
}