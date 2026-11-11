import React, { useEffect, useMemo, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpDown,
  FileText,
  FileUp,
  Grid2X2,
  LayoutTemplate,
  List,
  Loader2,
  Plus,
  Presentation,
  Search,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "../store";
import { Button, ConfirmModal } from "./ui";
import type { CustomPresentation, DisplayItem, PresentationSummary } from "../types";
import { AiPresentationModal } from "./presentations/AiPresentationModal";
import { PrayerDocxImportModal } from "./presentations/PrayerDocxImportModal";
import { PresentationDeckCard } from "./presentations/PresentationDeckCard";
import { PresentationDetailPanel } from "./presentations/PresentationDetailPanel";
import { compilePrayerGuide, type PrayerGuideImport } from "../imports/prayerGuide";
import { buildCustomSlideItem } from "../utils";
import {
  duplicatePresentation,
  filterAndSortPresentations,
  loadPresentationLibraryPreferences,
  savePresentationLibraryPreferences,
  type PresentationLibraryPreferences,
} from "../presentations/library";
import { tauriPresentationRepository } from "../presentations/repository";
import { cn } from "./ui/cn";

interface RenderedPptxImport {
  id: string;
  name: string;
  slide_paths: string[];
}

interface StudioTabProps {
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
  onAddToSchedule?: (item: DisplayItem) => void;
  onOpenEditor: (id: string) => void;
  onNewPresentation: () => void;
}

export function StudioTab({ onStage, onLive, onAddToSchedule, onOpenEditor, onNewPresentation }: StudioTabProps) {
  const {
    studioList,
    setStudioList,
    expandedStudioPresId,
    setExpandedStudioPresId,
    studioSlides,
    setStudioSlides,
    appDataDir,
    setToast,
    bibleVersion,
  } = useAppStore();

  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState<PresentationLibraryPreferences>(loadPresentationLibraryPreferences);
  const [loadedPresentations, setLoadedPresentations] = useState<Record<string, CustomPresentation>>({});
  const [loadingDeckId, setLoadingDeckId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletePres, setDeletePres] = useState<PresentationSummary | null>(null);
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [showAiCreation, setShowAiCreation] = useState(false);
  const [prayerImport, setPrayerImport] = useState<PrayerGuideImport | null>(null);

  useEffect(() => savePresentationLibraryPreferences(preferences), [preferences]);

  // Warm a small number of covers. The summary query stays lightweight while
  // the most relevant decks gain real thumbnails without loading an unbounded
  // library into memory.
  useEffect(() => {
    let cancelled = false;
    const ids = [...studioList]
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 8)
      .filter((summary) => !loadedPresentations[summary.id])
      .map((summary) => summary.id);
    if (ids.length === 0) return;
    Promise.allSettled(ids.map((id) => tauriPresentationRepository.load(id))).then((results) => {
      if (cancelled) return;
      const decks = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (decks.length === 0) return;
      setLoadedPresentations((current) => ({ ...current, ...Object.fromEntries(decks.map((deck) => [deck.id, deck])) }));
      setStudioSlides((current) => ({ ...current, ...Object.fromEntries(decks.map((deck) => [deck.id, deck.slides])) }));
    });
    return () => { cancelled = true; };
    // Loading results are deliberately excluded so this bounded warm-up runs
    // once per changed library, rather than recursively after each cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioList]);

  const filtered = useMemo(
    () => filterAndSortPresentations(studioList, query, preferences.sort, preferences.favorites),
    [studioList, query, preferences.sort, preferences.favorites],
  );
  const selectedSummary = studioList.find((presentation) => presentation.id === expandedStudioPresId) ?? null;
  const selectedPresentation = expandedStudioPresId ? loadedPresentations[expandedStudioPresId] : undefined;
  const selectedSlides = expandedStudioPresId
    ? selectedPresentation?.slides ?? studioSlides[expandedStudioPresId] ?? []
    : [];
  const totalSlides = studioList.reduce((sum, presentation) => sum + presentation.slide_count, 0);

  const refreshList = async () => {
    const list = await tauriPresentationRepository.list();
    setStudioList(list);
    await emit("studio-sync", list);
    return list;
  };

  const loadPresentation = async (id: string): Promise<CustomPresentation> => {
    const cached = loadedPresentations[id];
    if (cached) return cached;
    setLoadingDeckId(id);
    setLoadError(null);
    try {
      const deck = await tauriPresentationRepository.load(id);
      setLoadedPresentations((current) => ({ ...current, [id]: deck }));
      setStudioSlides((current) => ({ ...current, [id]: deck.slides }));
      return deck;
    } catch (error) {
      const message = `Could not load this presentation: ${error}`;
      setLoadError(message);
      throw error;
    } finally {
      setLoadingDeckId((current) => current === id ? null : current);
    }
  };

  const selectPresentation = (id: string) => {
    setExpandedStudioPresId(id);
    setLoadError(null);
    void loadPresentation(id).catch(() => undefined);
  };

  const importPowerPoint = async () => {
    setWorkingAction("pptx");
    try {
      const selected = await open({
        title: "Import PowerPoint as rendered slides",
        multiple: false,
        directory: false,
        filters: [{ name: "PowerPoint Presentation", extensions: ["pptx"] }],
      });
      if (typeof selected !== "string") return;
      setToast("Rendering PowerPoint slides…");
      const { invoke } = await import("@tauri-apps/api/core");
      const imported = await invoke<RenderedPptxImport>("import_pptx_rendered", { path: selected });
      const presentation: CustomPresentation = {
        id: imported.id,
        name: imported.name,
        version: 2,
        slides: imported.slide_paths.map((path, index) => ({
          id: `${imported.id}-slide-${index + 1}`,
          background: { type: "image", value: path, objectFit: "contain" },
          elements: [],
        })),
      };
      try {
        await tauriPresentationRepository.save(presentation);
      } catch (error) {
        await invoke("discard_pptx_import", { id: imported.id }).catch(() => undefined);
        throw error;
      }
      await refreshList();
      setLoadedPresentations((current) => ({ ...current, [presentation.id]: presentation }));
      setStudioSlides((current) => ({ ...current, [presentation.id]: presentation.slides }));
      setExpandedStudioPresId(presentation.id);
      setToast(`Imported ${presentation.slides.length} rendered PowerPoint slides`);
    } catch (error) {
      setToast(`PowerPoint import failed: ${error}`);
    } finally {
      setWorkingAction(null);
    }
  };

  const importPrayerDocx = async () => {
    setWorkingAction("prayer");
    try {
      const selected = await open({
        title: "Import daily prayer Word document",
        multiple: false,
        directory: false,
        filters: [{ name: "Word Document", extensions: ["docx"] }],
      });
      if (typeof selected !== "string") return;
      setToast("Reading prayer document and verifying Scripture…");
      const { invoke } = await import("@tauri-apps/api/core");
      const imported = await invoke<PrayerGuideImport>("import_prayer_docx", { path: selected, version: bibleVersion });
      setPrayerImport(imported);
      setToast(`Found ${imported.days.length} daily prayer sections`);
    } catch (error) {
      setToast(`Prayer DOCX import failed: ${error}`);
    } finally {
      setWorkingAction(null);
    }
  };

  const createAiPresentation = async (presentation: CustomPresentation) => {
    await tauriPresentationRepository.save(presentation);
    await refreshList();
    setLoadedPresentations((current) => ({ ...current, [presentation.id]: presentation }));
    setStudioSlides((current) => ({ ...current, [presentation.id]: presentation.slides }));
    setExpandedStudioPresId(presentation.id);
    setToast(`Created ${presentation.slides.length}-slide AI draft`);
    onOpenEditor(presentation.id);
  };

  const createPrayerDecks = async () => {
    if (!prayerImport) return;
    const presentations = compilePrayerGuide(prayerImport);
    try {
      await Promise.all(presentations.map((presentation) => tauriPresentationRepository.save(presentation)));
      await refreshList();
      setLoadedPresentations((current) => ({ ...current, ...Object.fromEntries(presentations.map((deck) => [deck.id, deck])) }));
      setStudioSlides((current) => ({ ...current, ...Object.fromEntries(presentations.map((deck) => [deck.id, deck.slides])) }));
      if (presentations[0]) setExpandedStudioPresId(presentations[0].id);
      setToast(`Created ${presentations.length} daily prayer decks`);
      setPrayerImport(null);
    } catch (error) {
      setToast(`Could not save prayer decks: ${error}`);
    }
  };

  const handleDelete = async (id: string) => {
    await tauriPresentationRepository.remove(id);
    const list = studioList.filter((presentation) => presentation.id !== id);
    setStudioList(list);
    await emit("studio-sync", list);
    setLoadedPresentations((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setStudioSlides((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (expandedStudioPresId === id) setExpandedStudioPresId(null);
    setPreferences((current) => ({ ...current, favorites: current.favorites.filter((favoriteId) => favoriteId !== id) }));
    setToast("Presentation deleted");
  };

  const handleDuplicate = async (id: string) => {
    setWorkingAction("duplicate");
    try {
      const source = await loadPresentation(id);
      const copy = duplicatePresentation(source);
      await tauriPresentationRepository.save(copy);
      await refreshList();
      setLoadedPresentations((current) => ({ ...current, [copy.id]: copy }));
      setStudioSlides((current) => ({ ...current, [copy.id]: copy.slides }));
      setExpandedStudioPresId(copy.id);
      setToast(`Created “${copy.name}”`);
    } catch (error) {
      setToast(`Could not duplicate presentation: ${error}`);
    } finally {
      setWorkingAction(null);
    }
  };

  const toggleFavorite = (id: string) => {
    setPreferences((current) => ({
      ...current,
      favorites: current.favorites.includes(id)
        ? current.favorites.filter((favoriteId) => favoriteId !== id)
        : [...current.favorites, id],
    }));
  };

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 pb-6">
      <section className="flex flex-wrap items-center gap-2 rounded-xl border border-console-border bg-console-surface/80 px-3 py-2.5 shadow-lg shadow-black/10">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tool-design/12 text-tool-design"><LayoutTemplate size={15} /></span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-black text-console-text">Presentation workspace</h1>
            <p className="text-[9px] font-medium text-console-text-subtle">{studioList.length} decks · {totalSlides} slides</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={onNewPresentation}><Plus size={13} /> New</Button>
          <Button variant="ghost" size="sm" onClick={() => setShowAiCreation(true)}><Sparkles size={13} className="text-tool-design" /> AI draft</Button>
          <button type="button" onClick={() => void importPrayerDocx()} disabled={workingAction !== null} className="flex h-8 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[9px] font-bold text-console-text-muted hover:text-console-text disabled:opacity-50" title="Import a prayer Word document">{workingAction === "prayer" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Prayer DOCX</button>
          <button type="button" onClick={() => void importPowerPoint()} disabled={workingAction !== null} className="flex h-8 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[9px] font-bold text-console-text-muted hover:text-console-text disabled:opacity-50" title="Import a PowerPoint presentation">{workingAction === "pptx" ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} PowerPoint</button>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2 rounded-xl border border-console-border bg-console-surface/70 p-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-console-text-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search presentations…"
            aria-label="Search presentations"
            className="h-10 w-full rounded-lg border border-console-border bg-console-canvas pl-9 pr-3 text-xs text-console-text outline-none transition-colors placeholder:text-console-text-subtle focus:border-tool-design/60"
          />
        </div>
        <label className="relative flex h-10 items-center gap-2 rounded-lg border border-console-border bg-console-canvas px-3 text-[10px] font-bold text-console-text-muted">
          <ArrowUpDown size={12} />
          <span className="sr-only">Sort presentations</span>
          <select
            value={preferences.sort}
            onChange={(event) => setPreferences((current) => ({ ...current, sort: event.target.value as PresentationLibraryPreferences["sort"] }))}
            className="appearance-none bg-transparent pr-3 text-[10px] font-bold text-console-text outline-none"
          >
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
            <option value="slides">Most slides</option>
          </select>
        </label>
        <div className="flex h-10 items-center rounded-lg border border-console-border bg-console-canvas p-1" aria-label="Presentation view">
          <ViewButton active={preferences.view === "grid"} label="Grid view" onClick={() => setPreferences((current) => ({ ...current, view: "grid" }))}><Grid2X2 size={13} /></ViewButton>
          <ViewButton active={preferences.view === "list"} label="List view" onClick={() => setPreferences((current) => ({ ...current, view: "list" }))}><List size={14} /></ViewButton>
        </div>
      </section>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          <div className="mb-2 flex items-end justify-between px-0.5">
            <div>
              <h2 className="text-[11px] font-black uppercase tracking-[0.16em] text-console-text-muted">Your presentations</h2>
              <p className="mt-1 text-[10px] text-console-text-subtle">{filtered.length} {filtered.length === 1 ? "deck" : "decks"}{query ? " matching your search" : ""}</p>
            </div>
          </div>

          {filtered.length > 0 ? (
            <div className={cn(
              preferences.view === "grid"
                ? "grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3"
                : "flex flex-col gap-2",
            )}>
              {filtered.map((summary) => {
                const loadedDeck = loadedPresentations[summary.id];
                const dragSlides = loadedDeck?.slides ?? studioSlides[summary.id];
                const dragItem = dragSlides && dragSlides.length > 0
                  ? buildCustomSlideItem(summary, dragSlides, 0, loadedDeck?.theme)
                  : undefined;
                return (
                  <PresentationDeckCard
                    key={summary.id}
                    summary={summary}
                    presentation={loadedDeck}
                    firstSlide={studioSlides[summary.id]?.[0]}
                    appDataDir={appDataDir}
                    selected={expandedStudioPresId === summary.id}
                    favorite={preferences.favorites.includes(summary.id)}
                    view={preferences.view}
                    dragItem={dragItem}
                    onSelect={() => selectPresentation(summary.id)}
                    onEdit={() => onOpenEditor(summary.id)}
                    onToggleFavorite={() => toggleFavorite(summary.id)}
                  />
                );
              })}
            </div>
          ) : (
            <LibraryEmptyState hasQuery={query.trim().length > 0} onCreate={onNewPresentation} />
          )}
        </section>

        <PresentationDetailPanel
          summary={selectedSummary}
          presentation={selectedPresentation}
          slides={selectedSlides}
          appDataDir={appDataDir}
          loading={!!selectedSummary && loadingDeckId === selectedSummary.id}
          error={loadError}
          onClose={() => setExpandedStudioPresId(null)}
          onEdit={() => selectedSummary && onOpenEditor(selectedSummary.id)}
          onDuplicate={() => selectedSummary && void handleDuplicate(selectedSummary.id)}
          onDelete={() => selectedSummary && setDeletePres(selectedSummary)}
          onStage={onStage}
          onLive={onLive}
          onAddToSchedule={onAddToSchedule}
        />
      </div>

      <ConfirmModal
        open={!!deletePres}
        title={`Delete “${deletePres?.name ?? ""}”?`}
        description="The presentation and all of its slides will be removed. This cannot be undone."
        confirmLabel="Delete presentation"
        confirmVariant="live"
        onConfirm={async () => { if (deletePres) await handleDelete(deletePres.id); }}
        onClose={() => setDeletePres(null)}
      />
      <AiPresentationModal
        open={showAiCreation}
        defaultBibleVersion={bibleVersion}
        onClose={() => setShowAiCreation(false)}
        onCreate={createAiPresentation}
      />
      <PrayerDocxImportModal imported={prayerImport} onClose={() => setPrayerImport(null)} onCreate={createPrayerDecks} />
    </div>
  );
}

function ViewButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn("flex h-8 w-8 items-center justify-center rounded-md transition-colors", active ? "bg-console-surface-strong text-console-text" : "text-console-text-subtle hover:text-console-text")}
    >
      {children}
    </button>
  );
}

function LibraryEmptyState({ hasQuery, onCreate }: { hasQuery: boolean; onCreate: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-console-border bg-console-surface/30 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-console-surface-raised text-console-text-subtle">
        {hasQuery ? <Search size={20} /> : <Presentation size={20} />}
      </div>
      <p className="mt-4 text-sm font-bold text-console-text">{hasQuery ? "No matching presentations" : "Build your first presentation"}</p>
      <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-console-text-subtle">
        {hasQuery ? "Try a different title or clear the search to see your full library." : "Start blank, generate an AI-assisted draft, or bring in an existing PowerPoint."}
      </p>
      {!hasQuery && <Button className="mt-4" onClick={onCreate}><Plus size={13} /> New presentation</Button>}
    </div>
  );
}
