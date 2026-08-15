import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import { useI18n, useT, type Locale } from "../i18n";
import { SearchField, SaveStatus, type SaveStatusState } from "./ui";
import type { PresentationSettings } from "../types";
import type { SettingsCategory } from "./settings/shared";
import { BibleAssetsSection } from "./settings/BibleAssetsSection";
import { OutputSection } from "./settings/sections/OutputSection";
import { ScriptureSection } from "./settings/sections/ScriptureSection";
import { ThemeSection } from "./settings/sections/ThemeSection";
import { BrandingSection } from "./settings/sections/BrandingSection";
import { BackgroundsSection } from "./settings/sections/BackgroundsSection";
import { BibleVersionsSection } from "./settings/sections/BibleVersionsSection";
import { MonitorsSection } from "./settings/sections/MonitorsSection";
import { StageSection } from "./settings/sections/StageSection";
import { OperatorSection } from "./settings/sections/OperatorSection";

const CATEGORIES: SettingsCategory[] = [
  { id: "output", labelKey: "settings.category.output", keywords: ["font", "size", "transition", "blank", "fade", "slide", "verse font", "timing", "song label", "section label", "verse 1", "chorus"] },
  { id: "scripture", labelKey: "settings.category.scripture", keywords: ["reference", "position", "chapter", "verse", "split", "divine", "highlight", "auto split"] },
  { id: "theme", labelKey: "settings.category.theme", keywords: ["color", "dark", "light", "navy", "maroon", "forest", "overrides", "background color"] },
  { id: "branding", labelKey: "settings.category.branding", keywords: ["logo", "splash", "corner", "watermark", "background logo", "brand"] },
  { id: "backgrounds", labelKey: "settings.category.backgrounds", keywords: ["background", "image", "video", "camera", "bible background", "media background", "preview"] },
  { id: "versions", labelKey: "settings.category.versions", keywords: ["version", "kjv", "niv", "translation", "enable", "disable", "tag"] },
  { id: "monitors", labelKey: "settings.category.monitors", keywords: ["monitor", "screen", "display", "output monitor", "test", "projector"] },
  { id: "stage", labelKey: "settings.category.stage", keywords: ["stage", "second monitor", "performer", "confidence", "themed"] },
  { id: "operator", labelKey: "settings.category.operator", keywords: ["behaviour", "behavior", "auto hide", "logo clear", "locale", "language", "i18n"] },
];

const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
];

interface SettingsTabProps {
  onUpdateSettings: (s: PresentationSettings) => Promise<void>;
  onUploadMedia: () => Promise<void>;
}

export function SettingsTab({ onUpdateSettings, onUploadMedia }: SettingsTabProps) {
  const { locale, setLocale } = useI18n();
  const t = useT();
  const [category, setCategory] = useState<string>("output");
  const [query, setQuery] = useState("");

  const [saveState, setSaveState] = useState<SaveStatusState>("idle");
  const saveTimerRef = useRef<number | null>(null);
  const latestRef = useRef<PresentationSettings | null>(null);

  // Debounced persistence: coerce rapid slider/category changes into a single
  // backend save and surface Saving → Saved → Save failed states.
  const updateSettings = useCallback((next: PresentationSettings) => {
    latestRef.current = next;
    setSaveState("unsaved");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await onUpdateSettings(latestRef.current!);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1500);
      } catch {
        setSaveState("failed");
      }
    }, 350);
  }, [onUpdateSettings]);

  useEffect(() => () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); }, []);

  const matches = useMemo(() => {
    if (!query.trim()) return CATEGORIES.map((c) => c.id);
    const q = query.trim().toLowerCase();
    return CATEGORIES
      .filter((c) => c.labelKey.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q)))
      .map((c) => c.id);
  }, [query]);

  // Auto-jump to the first matching category while searching.
  useEffect(() => {
    if (query.trim() && matches.length > 0 && !matches.includes(category)) {
      setCategory(matches[0]);
    }
  }, [query, matches, category]);

  const renderSection = () => {
    if (category === "output") return <OutputSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "scripture") return <ScriptureSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "theme") return <ThemeSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "branding") return <BrandingSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "backgrounds") return <BackgroundsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "versions") return <BibleVersionsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "monitors") return <MonitorsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "stage") return <StageSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "operator") return <OperatorSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    return null;
  };

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Category navigation */}
      <aside className="w-48 shrink-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <Save size={12} className="text-console-text-subtle" />
          <span className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Settings</span>
        </div>
        <SearchField value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.search")} />
        <nav className="flex flex-col gap-0.5 mt-1" aria-label="Settings categories">
          {CATEGORIES.map((c) => {
            const disabled = !matches.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => { setCategory(c.id); setQuery(""); }}
                disabled={disabled}
                aria-current={category === c.id ? "page" : undefined}
                className={`text-left px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  category === c.id
                    ? "bg-action-primary/15 text-action-primary border border-action-primary/30"
                    : disabled
                      ? "text-console-text-subtle/40 line-through cursor-not-allowed"
                      : "text-console-text-subtle hover:text-console-text hover:bg-console-surface-raised border border-transparent"
                }`}
              >
                {t(c.labelKey)}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto px-1 pt-2 border-t border-console-border">
          <label className="block text-[9px] font-black uppercase tracking-widest text-console-text-muted mb-1">{t("settings.language")}</label>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="w-full bg-console-surface-raised text-console-text text-[11px] rounded-md px-2 py-1.5 border border-console-border focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>
      </aside>

      {/* Active category content */}
      <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar pr-1">
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-console-border mb-3 sticky top-0 bg-slate-950/95 backdrop-blur z-10">
          <h2 className="op-control-label text-console-text uppercase tracking-widest">
            {t(CATEGORIES.find((c) => c.id === category)?.labelKey ?? "")}
          </h2>
          <SaveStatus state={saveState} />
        </div>
        {renderSection()}
      </div>
    </div>
  );
}
