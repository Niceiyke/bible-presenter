import React from "react";
import { AlertTriangle, FileText, Upload } from "lucide-react";
import { detectAndParse, type ParsedSong } from "../../utils/songImporter";
import { Button } from "../ui";
import { useT } from "../../i18n";

interface SongImportWizardProps {
  onImport: (parsed: ParsedSong) => Promise<void>;
  onCancel: () => void;
}

/** Paste, parse, review metadata and sections, import. The wizard keeps its
 *  own draft so a failed import never mutates the library. */
export function SongImportWizard({ onImport, onCancel }: SongImportWizardProps) {
  const t = useT();
  const [text, setText] = React.useState("");
  const [parsed, setParsed] = React.useState<ParsedSong | null>(null);
  const [title, setTitle] = React.useState("");
  const [author, setAuthor] = React.useState("");
  const [key, setKey] = React.useState("");
  const [copyright, setCopyright] = React.useState("");
  const [ccli, setCcli] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleParse = () => {
    const { result } = detectAndParse(text);
    setParsed(result);
    setTitle(result.title || "");
    setAuthor(result.author || "");
    setKey(result.key || "");
    setCopyright(result.copyright || "");
    setCcli(result.ccli || "");
  };

  const hasChords = text.includes("[") && /\[[A-G]/.test(text);

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);
    try {
      await onImport({ ...parsed, title, author, key, copyright, ccli });
    } catch {
      // Import failure is surfaced by the caller via onImport; keep the
      // wizard open so the operator can retry.
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-console-border bg-console-surface/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-console-text-muted"><Upload size={12} /> Import lyrics</p>
          <p className="mt-1 text-[10px] text-console-text-subtle">
            Paste from EasyWorship, OpenLP, ChordPro, or plain text with section labels.
          </p>
        </div>
        <button onClick={onCancel} className="flex h-8 w-8 items-center justify-center rounded-lg text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text" aria-label="Close import">×</button>
      </div>

      <textarea
        className="h-40 w-full resize-y rounded-lg border border-console-border bg-console-canvas px-3 py-2 font-mono text-xs text-console-text placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        placeholder={`Amazing Grace\n\nVerse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\nAmazing grace how sweet the sound\n...`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[9px] text-console-text-subtle">
          {hasChords && <span className="font-bold text-state-warning">Chords detected · they will be removed from lyric lines.</span>}
        </p>
        <div className="flex items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.cho,.pro,.chordpro,.xml,.json,text/plain,text/xml,application/json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setText(await file.text());
              event.target.value = "";
            }}
          />
          <Button variant="bare" size="sm" onClick={() => fileRef.current?.click()}>
            Open file
          </Button>
          <Button variant="ghost" size="sm" onClick={handleParse} disabled={!text.trim()}>
            {t("songs.importReview")}
          </Button>
        </div>
      </div>

      {parsed && (
        <div className="flex flex-col gap-3 rounded-xl border border-console-border bg-console-canvas/60 p-3">
          {parsed.warnings.length > 0 && (
            <div className="flex items-start gap-1.5 rounded-lg border border-state-warning/30 bg-state-warning/10 px-2 py-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-state-warning" />
              <div className="text-[10px] leading-relaxed text-state-warning">
                {parsed.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <ImportField label="Title" value={title} onChange={setTitle} className="col-span-2" />
            <ImportField label="Author" value={author} onChange={setAuthor} />
            <ImportField label="Key" value={key} onChange={setKey} placeholder="e.g. G" />
            <ImportField label="Copyright" value={copyright} onChange={setCopyright} />
            <ImportField label="CCLI" value={ccli} onChange={setCcli} />
          </div>

          <div>
            <p className="mb-1.5 text-[9px] font-black uppercase tracking-wider text-console-text-subtle">
              {parsed.sections.length} section{parsed.sections.length === 1 ? "" : "s"} · detected as {parsed.format}
            </p>
            <div className="custom-scrollbar flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
              {parsed.sections.map((section, index) => (
                <div key={`${section.label}-${index}`} className="rounded-lg border border-console-border bg-console-surface px-2.5 py-2">
                  <p className="mb-1 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wide text-action-primary">
                    <FileText size={10} /> {section.label || `Section ${index + 1}`}
                  </p>
                  {section.lines.slice(0, 4).map((line, lineIndex) => (
                    <p key={lineIndex} className="truncate font-mono text-[10px] leading-snug text-console-text-muted">{line}</p>
                  ))}
                  {section.lines.length > 4 && (
                    <p className="mt-1 text-[9px] text-console-text-subtle">+ {section.lines.length - 4} more lines</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="bare" size="md" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" size="md" onClick={handleImport} loading={importing} disabled={!title.trim() || parsed.sections.length === 0}>
              {t("songs.import")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportField({
  label,
  value,
  onChange,
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-[9px] font-bold uppercase tracking-wider text-console-text-subtle">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-md border border-console-border bg-console-surface-raised px-2 text-xs text-console-text placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      />
    </div>
  );
}
