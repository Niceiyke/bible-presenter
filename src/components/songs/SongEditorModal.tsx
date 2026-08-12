import React, { useEffect, useState } from "react";
import { FONTS } from "../../types";
import type { Song } from "../../types";
import { Button, Modal } from "../ui";

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

/** Song metadata + sections + styling + arrangement editor. Keeps its own
 *  local draft separate from the persisted library so Cancel never mutates
 *  saved songs and Save failure keeps the draft. */
export function SongEditorModal({ song, onClose, onSave }: SongEditorModalProps) {
  const [draft, setDraft] = useState<Song>(() => (song ? JSON.parse(JSON.stringify(song)) : newSong()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (song) setDraft(JSON.parse(JSON.stringify(song)));
    else setDraft(newSong());
  }, [song]);

  const patch = (next: Song) => setDraft(next);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } catch {
      // Save failure is surfaced by the caller via onSave; keep the modal
      // open with the draft intact so the operator can retry.
    } finally {
      setSaving(false);
    }
  };

  const updateSection = (si: number, next: Song["sections"][number]) => {
    const s = [...draft.sections];
    s[si] = next;
    patch({ ...draft, sections: s });
  };

  const footer = (
    <>
      <Button variant="bare" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button variant="primary" onClick={handleSave} loading={saving}>Save Song</Button>
    </>
  );

  return (
    <Modal
      open={!!song}
      onClose={onClose}
      title={draft.id ? "Edit Song" : "New Song"}
      footer={footer}
      maxWidth="max-w-2xl"
      maxHeightClass="max-h-[90vh]"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700"
            placeholder="Song title"
            value={draft.title}
            onChange={(e) => patch({ ...draft, title: e.target.value })}
          />
          <input
            className="flex-1 bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700"
            placeholder="Author (optional)"
            value={draft.author || ""}
            onChange={(e) => patch({ ...draft, author: e.target.value })}
          />
          <select
            className="bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700 focus:outline-none"
            value={draft.style || "LowerThird"}
            onChange={(e) => patch({ ...draft, style: e.target.value as any })}
          >
            <option value="LowerThird">Lower Third</option>
            <option value="FullSlide">Full Slide (Hymn Style)</option>
          </select>
        </div>

        {draft.sections.map((section, si) => (
          <div key={si} className="bg-slate-800/50 border border-slate-700 rounded-xl p-3 flex flex-col gap-2">
            <div className="flex gap-2 items-center">
              <input
                className="flex-1 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600 font-bold"
                value={section.label}
                onChange={(e) => updateSection(si, { ...section, label: e.target.value })}
              />
              <button
                onClick={() => patch({ ...draft, sections: draft.sections.filter((_, i) => i !== si) })}
                className="text-red-500 hover:text-red-300 text-xs font-bold px-1"
              >✕</button>
            </div>
            {section.lines.map((line, li) => (
              <div key={li} className="flex gap-1">
                <input
                  className="flex-1 bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700"
                  value={line}
                  placeholder={`Line ${li + 1}`}
                  onChange={(e) => {
                    const lines = [...section.lines];
                    lines[li] = e.target.value;
                    updateSection(si, { ...section, lines });
                  }}
                />
                <button
                  onClick={() => updateSection(si, {
                    ...section,
                    lines: section.lines.filter((_, i) => i !== li),
                  })}
                  className="text-slate-600 hover:text-red-400 text-xs px-1"
                >✕</button>
              </div>
            ))}
            <button
              onClick={() => updateSection(si, { ...section, lines: [...section.lines, ""] })}
              className="text-[10px] text-slate-500 hover:text-amber-400 font-bold uppercase self-start"
            >+ Add Line</button>
          </div>
        ))}
        <button
          onClick={() => patch({ ...draft, sections: [...draft.sections, { label: `Section ${draft.sections.length + 1}`, lines: [""] }] })}
          className="text-[10px] font-bold uppercase text-slate-500 hover:text-amber-400 border border-slate-700 hover:border-amber-500 rounded-lg py-2"
        >+ Add Section</button>

        <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Song Styling</p>
            {(draft.font || draft.font_size || draft.font_weight || draft.color) && (
              <button
                onClick={() => patch({ ...draft, font: undefined, font_size: undefined, font_weight: undefined, color: undefined })}
                className="text-[9px] font-bold uppercase text-slate-500 hover:text-red-400"
              >Reset Style</button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-500 uppercase font-bold">Font Family</label>
              <select
                className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                value={draft.font || ""}
                onChange={(e) => patch({ ...draft, font: e.target.value || undefined })}
              >
                <option value="">Default (Theme)</option>
                {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-500 uppercase font-bold">Font Size (pt)</label>
              <input
                type="number"
                className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                value={draft.font_size || ""}
                placeholder="Default"
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  patch({ ...draft, font_size: isNaN(val) ? undefined : val });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-500 uppercase font-bold">Font Weight</label>
              <select
                className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                value={draft.font_weight || ""}
                onChange={(e) => patch({ ...draft, font_weight: e.target.value || undefined })}
              >
                <option value="">Default</option>
                <option value="normal">Normal</option>
                <option value="bold">Bold</option>
                <option value="100">Thin (100)</option>
                <option value="300">Light (300)</option>
                <option value="500">Medium (500)</option>
                <option value="700">Bold (700)</option>
                <option value="900">Black (900)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-500 uppercase font-bold">Text Color</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  className="w-8 h-8 bg-transparent border-none cursor-pointer rounded-lg overflow-hidden"
                  value={draft.color || "#ffffff"}
                  onChange={(e) => patch({ ...draft, color: e.target.value })}
                />
                <input
                  className="flex-1 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                  value={draft.color || ""}
                  placeholder="Default"
                  onChange={(e) => patch({ ...draft, color: e.target.value || undefined })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Arrangement</p>
            {(draft.arrangement ?? []).length > 0 && (
              <button
                onClick={() => patch({ ...draft, arrangement: [] })}
                className="text-[9px] font-bold uppercase text-slate-500 hover:text-red-400"
              >Clear</button>
            )}
          </div>
          <p className="text-[10px] text-slate-600">Order sections for playback (repeat chorus, etc.)</p>
          <div className="flex flex-wrap gap-1.5">
            {draft.sections.map((sec) => (
              <button
                key={sec.label}
                onClick={() => patch({ ...draft, arrangement: [...(draft.arrangement ?? []), sec.label] })}
                className="px-2 py-0.5 text-[10px] font-bold rounded bg-slate-700 hover:bg-amber-700 text-slate-300 hover:text-white border border-slate-600 hover:border-amber-500 transition-all"
              >+ {sec.label}</button>
            ))}
          </div>
          {(draft.arrangement ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {(draft.arrangement ?? []).map((label, i) => (
                <span
                  key={`${label}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded bg-amber-900/50 text-amber-300 border border-amber-700"
                >
                  {i + 1}. {label}
                  <button
                    onClick={() => {
                      const arr = [...(draft.arrangement ?? [])];
                      arr.splice(i, 1);
                      patch({ ...draft, arrangement: arr });
                    }}
                    className="text-amber-500 hover:text-red-400 ml-0.5"
                  >×</button>
                </span>
              ))}
            </div>
          )}
          {(draft.arrangement ?? []).length === 0 && (
            <p className="text-[10px] text-slate-600 italic">Using natural section order</p>
          )}
        </div>
      </div>
    </Modal>
  );
}