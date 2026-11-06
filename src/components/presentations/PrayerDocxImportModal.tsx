import React, { useState } from "react";
import { AlertTriangle, BookOpenCheck, FileText } from "lucide-react";
import { Button, Modal, StatusBadge } from "../ui";
import type { PrayerGuideImport } from "../../imports/prayerGuide";

interface PrayerDocxImportModalProps {
  imported: PrayerGuideImport | null;
  onClose: () => void;
  onCreate: () => Promise<void>;
}

export function PrayerDocxImportModal({ imported, onClose, onCreate }: PrayerDocxImportModalProps) {
  const [creating, setCreating] = useState(false);
  if (!imported) return null;
  const prayerCount = imported.days.reduce((total, day) => total + day.prayers.length, 0);

  const create = async () => {
    setCreating(true);
    try {
      await onCreate();
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import daily prayer decks"
      maxWidth="max-w-3xl"
      footer={<><Button variant="bare" onClick={onClose}>Cancel</Button><Button loading={creating} onClick={() => void create()} icon={<FileText size={14} />}>Create {imported.days.length} decks</Button></>}
    >
      <div className="p-4 flex flex-col gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-black text-console-text">{imported.sourceName}</h3>
            <StatusBadge tone="design" label={`${imported.days.length} daily decks`} />
            <StatusBadge tone="neutral" label={`${prayerCount} intercessions`} />
          </div>
          <p className="mt-1 text-[10px] text-console-text-subtle">Each deck will contain a title slide, then separate editable prayer and Scripture slides for every intercession.</p>
        </div>

        {imported.warnings.length > 0 && (
          <div className="rounded-lg border border-state-warning/40 bg-state-warning/10 p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-state-warning flex items-center gap-1.5"><AlertTriangle size={12} /> References requiring review</p>
            {imported.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-console-text-muted">• {warning}</p>)}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2">
          {imported.days.map((day) => {
            const verified = day.prayers.filter((prayer) => prayer.verses.length > 0).length;
            return (
              <article key={day.title} className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div><h4 className="text-xs font-bold text-console-text">{day.title}</h4><p className="text-[9px] text-console-text-subtle mt-0.5">{day.prayers.length} intercessions · {day.prayers.length * 2 + 1} slides</p></div>
                  <span className={`flex items-center gap-1 text-[10px] font-bold ${verified === day.prayers.length ? "text-state-success" : "text-state-warning"}`}><BookOpenCheck size={12} /> {verified}/{day.prayers.length} verified</span>
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1">
                  {day.prayers.map((prayer) => <div key={prayer.number} title={prayer.text} className={`rounded px-1.5 py-1 text-center text-[9px] font-bold ${prayer.verses.length > 0 ? "bg-state-success/10 text-state-success" : "bg-state-warning/10 text-state-warning"}`}>{prayer.number}</div>)}
                </div>
              </article>
            );
          })}
        </div>
        <p className="text-[10px] text-console-text-subtle">Verse text is loaded from the selected installed Bible, not copied from the Word document. Creating these decks does not Stage or Go Live.</p>
      </div>
    </Modal>
  );
}
