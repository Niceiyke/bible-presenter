import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import { useI18n, useT, type Locale } from "../i18n";
import { SearchField, SaveStatus, type SaveStatusState } from "./ui";
import type { PresentationSettings } from "../types";
import type { SettingsCategory } from "./settings/shared";
import { BibleAssetsSection } from "./settings/BibleAssetsSection";
import { OutputSection } from "./settings/sections/OutputSection";
import { ScriptureSection } from "./settings/sections/ScriptureSection";
import { AiScriptureSection } from "./settings/sections/AiScriptureSection";
import { AiCreationSection } from "./settings/sections/AiCreationSection";
import { ThemeSection } from "./settings/sections/ThemeSection";
import { BrandingSection } from "./settings/sections/BrandingSection";
import { BackgroundsSection } from "./settings/sections/BackgroundsSection";
import { BibleVersionsSection } from "./settings/sections/BibleVersionsSection";
import { MonitorsSection } from "./settings/sections/MonitorsSection";
import { OverflowSection } from "./settings/sections/OverflowSection";
import { StageSection } from "./settings/sections/StageSection";
import { LicenseSection } from "./settings/sections/LicenseSection";
import { DataManagementSection } from "./settings/sections/DataManagementSection";

interface SettingsGroup {
  id: string;
  labelKey: string;
  categories: SettingsCategory[];
}

const CATEGORY_GROUPS: SettingsGroup[] = [
  {
    id: "presentation",
    labelKey: "settings.group.presentation",
    categories: [
      { id: "output", labelKey: "settings.category.output", keywords: ["font", "size", "transition", "blank", "fade", "slide", "verse font", "timing", "song label", "section label", "verse 1", "chorus"] },
      { id: "scripture", labelKey: "settings.category.scripture", keywords: ["reference", "position", "chapter", "verse", "split", "divine", "highlight", "auto split"] },
      { id: "theme", labelKey: "settings.category.theme", keywords: ["color", "dark", "light", "navy", "maroon", "forest", "overrides", "background color"] },
      { id: "backgrounds", labelKey: "settings.category.backgrounds", keywords: ["background", "image", "video", "camera", "bible background", "media background", "preview"] },
      { id: "branding", labelKey: "settings.category.branding", keywords: ["logo", "splash", "corner", "watermark", "background logo", "brand"] },
    ],
  },
  {
    id: "displays",
    labelKey: "settings.group.displays",
    categories: [
      { id: "monitors", labelKey: "settings.category.monitors", keywords: ["primary", "monitor", "screen", "display", "output monitor", "test", "projector"] },
      { id: "overflow", labelKey: "settings.category.overflow", keywords: ["overflow", "secondary", "second output", "aux", "monitor", "display"] },
      { id: "stage", labelKey: "settings.category.stage", keywords: ["stage", "second monitor", "performer", "confidence", "themed"] },
    ],
  },
  {
    id: "bible",
    labelKey: "settings.group.bible",
    categories: [
      { id: "versions", labelKey: "settings.category.versions", keywords: ["version", "kjv", "niv", "translation", "enable", "disable", "tag"] },
      { id: "assets", labelKey: "settings.category.assets", keywords: ["asset", "bible", "database", "download", "install", "core", "scriptures", "required"] },
    ],
  },
  {
    id: "ai",
    labelKey: "settings.group.ai",
    categories: [
      { id: "ai-scripture", labelKey: "settings.category.aiScripture", keywords: ["ai", "transcription", "deepgram", "assemblyai", "api key", "paraphrase", "embedding", "model", "speech", "auto live", "automatic live", "reference", "quote", "voice command"] },
      { id: "ai-creation", labelKey: "settings.category.aiCreation", keywords: ["ai", "presentation", "openai", "generate", "outline", "slides", "api key", "model"] },
    ],
  },
  {
    id: "system",
    labelKey: "settings.group.system",
    categories: [
      { id: "data", labelKey: "settings.category.data", keywords: ["backup", "restore", "data", "archive", "transfer", "recovery"] },
      { id: "license", labelKey: "settings.category.license", keywords: ["license", "key", "activate", "beta", "expiry", "expires", "church", "device", "deactivate"] },
    ],
  },
];

const CATEGORIES: SettingsCategory[] = CATEGORY_GROUPS.flatMap((group) => group.categories);

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
      .filter((c) => t(c.labelKey).toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q)))
      .map((c) => c.id);
  }, [query, t]);

  const visibleGroups = useMemo(() => {
    const allowed = new Set(matches);
    return CATEGORY_GROUPS
      .map((group) => ({ ...group, categories: group.categories.filter((category) => allowed.has(category.id)) }))
      .filter((group) => group.categories.length > 0);
  }, [matches]);

  // Auto-jump to the first matching category while searching.
  useEffect(() => {
    if (query.trim() && matches.length > 0 && !matches.includes(category)) {
      setCategory(matches[0]);
    }
  }, [query, matches, category]);

  const renderSection = () => {
    if (category === "assets") return <BibleAssetsSection />;
    if (category === "output") return <OutputSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "scripture") return <ScriptureSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "ai-scripture") return <AiScriptureSection onUpdateSettings={updateSettings} />;
    if (category === "ai-creation") return <AiCreationSection />;
    if (category === "theme") return <ThemeSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "branding") return <BrandingSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "backgrounds") return <BackgroundsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "versions") return <BibleVersionsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "monitors") return <MonitorsSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "overflow") return <OverflowSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "stage") return <StageSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    if (category === "data") return <DataManagementSection />;
    if (category === "license") return <LicenseSection onUpdateSettings={updateSettings} onUploadMedia={onUploadMedia} />;
    return null;
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside className="flex w-52 shrink-0 flex-col gap-1.5">
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <Save size={12} className="text-console-text-subtle" />
          <span className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Settings</span>
        </div>
        <SearchField value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.search")} />
        <nav className="mt-1 flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5 custom-scrollbar" aria-label="Settings categories">
          {visibleGroups.map((group) => (
            <div key={group.id}>
              <p className="px-2 pb-1 text-[8px] font-black uppercase tracking-[0.16em] text-console-text-subtle/70">{t(group.labelKey)}</p>
              <div className="flex flex-col gap-0.5">
                {group.categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setCategory(c.id); setQuery(""); }}
                    aria-current={category === c.id ? "page" : undefined}
                    className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                      category === c.id
                        ? "border-action-primary/30 bg-action-primary/15 text-action-primary"
                        : "border-transparent text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text"
                    }`}
                  >
                    {t(c.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="px-2 py-3 text-[10px] leading-relaxed text-console-text-subtle">No matching settings.</p>
          )}
        </nav>

        <div className="mt-auto border-t border-console-border px-1 pt-2">
          <label className="mb-1 block text-[9px] font-black uppercase tracking-widest text-console-text-muted">{t("settings.language")}</label>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="w-full rounded-md border border-console-border bg-console-surface-raised px-2 py-1.5 text-[11px] text-console-text focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
        <div className="sticky top-0 z-10 mb-3 flex items-center justify-between border-b border-console-border bg-slate-950/95 px-2 py-1.5 backdrop-blur">
          <h2 className="op-control-label uppercase tracking-widest text-console-text">
            {t(CATEGORIES.find((c) => c.id === category)?.labelKey ?? "")}
          </h2>
          <SaveStatus state={saveState} />
        </div>
        {renderSection()}
      </div>
    </div>
  );
}
