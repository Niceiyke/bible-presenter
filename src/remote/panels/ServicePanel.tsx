import React from "react";
import { ChevronLeft, ChevronRight, ListOrdered } from "lucide-react";
import { Btn, Card, Label, cx } from "../ui";
import { entryTitle, itemSubtitle } from "../itemLabel";
import type { PanelProps } from "../panelTypes";

export function ServicePanel({ client, pushToast }: PanelProps) {
  const { snapshot, command, isHeldBySelf } = client;
  const entries = snapshot?.schedule_entries ?? [];
  const activeService = snapshot?.active_service;

  const move = (dir: 1 | -1) => {
    if (!isHeldBySelf) {
      pushToast("You need control to drive the service queue");
      return;
    }
    const type = dir === 1 ? "display.stage_next" : "display.stage_previous";
    command(type).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <Label>Active service</Label>
            <p className="text-sm text-slate-100 font-semibold truncate">{activeService?.name ?? "No active service"}</p>
            <p className="text-[10px] text-slate-500">{entries.length} items</p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Btn variant="stage" onClick={() => move(-1)} title="Stage previous queue item">
              <ChevronLeft size={14} />
            </Btn>
            <Btn variant="stage" onClick={() => move(1)} title="Stage next queue item">
              <ChevronRight size={14} />
            </Btn>
          </div>
        </div>
      </Card>

      <Card>
        <Label>Service queue</Label>
        {entries.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            The queue is empty. Volunteers can add Scripture to the service from the Bible tab.
          </p>
        ) : (
          <div className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
            {entries.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-800/40 border border-slate-800">
                <span className={cx("text-[10px] font-black w-6 text-center shrink-0", i === 0 ? "text-cyan-400" : "text-slate-600")}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-slate-200 font-medium truncate">{entryTitle(entry)}</p>
                  {itemSubtitle(entry.item) && (
                    <p className="text-[10px] text-slate-500 truncate">{itemSubtitle(entry.item)}</p>
                  )}
                </div>
                <span className="text-[9px] uppercase font-bold text-slate-600 shrink-0">
                  {entry.item.type === "Verse" ? "Scripture" : entry.item.type}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <ListOrdered size={11} /> Stage the previous/next item to preview it, then press <span className="text-cyan-300 font-semibold">Go live</span> on the On&nbsp;Air tab.
        </p>
      </Card>
    </div>
  );
}