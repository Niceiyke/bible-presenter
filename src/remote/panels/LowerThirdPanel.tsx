import React, { useState } from "react";
import { EyeOff, MessageSquare, User } from "lucide-react";
import { Btn, Card, Label, TextInput, cx } from "../ui";
import type { PanelProps } from "../panelTypes";

function kindBadge(lower: unknown): string {
  const raw = lower as { kind?: string } | null;
  return raw?.kind ?? "";
}

export function LowerThirdPanel({ client, pushToast }: PanelProps) {
  const { command, isHeldBySelf, snapshot } = client;
  const [mode, setMode] = useState<"Nameplate" | "FreeText">("Nameplate");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const active = kindBadge(snapshot?.lower_third);
  const canLower = snapshot?.permissions?.lower_third ?? false;

  const guard = () => {
    if (isHeldBySelf) return true;
    pushToast("You need control to show a lower third — take control in the header");
    return false;
  };

  const show = () => {
    if (!guard()) return;
    if (mode === "Nameplate") {
      if (!name.trim()) {
        pushToast("Enter a name");
        return;
      }
      command("lower_third.show", {
        kind: "Nameplate",
        data: { name: name.trim(), title: title.trim() || undefined },
      }).catch((e) => pushToast(String((e as Error).message ?? e)));
    } else {
      if (!text.trim()) {
        pushToast("Enter some text");
        return;
      }
      command("lower_third.show", { kind: "FreeText", data: { text: text.trim() } }).catch((e) =>
        pushToast(String((e as Error).message ?? e))
      );
    }
  };

  const hide = () => {
    if (!guard()) return;
    command("lower_third.hide").catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const isActive = active === "Nameplate" || active === "FreeText";

  return (
    <div className="flex flex-col gap-3">
      {canLower ? (
      <Card>
        <div className="flex gap-1.5 mb-3">
          {(["Nameplate", "FreeText"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors",
                mode === m
                  ? "bg-cyan-500/20 border-cyan-500 text-cyan-200"
                  : "bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white"
              )}
            >
              {m === "Nameplate" ? <User size={12} /> : <MessageSquare size={12} />}
              {m}
            </button>
          ))}
        </div>

        {mode === "Nameplate" ? (
          <div className="flex flex-col gap-2">
            <TextInput value={name} onChange={setName} placeholder="Name / headline" />
            <TextInput value={title} onChange={setTitle} placeholder="Title / subline (optional)" />
          </div>
        ) : (
          <TextInput value={text} onChange={setText} placeholder="Free text (e.g. announcements)" />
        )}

        <div className="mt-3 flex gap-2">
          <Btn variant="primary" onClick={show} className="flex-1">
            Show lower third
          </Btn>
          <Btn variant="ghost" onClick={hide} disabled={!isActive} title="Hide any lower third">
            <EyeOff size={13} /> Hide
          </Btn>
        </div>

        <p className={cx("mt-2 text-[10px]", isActive ? "text-cyan-300" : "text-slate-600")}>
          {isActive ? `Lower third on air (${active}) — Hide to remove it.` : "Nothing shown on the lower third right now."}
        </p>
      </Card>
      ) : (
        <Card>
          <p className="text-[11px] text-slate-500">
            You can watch, but you don't have lower-third control. Ask the operator to grant it in Settings → Remote Control.
          </p>
        </Card>
      )}

      <Card>
        <Label>Preview (last shown)</Label>
        <p className="text-[11px] text-slate-400 break-words">
          {snapshot?.lower_third ? JSON.stringify((snapshot.lower_third as { data?: unknown }).data ?? snapshot.lower_third).slice(0, 160) : "—"}
        </p>
      </Card>
    </div>
  );
}