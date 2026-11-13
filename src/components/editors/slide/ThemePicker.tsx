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
  { id: "midnight", name: "Midnight", textColor: "#f5f5f7", accentColor: "#f7b500", defaultFontFamily: "Inter", defaultFontSize: 32, background: "#0b1117" },
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
    <div className="grid grid-cols-2 gap-2">
      {THEME_PRESETS.map(p => {
        const isActive = (theme?.accentColor ?? "#f7b500") === p.accentColor && (theme?.textColor ?? "#f5f5f7") === p.textColor;
        return (
          <button
            key={p.id}
            onClick={() => onApplyPreset(p)}
            aria-pressed={isActive}
            aria-label={`Apply ${p.name} theme`}
            title={`Apply "${p.name}" theme`}
            className={`group relative rounded-xl overflow-hidden border-2 transition-all hover:-translate-y-px hover:shadow-lg hover:shadow-black/25 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
              isActive ? "border-tool-design ring-2 ring-tool-design/15" : "border-console-border hover:border-tool-design/45"
            }`}
          >
            <div className="relative h-14 overflow-hidden p-2" style={{ background: `linear-gradient(145deg, ${p.background} 58%, ${p.accentColor} 160%)` }}>
              <div className="absolute -right-4 -top-4 h-12 w-12 rounded-full border" style={{ borderColor: `${p.accentColor}55` }} />
              <div className="relative flex h-full items-end justify-between">
                <span className="text-xl font-black leading-none" style={{ color: p.textColor, fontFamily: p.defaultFontFamily }}>Aa</span>
                <span className="h-2.5 w-2.5 rounded-full shadow-lg" style={{ background: p.accentColor }} />
              </div>
            </div>
            <div className="flex items-center justify-between px-2 py-1.5 bg-console-surface-raised">
              <span className="text-[9px] font-black text-console-text truncate">{p.name}</span>
              {isActive && <Check size={10} className="text-tool-design shrink-0" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
