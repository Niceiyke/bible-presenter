/**
 * ThemePicker — a small set of presentation theme presets
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5 / Phase 5). Each preset is a
 * `Partial<SlideTheme>` applied via the controller's `onApplyTheme`, which
 * merges with the existing theme. Presets only set theme-level fields, so
 * elements whose `font_family|font_size|color === "inherit"` (or undefined)
 * pick up the new values at render time while explicit per-element overrides
 * are left untouched (the renderer resolves `"inherit"` against the theme).
 */

import React from "react";
import { Check } from "lucide-react";
import type { SlideTheme } from "../../../types";

export interface ThemePreset {
  id: string;
  name: string;
  textColor: string;
  accentColor: string;
  defaultFontFamily: string;
  defaultFontSize: number;
  background: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "midnight", name: "Midnight", textColor: "#f4f7fa", accentColor: "#f4b740", defaultFontFamily: "Arial", defaultFontSize: 32, background: "#0b0f14" },
  { id: "ivory", name: "Ivory", textColor: "#1a1a2e", accentColor: "#b45309", defaultFontFamily: "Georgia", defaultFontSize: 32, background: "#faf6ee" },
  { id: "royal", name: "Royal", textColor: "#ffffff", accentColor: "#a78bfa", defaultFontFamily: "Georgia", defaultFontSize: 34, background: "#1e1b4b" },
  { id: "forest", name: "Forest", textColor: "#f0fdf4", accentColor: "#67d4c0", defaultFontFamily: "Arial", defaultFontSize: 30, background: "#0f2419" },
  { id: "clay", name: "Clay", textColor: "#3b2a1e", accentColor: "#c2410c", defaultFontFamily: "Arial", defaultFontSize: 32, background: "#efe4d4" },
  { id: "ocean", name: "Ocean", textColor: "#e0f2fe", accentColor: "#38bdf8", defaultFontFamily: "Arial", defaultFontSize: 32, background: "#0c1f3d" },
];

export interface ThemePickerProps {
  theme?: SlideTheme;
  onApplyPreset: (preset: ThemePreset) => void;
  /** Swatch preview of the slide background currently active. */
  currentBackground?: string;
}

export function ThemePicker({ theme, onApplyPreset }: ThemePickerProps) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {THEME_PRESETS.map(p => {
        const isActive = (theme?.accentColor ?? "#f4b740") === p.accentColor && (theme?.textColor ?? "#f4f7fa") === p.textColor;
        return (
          <button
            key={p.id}
            onClick={() => onApplyPreset(p)}
            aria-pressed={isActive}
            aria-label={`Apply ${p.name} theme`}
            title={`Apply "${p.name}" theme`}
            className={`relative rounded-lg overflow-hidden border-2 transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
              isActive ? "border-tool-design" : "border-console-border hover:border-console-border-strong"
            }`}
          >
            <div className="h-8 flex flex-col justify-between p-1" style={{ background: p.background }}>
              <div className="h-1.5 w-4 rounded-sm" style={{ background: p.accentColor }} />
              <div className="h-1.5 w-7 rounded-sm" style={{ background: p.textColor, opacity: 0.85 }} />
            </div>
            <div className="flex items-center justify-between px-1.5 py-1 bg-console-surface-raised">
              <span className="text-[9px] font-bold text-console-text truncate">{p.name}</span>
              {isActive && <Check size={10} className="text-tool-design shrink-0" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}