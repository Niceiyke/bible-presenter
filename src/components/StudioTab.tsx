import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, Presentation, Edit2, Trash2, Search, FileUp, Sparkles, FileText } from "lucide-react";
import { useAppStore } from "../store";
import { StudioSlideCard } from "./StudioSlideCard";
import { buildCustomSlideItem } from "../utils";
import { ContentCard, ConfirmModal, StatusBadge, Button } from "./ui";
import type { CustomPresentation, CustomSlide, DisplayItem, PresentationSummary } from "../types";
import { AiPresentationModal } from "./presentations/AiPresentationModal";
import { PrayerDocxImportModal } from "./presentations/PrayerDocxImportModal";
import { compilePrayerGuide, type PrayerGuideImport } from "../imports/prayerGuide";

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
    studioList, setStudioList,
    expandedStudioPresId, setExpandedStudioPresId,
    studioSlides, setStudioSlides,
    appDataDir, setToast, bibleVersion,
  } = useAppStore();

  const [search, setSearch] = useState("");
  const [deletePres, setDeletePres] = useState<PresentationSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [showAiCreation, setShowAiCreation] = useState(false);
  const [importingPrayer, setImportingPrayer] = useState(false);
  const [prayerImport, setPrayerImport] = useState<PrayerGuideImport | null>(null);

  const importPowerPoint = async () => {
    setImporting(true);
    try {
      const selected = await open({
        title: "Import PowerPoint as rendered slides",
        multiple: false,
        directory: false,
        filters: [{ name: "PowerPoint Presentation", extensions: ["pptx"] }],
      });
      if (typeof selected !== "string") return;
      setToast("Rendering PowerPoint slides…");
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
        await invoke("save_studio_presentation", { presentation });
      } catch (error) {
        await invoke("discard_pptx_import", { id: imported.id }).catch(() => undefined);
        throw error;
      }
      const list = await invoke<PresentationSummary[]>("list_studio_presentations");
      setStudioList(list);
      setStudioSlides({ ...studioSlides, [presentation.id]: presentation.slides });
      setExpandedStudioPresId(presentation.id);
      await emit("studio-sync", list);
      setToast(`Imported ${presentation.slides.length} rendered PowerPoint slides`);
    } catch (error) {
      setToast(`PowerPoint import failed: ${error}`);
    } finally {
      setImporting(false);
    }
  };

  const importPrayerDocx = async () => {
    setImportingPrayer(true);
    try {
      const selected = await open({
        title: "Import daily prayer Word document",
        multiple: false,
        directory: false,
        filters: [{ name: "Word Document", extensions: ["docx"] }],
      });
      if (typeof selected !== "string") return;
      setToast("Reading prayer document and verifying Scripture…");
      const imported = await invoke<PrayerGuideImport>("import_prayer_docx", { path: selected, version: bibleVersion });
      setPrayerImport(imported);
      setToast(`Found ${imported.days.length} daily prayer sections`);
    } catch (error) {
      setToast(`Prayer DOCX import failed: ${error}`);
    } finally {
      setImportingPrayer(false);
    }
  };

  const handleDelete = async (id: string) => {
    await invoke("delete_studio_presentation", { id });
    const next = studioList.filter((p) => p.id !== id);
    setStudioList(next);
    emit("studio-sync", next);
    if (expandedStudioPresId === id) setExpandedStudioPresId(null);
  };

  const createAiPresentation = async (presentation: CustomPresentation) => {
    await invoke("save_studio_presentation", { presentation });
    const list = await invoke<PresentationSummary[]>("list_studio_presentations");
    setStudioList(list);
    setStudioSlides({ ...studioSlides, [presentation.id]: presentation.slides });
    setExpandedStudioPresId(presentation.id);
    await emit("studio-sync", list);
    setToast(`Created ${presentation.slides.length}-slide AI draft`);
    onOpenEditor(presentation.id);
  };

  const createPrayerDecks = async () => {
    if (!prayerImport) return;
    const presentations = compilePrayerGuide(prayerImport);
    try {
      await Promise.all(presentations.map((presentation) => invoke("save_studio_presentation", { presentation })));
      const list = await invoke<PresentationSummary[]>("list_studio_presentations");
      setStudioList(list);
      setStudioSlides({
        ...studioSlides,
        ...Object.fromEntries(presentations.map((presentation) => [presentation.id, presentation.slides])),
      });
      if (presentations[0]) setExpandedStudioPresId(presentations[0].id);
      await emit("studio-sync", list);
      setToast(`Created ${presentations.length} daily prayer decks`);
      setPrayerImport(null);
    } catch (error) {
      setToast(`Could not save prayer decks: ${error}`);
    }
  };

  const handlePresentStudio = async (id: string) => {
    if (expandedStudioPresId === id) {
      setExpandedStudioPresId(null);
      return;
    }
    if (!studioSlides[id]) {
      try {
        const data = await invoke<CustomPresentation>("load_studio_presentation", { id });
        setStudioSlides({ ...studioSlides, [id]: data.slides });
      } catch (err) {
        setToast("Failed to load presentation slides");
        return;
      }
    }
    setExpandedStudioPresId(id);
  };

  const filtered: PresentationSummary[] = search.trim()
    ? studioList.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : studioList;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-200">Presentations</h2>
          <p className="text-[10px] text-slate-600">{studioList.length} {studioList.length === 1 ? "presentation" : "presentations"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="md" onClick={() => setShowAiCreation(true)}>
            <Sparkles size={13} /> Create with AI
          </Button>
          <Button variant="ghost" size="md" onClick={() => void importPrayerDocx()} loading={importingPrayer} disabled={importingPrayer}>
            <FileText size={13} /> Prayer DOCX
          </Button>
          <Button variant="ghost" size="md" onClick={importPowerPoint} loading={importing} disabled={importing}>
            <FileUp size={13} /> Import PPTX
          </Button>
          <button
            onClick={onNewPresentation}
            className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-bold rounded-lg transition-all shadow-lg shadow-purple-900/30"
          >
            <Plus size={13} /> New
          </button>
        </div>
      </div>

      {studioList.length > 3 && (
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search presentations..."
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-slate-600 transition-colors"
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {filtered.map((pres) => {
          const isExpanded = expandedStudioPresId === pres.id;
          return (
            <ContentCard
              key={pres.id}
              className={isExpanded ? "border-tool-design/40 shadow-lg shadow-tool-design/10" : undefined}
            >
              <div className="flex items-center gap-3 p-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    isExpanded ? "bg-tool-design text-white" : "bg-console-surface-raised text-console-text-muted"
                  }`}
                >
                  <Presentation size={18} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-console-text truncate leading-tight">{pres.name}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <StatusBadge tone={pres.slide_count > 0 ? "design" : "neutral"} label={`${pres.slide_count} slide${pres.slide_count === 1 ? "" : "s"}`} />
                    {isExpanded && <StatusBadge tone="stage" label="Open" />}
                  </div>
                </div>

                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" icon={<Edit2 size={12} />} onClick={() => onOpenEditor(pres.id)}>Edit</Button>
                  <Button variant="bare" size="sm" icon={<Trash2 size={12} />} onClick={() => setDeletePres(pres)}>Delete</Button>
                  <Button
                    variant={isExpanded ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => handlePresentStudio(pres.id)}
                  >
                    {isExpanded ? "Collapse" : "Show Slides"}
                  </Button>
                </div>
              </div>

              {isExpanded && studioSlides[pres.id] && (
                <div className="px-3 pb-3 border-t border-console-border/50">
                  <div className="flex items-center gap-2 mt-2 mb-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-console-text-muted">Slides</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {studioSlides[pres.id].map((slide, idx) => {
                      const displayItem = buildCustomSlideItem(pres, studioSlides[pres.id], idx);
                      return (
                        <StudioSlideCard
                          key={slide.id}
                          slide={slide}
                          index={idx}
                          onStage={onStage ? (() => onStage(displayItem)) : undefined}
                          onLive={onLive ? (() => onLive(displayItem)) : undefined}
                          onAddToSchedule={onAddToSchedule ? (() => onAddToSchedule(displayItem)) : undefined}
                          appDataDir={appDataDir}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </ContentCard>
          );
        })}

        {filtered.length === 0 && search && (
          <p className="text-slate-600 text-xs text-center py-8">No presentations match "{search}"</p>
        )}

        {studioList.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="w-12 h-12 bg-console-surface-raised rounded-xl flex items-center justify-center border border-console-border">
              <Presentation size={22} className="text-console-text-subtle" />
            </div>
            <div>
              <p className="text-console-text-muted text-sm font-medium">No presentations yet</p>
              <p className="text-console-text-subtle text-xs mt-1">Create a deck or import a .pptx as rendered slides</p>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmModal
        open={!!deletePres}
        title={`Delete "${deletePres?.name ?? ""}"?`}
        description="The presentation and all its slides will be removed. This cannot be undone."
        confirmLabel="Delete Presentation"
        confirmVariant="live"
        onConfirm={async () => {
          if (deletePres) await handleDelete(deletePres.id);
        }}
        onClose={() => setDeletePres(null)}
      />
      <AiPresentationModal
        open={showAiCreation}
        defaultBibleVersion={bibleVersion}
        onClose={() => setShowAiCreation(false)}
        onCreate={createAiPresentation}
      />
      <PrayerDocxImportModal
        imported={prayerImport}
        onClose={() => setPrayerImport(null)}
        onCreate={createPrayerDecks}
      />
    </div>
  );
}
