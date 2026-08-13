import React from "react";
import { EyeOff, Moon, Play, Radio, Send, XCircle } from "lucide-react";
import { Btn, Card, Label, cx } from "../ui";
import { itemSubtitle, itemTitle } from "../itemLabel";
import type { PanelProps } from "../panelTypes";

function ItemCard({ item, tone }: { item: NonNullable<PanelProps["client"]["snapshot"]>["live_item"]; tone: "live" | "staged" }) {
  if (!item) {
    return (
      <div className={cx("flex items-center gap-2 rounded-lg px-3 py-2.5 border border-dashed", tone === "live" ? "border-red-800/60" : "border-cyan-900/60")}>
        <p className="text-[11px] text-slate-500">{tone === "live" ? "Nothing on air" : "Nothing staged"}</p>
      </div>
    );
  }
  return (
    <div className={cx("rounded-lg px-3 py-2.5 border", tone === "live" ? "bg-red-950/30 border-red-800/70" : "bg-cyan-950/30 border-cyan-800/60")}>
      <div className="flex items-center justify-between gap-2">
        <p className={cx("text-[13px] font-bold", tone === "live" ? "text-red-200" : "text-cyan-200")}>
          {itemTitle(item)}
        </p>
        <span className={cx("text-[9px] uppercase font-black tracking-widest shrink-0", tone === "live" ? "text-red-400" : "text-cyan-400")}>
          {tone}
        </span>
      </div>
      {itemSubtitle(item) && (
        <p className="text-[12px] text-slate-300 mt-1 leading-relaxed line-clamp-3">{itemSubtitle(item)}</p>
      )}
    </div>
  );
}

export function OnAirPanel({ client, pushToast }: PanelProps) {
  const { snapshot, command, isHeldBySelf } = client;
  const live = snapshot?.live_item ?? null;
  const staged = snapshot?.staged_item ?? null;
  const blackout = snapshot?.blackout ?? false;

  const act = (type: Parameters<typeof command>[0], payload?: unknown, msg?: string) => {
    if (!isHeldBySelf) {
      pushToast("You need control for this action — take control in the header");
      return;
    }
    command(type, payload).catch((e) => pushToast(msg ?? String((e as Error).message ?? e)));
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Label>Live</Label>
        <ItemCard item={live} tone="live" />
      </Card>

      <Card>
        <Label>Staged</Label>
        <ItemCard item={staged} tone="staged" />
      </Card>

      <Card>
        <Label>Controls</Label>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="live" onClick={() => act("display.go_live")} disabled={!staged} className="col-span-2">
            <Radio size={14} /> Go live
          </Btn>
          <Btn variant="stage" onClick={() => act("display.stage_previous")} title="Stage previous service item">
            ◀ Prev
          </Btn>
          <Btn variant="stage" onClick={() => act("display.stage_next")} title="Stage next service item">
            Next ▶
          </Btn>
          <Btn variant="ghost" onClick={() => act("display.clear_live")} disabled={!live}>
            <XCircle size={13} /> Clear live
          </Btn>
          <Btn variant="ghost" onClick={() => act("display.clear_all")}>
            <EyeOff size={13} /> Clear all
          </Btn>
          <Btn
            variant={blackout ? "primary" : "ghost"}
            onClick={() => act("display.blackout", { on: !blackout })}
            className="col-span-2"
          >
            <Moon size={13} /> {blackout ? "Blackout ON — tap to restore" : "Blackout output"}
          </Btn>
        </div>
        <p className="mt-2 text-[10px] text-slate-600">
          <Send size={10} className="inline mr-1" />
          Volunteers stage songs and verses from the other tabs; this is where they go on air.
        </p>
      </Card>
    </div>
  );
}