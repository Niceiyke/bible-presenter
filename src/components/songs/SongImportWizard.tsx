import React from "react";
import { detectAndParse, type ParsedSong } from "../../utils/songImporter";
import { Button } from "../ui";

interface SongImportWizardProps {
  onImport: (parsed: ParsedSong) => Promise<void>;
  onCancel: () => void;
}

/** Text import wizard: paste, parse, correct metadata, import. Keeps its own
 *  text + parsed draft so a failed import never mutates the library. */
export function SongImportWizard({ onImport, onCancel }: SongImportWizardProps) {
  const [text, setText] = React.useState("");
  const [parsed, setParsed] = React.useState<ParsedSong | null>(null);
  const [title, setTitle] = React.useState("");
  const [author, setAuthor] = React.useState("");
  const [importing, setImporting] = React.useState(false);

  const handleParse = () => {
    const { detected, result } = detectAndParse(text);
    setParsed(result);
    setTitle(result.title || "");
    setAuthor(result.author || "");
  };

  const hasChords = text.includes("[") && /\[[A-G]/.test(text);

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);
    try {
      await onImport({ ...parsed, title, author });
    } catch {
      // Import failure is surfaced by the caller via onImport; keep the
      // wizard open so the operator can retry.
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase text-slate-300">Import Song</p>
          <p className="text-[9px] text-slate-600">
            Paste from EasyWorship, OpenLP, ChordPro, or plain text with section labels
          </p>
        </div>
        <button onClick={onCancel} className="text-slate-500 hover:text-red-400 text-lg leading-none">×</button>
      </div>

      <textarea
        className="w-full h-40 bg-slate-950 text-slate-200 text-xs rounded-lg p-3 border border-slate-700 resize-none font-mono"
        placeholder={`Amazing Grace\n\nVerse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\nAmazing grace how sweet the sound\n...`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <Button
        variant="ghost"
        onClick={handleParse}
        disabled={!text.trim()}
      >
        Preview Parse
      </Button>

      {parsed && parsed.sections.length > 0 && (
        <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700"
              placeholder="Song Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700"
              placeholder="Author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>
          {parsed.copyright && (
            <div className="flex items-center gap-2 text-[9px]">
              <span className="text-slate-600 font-bold">©</span>
              <span className="text-slate-400">{parsed.copyright}</span>
              {parsed.ccli && <span className="text-slate-600 ml-auto">CCLI #{parsed.ccli}</span>}
            </div>
          )}
          <div>
            <p className="text-[9px] font-bold uppercase text-slate-600 mb-2">
              {parsed.sections.length} section{parsed.sections.length !== 1 ? "s" : ""} detected
              {hasChords && <span className="text-amber-500 ml-2">· Chords detected</span>}
              <span className="text-slate-600 ml-2">({parsed.format})</span>
            </p>
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto custom-scrollbar">
              {parsed.sections.map((sec, i) => (
                <div key={i} className="bg-slate-900 rounded-lg p-2">
                  <p className="text-[9px] font-black uppercase text-amber-500 mb-1">{sec.label || `Section ${i + 1}`}</p>
                  {sec.lines.slice(0, 4).map((line, j) => (
                    <p key={j} className="text-[10px] text-slate-400 font-mono leading-snug">
                      {hasChords ? <span className="text-purple-400/70">{line.replace(/\[(.*?)\]/g, (_, c) => `[${c}]`)}</span> : line}
                    </p>
                  ))}
                  {sec.lines.length > 4 && (
                    <p className="text-[8px] text-slate-700 mt-1">+ {sec.lines.length - 4} more lines</p>
                  )}
                </div>
              ))}
            </div>
          </div>
          <Button variant="primary" onClick={handleImport} loading={importing}>
            Import Song
          </Button>
        </div>
      )}
    </div>
  );
}