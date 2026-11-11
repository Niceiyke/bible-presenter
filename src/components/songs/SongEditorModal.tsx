import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Music2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FONTS } from "../../types";
import type { Song, SongSlideData, SongStyle, MediaItem } from "../../types";
import { normalizeSong, getSongPageCount, getSongPages, syncArrangementForSections, songValidate } from "../../utils/song";
import { detectAndParse } from "../../utils/songImporter";
import { stableId } from "../../utils";
import { useAppStore } from "../../store";
import { useT } from "../../i18n";
import { Button, Modal, SaveStatus, type SaveStatusState } from "../ui";
import { SongMetadataForm } from "./SongMetadataForm";
import { SongSectionEditorList } from "./SongSectionEditor";
import { SongArrangementEditor } from "./SongArrangementEditor";
import { SongPreviewBox } from "./SongPreviewBox";
import { SongOverlayPreview } from "./SongOverlayPreview";
import { BackgroundEditor } from "../BackgroundEditor";

interface SongEditorModalProps {
  /** The song being edited (or a new-song stub). Resets the internal draft. */
  song: Song | null;
  onClose: () => void;
  /** Persist the draft. Rejects on failure so the modal stays open with the
   *  draft intact and the caller can surface the error. */
  onSave: (draft: Song) => Promise<void>;
}

const newSong = (): Song => ({
  id: "",
  title: "",
  author: "",
  sections: [{ label: "Verse 1", lines: [""] }],
  arrangement: [],
  style: "LowerThird",
});

/** Phase 5: the song editor — metadata form, multiline section editor,
 *  separate arrangement-step editor, display defaults, a live 16:9 preview
 *  (full-screen and overlay), explicit Save/Cancel with unsaved-change
 *  confirmation, and validation that prevents saving an empty song. */
export function SongEditorModal({ song, onClose, onSave }: SongEditorModalProps) {
  const [draft, setDraft] = useState<Song>(() => normalizeSong(song ? JSON.parse(JSON.stringify(song)) : newSong()));
  const [original, setOriginal] = useState<Song>(() => normalizeSong(song ? JSON.parse(JSON.stringify(song)) : newSong()));
  const [saveState, setSaveState] = useState<SaveStatusState>("idle");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [previewMode, setPreviewMode] = useState<"full" | "overlay">("full");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showBackground, setShowBackground] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const ltTemplate = useAppStore((s) => s.ltTemplate);
  const ltSavedTemplates = useAppStore((s) => s.ltSavedTemplates);
  const ltLinesPerDisplay = useAppStore((s) => s.ltLinesPerDisplay);
  const media = useAppStore((s) => s.media);
  const setMedia = useAppStore((s) => s.setMedia);
  const settings = useAppStore((s) => s.settings);
  const t = useT();

  // Inline upload handler so the `BackgroundEditor` picker can import a new
  // asset straight from the song editor without wiring `useItemActions`
  // through. Mirrors `useItemActions.handleFileUpload` exactly so behaviour
  // stays consistent across the app.
  const handleUploadMedia = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
          { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
          { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] },
        ],
      });
      if (!selected || typeof selected !== "string") return;
      await invoke("add_media_streaming", { path: selected });
      const result: MediaItem[] = await invoke("list_media");
      setMedia(result);
    } catch (err: any) {
      console.error("Upload failed:", err);
    }
  };

  useEffect(() => {
    // The modal stays mounted while closed, so both sides of the dirty
    // comparison must be reset together whenever the selected song changes.
    // Resetting only `draft` marked every freshly opened song as unsaved.
    const next = normalizeSong(song ? JSON.parse(JSON.stringify(song)) : newSong());
    setDraft(next);
    setOriginal(next);
    setSaveState("idle");
    setConfirmDiscard(false);
    setPreviewMode(((song?.style ?? "LowerThird") === "FullSlide") ? "full" : "overlay");
    setPreviewIndex(0);
    setAdvancedOpen(false);
    setShowDefaults(false);
    setShowBackground(false);
    setPasteText("");
    setPasteError("");
  }, [song]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  useEffect(() => {
    if (dirty && saveState !== "saving" && saveState !== "failed") setSaveState("unsaved");
    else if (!dirty && saveState !== "saving" && saveState !== "failed") setSaveState("idle");
  }, [dirty, saveState]);

  const validation = useMemo(() => songValidate(draft), [draft]);
  const previewStyle: SongStyle = previewMode === "full" ? "FullSlide" : "LowerThird";
  const previewPages = useMemo(
    () => getSongPages(draft, { style: previewStyle, linesPerDisplay: ltLinesPerDisplay }),
    [draft, previewStyle, ltLinesPerDisplay],
  );
  const defaultPageCount = getSongPageCount(draft, draft.style, ltLinesPerDisplay);
  const previewClamped = previewPages.length === 0
    ? 0
    : Math.max(0, Math.min(previewIndex, previewPages.length - 1));
  const previewPage = previewPages[previewClamped];
  const previewLabel = previewPage
    ? `${previewPage.sectionLabel || "Lyrics"} (${previewClamped + 1} of ${previewPages.length})`
    : "No pages";

  const patch = (next: Partial<Song>) => setDraft((d) => ({ ...d, ...next }));
  // Sections carry stable ids. When a section is added or removed (a
  // structural change), keep the arrangement in sync so the sequence always
  // includes every verse. Pure lyric/label edits never reorder a deliberate
  // custom arrangement.
  const setSections = (next: Song["sections"]) => setDraft((d) => ({
    ...d,
    sections: next,
    arrangement_steps: syncArrangementForSections(d.arrangement_steps, d.sections, next),
  }));
  const setArrangement = (steps: Song["arrangement_steps"]) =>
    setDraft((d) => ({ ...d, arrangement_steps: steps }));

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await onSave(draft);
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  };

  const requestClose = () => {
    if (dirty && saveState !== "saving") setConfirmDiscard(true);
    else onClose();
  };

  const previewData: SongSlideData = useMemo(() => ({
    song_id: draft.id,
    title: draft.title || "Untitled song",
    author: draft.author,
    section_label: previewPage?.sectionLabel ?? "",
    section_id: previewPage?.sectionId,
    lines: previewPage?.lines ?? [],
    slide_index: previewClamped,
    total_slides: previewPages.length,
    line_start: previewPage?.lineStart,
    style: previewStyle,
    font: draft.font,
    font_size: draft.font_size,
    font_weight: draft.font_weight,
    color: draft.color,
    background: draft.background,
  }), [draft, previewPage, previewStyle, previewClamped, previewPages.length]);

  const overlayData = previewPage
    ? {
        kind: "Lyrics" as const,
        data: {
          line1: previewPage.lines[0] ?? "",
          line2: previewPage.lines[1],
          section_label: previewPage.sectionLabel,
        },
      }
    : { kind: "Nameplate" as const, data: { name: draft.title || "Untitled song", title: draft.author } };

  // Preview the overlay with the song's chosen template when it has one.
  const overlayTemplate = draft.lt_template_id
    ? ltSavedTemplates.find((t) => t.id === draft.lt_template_id) ?? ltTemplate
    : ltTemplate;

  const footer = confirmDiscard ? (
    <>
      <span className="text-[11px] text-state-warning font-bold mr-auto">{t("songs.editor.discardConfirm")}</span>
      <Button variant="bare" size="md" onClick={() => setConfirmDiscard(false)}>{t("songs.editor.keepEditing")}</Button>
      <Button variant="live" size="md" onClick={onClose}>{t("songs.editor.discard")}</Button>
    </>
  ) : (
    <>
      <SaveStatus state={saveState} />
      <Button variant="bare" size="md" onClick={requestClose} disabled={saveState === "saving"}>{t("songs.editor.cancel")}</Button>
      <Button
        variant="primary"
        size="md"
        onClick={handleSave}
        loading={saveState === "saving"}
        disabled={!validation.ok || saveState === "saving"}
      >
        {t("songs.editor.save")}
      </Button>
    </>
  );

  const applyPastedLyrics = () => {
    const parsed = detectAndParse(pasteText).result;
    if (parsed.sections.length === 0) {
      setPasteError("No lyric sections were detected. Try adding a section label such as Verse 1.");
      return;
    }
    setDraft((current) => ({
      ...current,
      title: current.title.trim() ? current.title : (parsed.title || "Untitled"),
      author: current.author?.trim() ? current.author : parsed.author,
      copyright: current.copyright?.trim() ? current.copyright : parsed.copyright,
      ccli: current.ccli?.trim() ? current.ccli : parsed.ccli,
      key: current.key?.trim() ? current.key : parsed.key,
      sections: parsed.sections.map((section) => ({
        id: stableId(),
        label: section.label || "Verse 1",
        lines: section.lines,
      })),
      arrangement_steps: [],
    }));
    setPasteError("");
    setPasteText("");
  };

  return (
    <Modal
      open={!!song}
      onClose={requestClose}
      title={draft.id ? t("songs.editor.editTitle") : t("songs.editor.newTitle")}
      footer={footer}
      maxWidth="max-w-5xl"
      maxHeightClass="max-h-[92vh]"
    >
      <div className="grid md:grid-cols-[1fr_minmax(280px,380px)] gap-4 p-4">
        {/* ── Left: editor ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 min-w-0">
          {!draft.id && (
            <div className="rounded-xl border border-console-border bg-console-canvas/60 p-3">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-action-primary" />
                <p className="text-[10px] font-black uppercase tracking-wider text-console-text-muted">{t("songs.editor.pasteLyrics")}</p>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-console-text-subtle">
                Paste lyrics from EasyWorship, OpenLP, ChordPro, or plain text. We will split sections and fill the title when we can.
              </p>
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder={"Amazing grace, how sweet the sound\nThat saved a wretch like me\n\nChorus\n..."}
                className="mt-2 h-28 w-full resize-y rounded-lg border border-console-border bg-console-surface px-3 py-2 font-mono text-xs text-console-text placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              />
              {pasteError && <p className="mt-1 text-[10px] font-bold text-state-error">{pasteError}</p>}
              <div className="mt-2 flex justify-end">
                <Button variant="ghost" size="sm" onClick={applyPastedLyrics} disabled={!pasteText.trim()}>
                  {t("songs.editor.useLyrics")}
                </Button>
              </div>
            </div>
          )}

          <SongMetadataForm draft={draft} onChange={patch} compact />

          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.editor.sections")}</p>
              <p className="text-[10px] text-console-text-subtle">
                {draft.sections.length} section{draft.sections.length === 1 ? "" : "s"} · {defaultPageCount} page{defaultPageCount === 1 ? "" : "s"} at {draft.style === "FullSlide" ? "full screen" : "lower third"}
              </p>
            </div>
            <SongSectionEditorList sections={draft.sections} onChange={setSections} />
          </div>

          <div className="border border-console-border rounded-lg">
            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left transition-all hover:bg-console-surface-raised focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? <ChevronDown size={14} className="text-console-text-subtle" /> : <ChevronRight size={14} className="text-console-text-subtle" />}
              <span className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.editor.advanced")}</span>
              <span className="ml-auto text-[9px] text-console-text-subtle">Arrangement · Display · Background</span>
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-3 border-t border-console-border p-3">
                <SongArrangementEditor draft={draft} onChange={setArrangement} />

          <div className="border border-console-border rounded-lg">
            <button
              type="button"
              onClick={() => setShowDefaults((v) => !v)}
              className="w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-console-surface-raised rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)]"
              aria-expanded={showDefaults}
            >
              {showDefaults ? <ChevronDown size={14} className="text-console-text-subtle" /> : <ChevronRight size={14} className="text-console-text-subtle" />}
              <span className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.editor.displayDefaults")}</span>
            </button>
            {showDefaults && (
              <div className="grid grid-cols-2 gap-3 p-3 border-t border-console-border">
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Default output mode</label>
                  <div className="flex bg-console-surface-raised border border-console-border rounded-lg p-0.5 w-fit">
                    {(["LowerThird", "FullSlide"] as SongStyle[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => patch({ style: m })}
                        className={`h-8 px-3 text-[10px] font-bold rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                          (draft.style ?? "LowerThird") === m
                            ? "bg-console-surface-strong text-action-primary"
                            : "text-console-text-subtle hover:text-console-text"
                        }`}
                        aria-pressed={(draft.style ?? "LowerThird") === m}
                      >
                        {m === "FullSlide" ? t("songs.use.fullScreen") : t("songs.use.lyricsOverlay")}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Font</label>
                  <select
                    className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2 focus:border-console-border-strong"
                    value={draft.font || ""}
                    onChange={(e) => patch({ font: e.target.value || undefined })}
                  >
                    <option value="">Theme default</option>
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Font size (pt)</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
                    value={draft.font_size ?? settings.font_size}
                    placeholder="Default"
                    onChange={(e) => patch({ font_size: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Font weight</label>
                  <select
                    className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2"
                    value={draft.font_weight || ""}
                    onChange={(e) => patch({ font_weight: e.target.value || undefined })}
                  >
                    <option value="">Default</option>
                    <option value="normal">Normal</option>
                    <option value="bold">Bold</option>
                    <option value="500">Medium</option>
                    <option value="700">Bold (700)</option>
                    <option value="900">Black</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Text colour</label>
                  <input
                    type="color"
                    className="h-9 w-full rounded-md bg-transparent border border-console-border cursor-pointer"
                    value={draft.color || "#ffffff"}
                    onChange={(e) => patch({ color: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Lower-third template</label>
                  <select
                    className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2 focus:border-console-border-strong"
                    value={draft.lt_template_id ?? ""}
                    onChange={(e) => patch({ lt_template_id: e.target.value || undefined })}
                  >
                    <option value="">Inherit current template</option>
                    {ltSavedTemplates.map((tmpl) => (
                      <option key={tmpl.id} value={tmpl.id}>{tmpl.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-console-text-subtle leading-snug">
                    Used for this song&apos;s lyrics overlay. Inherit uses the template selected in the Lower-Third tab.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="border border-console-border rounded-lg">
            <button
              type="button"
              onClick={() => setShowBackground((v) => !v)}
              className="w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-console-surface-raised rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)]"
              aria-expanded={showBackground}
            >
              {showBackground ? <ChevronDown size={14} className="text-console-text-subtle" /> : <ChevronRight size={14} className="text-console-text-subtle" />}
              <span className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.editor.background")}</span>
            </button>
            {showBackground && (
              <div className="p-3 border-t border-console-border">
                <p className="text-[10px] text-console-text-subtle mb-2 leading-snug">
                  Override the global output background for this song only. Leave on <span className="font-bold">Inherit</span> (None) to use the Settings → Backgrounds "Songs" override, then the global output background.
                </p>
                <BackgroundEditor
                  label={t("songs.editor.background")}
                  value={draft.background ?? { type: "None" }}
                  onChange={(bg) => patch({ background: bg })}
                  media={media}
                  onUploadMedia={handleUploadMedia}
                />
              </div>
            )}
          </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: live preview ──────────────────────────────────────── */}
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 bg-console-surface-raised border border-console-border rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => { setPreviewMode("full"); setPreviewIndex(0); }}
                className={`h-7 px-2 text-[10px] font-bold rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  previewMode === "full" ? "bg-console-surface-strong text-action-primary" : "text-console-text-subtle hover:text-console-text"
                }`}
                aria-pressed={previewMode === "full"}
              >
                Full-screen
              </button>
              <button
                type="button"
                onClick={() => { setPreviewMode("overlay"); setPreviewIndex(0); }}
                className={`h-7 px-2 text-[10px] font-bold rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  previewMode === "overlay" ? "bg-console-surface-strong text-action-primary" : "text-console-text-subtle hover:text-console-text"
                }`}
                aria-pressed={previewMode === "overlay"}
              >
                Overlay
              </button>
            </div>
            <p className="text-[10px] text-console-text-subtle tabular-nums truncate">{previewLabel}</p>
          </div>

          <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-slate-950 border border-console-border">
            {previewMode === "full" ? (
              <SongPreviewBox
                data={previewData}
                showSectionLabel={!!settings.show_song_section_labels}
                fill
              />
            ) : (
              <SongOverlayPreview data={overlayData} template={overlayTemplate} />
            )}
            {previewPages.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-[10px] text-console-text-subtle italic">{t("songs.editor.noSections")}</p>
              </div>
            )}
          </div>

          <div className="flex gap-1.5">
            <Button variant="ghost" size="md" onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))} disabled={previewClamped <= 0}>{t("songs.editor.prev")}</Button>
            <Button variant="ghost" size="md" onClick={() => setPreviewIndex((i) => Math.min(previewPages.length - 1, i + 1))} disabled={previewClamped >= previewPages.length - 1}>{t("songs.editor.next")}</Button>
          </div>
          <p className="flex items-center gap-1.5 text-[10px] text-console-text-subtle">
            <Music2 size={11} /> {t("songs.editor.previewLocal")}
          </p>
        </div>
      </div>

      {!validation.ok && (
        <div className="px-4 pb-3 -mt-1">
          {validation.errors.map((e) => (
            <p key={e} className="text-[10px] text-state-error font-bold">{e}</p>
          ))}
        </div>
      )}
    </Modal>
  );
}