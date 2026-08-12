import React from "react";
import { FONTS } from "../../types";
import type { Song } from "../../types";

interface SongMetadataFormProps {
  draft: Song;
  onChange: (patch: Partial<Song>) => void;
  errors?: string[];
}

export interface MetadataFieldDef {
  key: "title" | "author" | "copyright" | "ccli" | "key";
  label: string;
  placeholder: string;
  full?: boolean;
}

const FIELDS: MetadataFieldDef[] = [
  { key: "title", label: "Title", placeholder: "Song title", full: true },
  { key: "author", label: "Author", placeholder: "Author / writer" },
  { key: "key", label: "Key", placeholder: "e.g. G" },
  { key: "copyright", label: "Copyright", placeholder: "© Year Publisher" },
  { key: "ccli", label: "CCLI", placeholder: "CCLI number" },
];

/** Phase 5: song metadata form — title, author, copyright, CCLI, key. Shared by
 *  the editor and importer so a value is never authored into the wrong field. */
export function SongMetadataForm({ draft, onChange, errors }: SongMetadataFormProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {FIELDS.map((f) => (
        <div key={f.key} className={`flex flex-col gap-1 ${f.full ? "col-span-2" : ""}`}>
          <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">
            {f.label}
          </label>
          <input
            className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2.5 placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
            placeholder={f.placeholder}
            value={draft[f.key] ?? ""}
            onChange={(e) => onChange({ [f.key]: e.target.value } as Partial<Song>)}
          />
        </div>
      ))}
      {errors && errors.length > 0 && (
        <p className="col-span-2 text-[10px] text-state-error font-bold">{errors[0]}</p>
      )}
    </div>
  );
}