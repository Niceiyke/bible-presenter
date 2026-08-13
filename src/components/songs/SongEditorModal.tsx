import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Music2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FONTS } from "../../types";
import type { Song, SongSlideData, SongStyle, MediaItem } from "../../types";
import { normalizeSong, getSongSequence, syncArrangementForSections, songValidate } from "../../utils/song";
import { useAppStore } from "../../store";
import { useT } from "../../i18n";
import { Button, Modal, SaveStatus, type SaveStatusState } from "../ui";
import { SongMetadataForm } from "./SongMetadataForm";
import { SongSectionEditorList } from "./SongSectionEditor";
import { SongArrangementEditor } from "./SongArrangementEditor";
import { SongPreviewBox } from "./SongPreviewBox";
import { LowerThirdOverlay } from "../shared/Renderers";
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
  sections: [{ label: "Verse", lines: [""] }],
  arrangement: [],
  style: "LowerThird",
});

/** Phase 5: the song editor — metadata form, multiline section editor,
 *  separate arrangement-step editor, display defaults, a live 16:9 preview
 *  (full-screen and overlay), explicit Save/Cancel with unsaved-change
 *  confirmation, and validation that prevents saving an empty song. */
export function SongEditorModal({ song, onClose, onSave }: SongEditorModalProps) {
  const [draft, setDraft] = useState<Song>(() => normalizeSong(song ? JSON.parse(JSON.stringify(song)) : newSong()));
  const [original] = useState<Song>(() => normalizeSong(song ? JSON.parse(JSON.stringify(song)) : newSong()));
  const [saveState, setSaveState] = useState<SaveStatusState>("idle");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [previewMode, setPreviewMode] = useState<"full" | "overlay">("full");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showBackground, setShowBackground] = useState(false);
  const ltTemplate = useAppStore((s) => s.ltTemplate);
  const ltSavedTemplates = useAppStore((s) => s.ltSavedTemplates);
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
    if (song) setDraft(normalizeSong(JSON.parse(JSON.stringify(song))));
    else setDraft(normalizeSong(newSong()));
  }, [song]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  useEffect(() => {
    if (dirty && saveState !== "saving" && saveState !== "failed") setSaveState("unsaved");
    else if (!dirty && saveState !== "saving" && saveState !== "failed") setSaveState("idle");
  }, [dirty, saveState]);

  const sequence = useMemo(() => getSongSequence(draft), [draft]);
  const validation = useMemo(() => songValidate(draft), [draft]);
  const previewClamped = Math.max(0, Math.min(previewIndex, sequence.length - 1));
  const previewSection = sequence[previewClamped];
  const previewLabel = previewSection
    ? `${previewSection.label} (${previewClamped + 1} of ${sequence.length || 1})`
    : "No sections";

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
    section_label: previewSection?.label ?? "",
    lines: previewSection?.lines ?? [],
    slide_index: previewClamped,
    total_slides: sequence.length,
    style: draft.style,
    font: draft.font,
    font_size: draft.font_size,
    font_weight: draft.font_weight,
    color: draft.color,
    background: draft.background,
  }), [draft, previewSection, previewClamped, sequence.length]);

  const overlayData = previewSection
    ? {
        kind: "Lyrics" as const,
        data: {
          line1: previewSection.lines[0] ?? "",
          line2: previewSection.lines[1],
          section_label: previewSection.label,
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

  const sequenceLength = sequence.length;

  return (
    <Modal
      open={!!song}
      onClose={requestClose}
      title={draft.id ? t("songs.editor.editTitle") : t("songs.editor.newTitle")}
      headerRight={confirmDiscard ? undefined : <SaveStatus state={saveState} />}
      footer={footer}
      maxWidth="max-w-4xl"
      maxHeightClass="max-h-[92vh]"
    >
      <div className="grid md:grid-cols-[1fr_minmax(260px,360px)] gap-4 p-4">
        {/* ── Left: editor ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 min-w-0">
          <SongMetadataForm draft={draft} onChange={patch} />

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.editor.sections")}</p>
            <SongSectionEditorList sections={draft.sections} onChange={setSections} />
          </div>

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

        {/* ── Right: live preview ──────────────────────────────────────── */}
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 bg-console-surface-raised border border-console-border rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setPreviewMode("full")}
                className={`h-7 px-2 text-[10px] font-bold rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  previewMode === "full" ? "bg-console-surface-strong text-action-primary" : "text-console-text-subtle hover:text-console-text"
                }`}
                aria-pressed={previewMode === "full"}
              >
                Full-screen
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("overlay")}
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
              <div className="absolute inset-0" aria-hidden>
                <LowerThirdOverlay data={overlayData as any} template={overlayTemplate} />
              </div>
            )}
            {sequenceLength === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-[10px] text-console-text-subtle italic">{t("songs.editor.noSections")}</p>
              </div>
            )}
          </div>

          <div className="flex gap-1.5">
            <Button variant="ghost" size="md" onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))} disabled={previewClamped <= 0}>{t("songs.editor.prev")}</Button>
            <Button variant="ghost" size="md" onClick={() => setPreviewIndex((i) => Math.min(sequence.length - 1, i + 1))} disabled={previewClamped >= sequence.length - 1}>{t("songs.editor.next")}</Button>
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