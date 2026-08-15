import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Presentation, RefreshCw } from "lucide-react";
import { Btn, Card, Label, cx, Spinner } from "../ui";
import type { PanelProps } from "../panelTypes";
import type { RemoteStudioPresentation } from "../../types/remote";

export function StudioPanel({ client, pushToast }: PanelProps) {
  const { command, isHeldBySelf, snapshot } = client;
  const [presentations, setPresentations] = useState<RemoteStudioPresentation[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canPresent = snapshot?.permissions?.presentation ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await command<RemoteStudioPresentation[]>("studio.list")) ?? [];
      setPresentations(list);
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [command, pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const live = snapshot?.live_item;
  const staged = snapshot?.staged_item;
  const liveSlide = live?.type === "CustomSlide" ? live.data : null;
  const stagedSlide = staged?.type === "CustomSlide" ? staged.data : null;

  const guard = () => {
    if (isHeldBySelf) return true;
    pushToast("You need control to show slides — take control in the header");
    return false;
  };

  const stageSlide = (p: RemoteStudioPresentation, index: number) => {
    if (!guard()) return;
    command("studio.stage", { presentation_id: p.id, slide_index: index }).catch((e) =>
      pushToast(String((e as Error).message ?? e))
    );
  };

  const goLiveSlide = (p: RemoteStudioPresentation, index: number) => {
    if (!guard()) return;
    command("studio.go_live", { presentation_id: p.id, slide_index: index }).catch((e) =>
      pushToast(String((e as Error).message ?? e))
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex items-center gap-2">
        <Presentation size={15} className="text-slate-400 shrink-0" />
        <Label>Presentations</Label>
        <span className="flex-1" />
        <Btn variant="ghost" className="px-2 py-1 shrink-0" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={12} className={cx(loading && "animate-spin")} />
        </Btn>
      </Card>

      {!canPresent && (
        <Card className="text-center py-3">
          <p className="text-[10px] text-slate-500">
            Presentations are read-only — ask the operator to grant Presentation permission to this device.
          </p>
        </Card>
      )}

      {loading && presentations.length === 0 ? (
        <Card className="flex items-center justify-center py-6 gap-2 text-slate-500">
          <Spinner /> <span className="text-[11px]">Loading presentations…</span>
        </Card>
      ) : presentations.length === 0 ? (
        <Card className="text-center py-6">
          <p className="text-xs text-slate-400 font-semibold">No presentations yet</p>
          <p className="text-[10px] text-slate-500 mt-1">Create one in the operator's Studio tab.</p>
        </Card>
      ) : (
        presentations.map((p) => {
          const expanded = expandedId === p.id;
          return (
            <Card key={p.id} className="p-2">
              <button
                onClick={() => setExpandedId(expanded ? null : p.id)}
                className="w-full flex items-center gap-2 py-1"
              >
                {expanded ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <ChevronRight size={14} className="text-slate-500 shrink-0" />}
                <span className="flex-1 text-left text-sm font-semibold text-slate-200 truncate">{p.name}</span>
                <span className="text-[9px] text-slate-500 uppercase shrink-0">{p.slide_count} slides</span>
              </button>

              {expanded && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {p.slides.map((s) => {
                    const isLive = liveSlide?.presentation_id === p.id && liveSlide.slide_index === s.index;
                    const isStaged = !isLive && stagedSlide?.presentation_id === p.id && stagedSlide.slide_index === s.index;
                    return (
                      <div
                        key={s.index}
                        className={cx(
                          "flex items-center gap-2 rounded-lg border px-2.5 py-2",
                          isLive
                            ? "border-red-800 bg-red-950/40"
                            : isStaged
                              ? "border-cyan-800 bg-cyan-950/40"
                              : "border-slate-800 bg-slate-900/40"
                        )}
                      >
                        <span className="text-[10px] font-mono text-slate-500 w-6 shrink-0">{s.index + 1}</span>
                        <span className="flex-1 text-xs text-slate-200 truncate">{s.title}</span>
                        {isLive && <span className="text-[9px] font-black text-red-400 uppercase shrink-0">Live</span>}
                        {isStaged && <span className="text-[9px] font-black text-cyan-400 uppercase shrink-0">Staged</span>}
                        {canPresent && (
                          <div className="flex gap-1 shrink-0">
                            <Btn variant="stage" className="px-2 py-1" disabled={isLive} onClick={() => stageSlide(p, s.index)}>
                              Stage
                            </Btn>
                            <Btn variant="primary" className="px-2 py-1" disabled={isLive} onClick={() => goLiveSlide(p, s.index)}>
                              Go Live
                            </Btn>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}