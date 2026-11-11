import React from "react";
import { ChevronDown } from "lucide-react";
import type { Song } from "../../types";

interface SongMetadataFormProps {
  draft: Song;
  onChange: (patch: Partial<Song>) => void;
  errors?: string[];
  /** Editor mode keeps title/author/key visible and puts publishing details
   *  behind one disclosure. The importer uses the full form. */
  compact?: boolean;
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

/** Song metadata form — title, author, copyright, CCLI, key. Shared by the
 *  editor and importer so a value is never authored into the wrong field. */
export function SongMetadataForm({ draft, onChange, errors, compact = false }: SongMetadataFormProps) {
  const primary = compact ? FIELDS.filter((field) => field.key === "author" || field.key === "key" || field.key === "title") : FIELDS;
  const publishing = FIELDS.filter((field) => field.key === "copyright" || field.key === "ccli");

  const renderField = (field: MetadataFieldDef) => (
    <div key={field.key} className={`flex flex-col gap-1 ${field.full ? "col-span-2" : ""}`}>
      <label className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">
        {field.label}
      </label>
      <input
        className="h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2.5 placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
        placeholder={field.placeholder}
        value={draft[field.key] ?? ""}
        onChange={(e) => onChange({ [field.key]: e.target.value } as Partial<Song>)}
      />
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-3">
      {primary.map(renderField)}
      {compact && publishing.length > 0 && (
        <details className="col-span-2 rounded-lg border border-console-border bg-console-canvas/40">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">
            <ChevronDown size={12} /> Publishing details
          </summary>
          <div className="grid grid-cols-2 gap-3 border-t border-console-border p-2.5">
            {publishing.map(renderField)}
          </div>
        </details>
      )}
      {errors && errors.length > 0 && (
        <p className="col-span-2 text-[10px] text-state-error font-bold">{errors[0]}</p>
      )}
    </div>
  );
}
