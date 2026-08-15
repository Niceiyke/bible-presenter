import React, { useCallback, useEffect, useState } from "react";
import { ChevronRight, EyeOff, MessageSquare, Music2, Search, User } from "lucide-react";
import { Btn, Card, Label, TextInput, cx, Select, Spinner } from "../ui";
import type { PanelProps } from "../panelTypes";
import type {
  RemoteLtLine,
  RemoteLtScroll,
  RemoteLtTemplateSummary,
  RemoteLowerThirdPayload,
  RemoteSongSummary,
} from "../../types/remote";

function kindBadge(lower: unknown): string {
  const raw = lower as { data?: { kind?: string } } | null;
  return raw?.data?.kind ?? "";
}

type Mode = "Nameplate" | "FreeText" | "Lyrics";

const SCROLL_OPTIONS: { label: string; enabled: boolean; direction: "ltr" | "rtl" }[] = [
  { label: "Static", enabled: false, direction: "ltr" },
  { label: "→→", enabled: true, direction: "ltr" },
  { label: "←←", enabled: true, direction: "rtl" },
];

export function LowerThirdPanel({ client, pushToast }: PanelProps) {
  const { command, isHeldBySelf, snapshot } = client;
  const [mode, setMode] = useState<Mode>("Nameplate");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const [templates, setTemplates] = useState<RemoteLtTemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [scroll, setScroll] = useState<RemoteLtScroll>({ enabled: false, direction: "ltr", count: 0 });

  const [query, setQuery] = useState("");
  const [songResults, setSongResults] = useState<RemoteSongSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickedSong, setPickedSong] = useState<RemoteSongSummary | null>(null);
  const [lines, setLines] = useState<RemoteLtLine[]>([]);
  const [lineIndex, setLineIndex] = useState(0);
  const [linesPerDisplay, setLinesPerDisplay] = useState<1 | 2>(1);

  const active = kindBadge(snapshot?.lower_third);
  const canLower = snapshot?.permissions?.lower_third ?? false;

  // Load saved lower-third templates once so the phone can pick a style. The
  // on-air template wins as the default; otherwise the first saved template.
  useEffect(() => {
    command<RemoteLtTemplateSummary[]>("lower_third.templates")
      .then((list) => {
        setTemplates(list ?? []);
        if (list && list.length > 0) {
          const current = (snapshot?.lower_third as { template?: { id?: string } } | null)?.template?.id;
          setTemplateId(current && list.some((t) => t.id === current) ? current : list[0].id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = () => {
    if (isHeldBySelf) return true;
    pushToast("You need control to show a lower third — take control in the header");
    return false;
  };

  const buildPayload = useCallback((): RemoteLowerThirdPayload | null => {
    const base: RemoteLowerThirdPayload = { kind: mode, data: {} };
    if (templateId) base.template_id = templateId;
    if (mode === "Nameplate") {
      if (!name.trim()) return null;
      base.data = { name: name.trim(), title: title.trim() || undefined };
    } else if (mode === "FreeText") {
      if (!text.trim()) return null;
      base.data = { text: text.trim() };
      if (scroll.enabled) base.scroll = scroll;
    } else {
      if (!pickedSong || lines.length === 0) return null;
      const line1 = lines[lineIndex];
      if (!line1) return null;
      const line2 = linesPerDisplay === 2 ? lines[lineIndex + 1] : undefined;
      base.data = { line1: line1.text, line2: line2?.text, section_label: line1.section_label };
    }
    return base;
  }, [mode, templateId, name, title, text, scroll, pickedSong, lines, lineIndex, linesPerDisplay]);

  const send = (payload: RemoteLowerThirdPayload) => {
    command("lower_third.show", payload).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const show = () => {
    if (!guard()) return;
    const payload = buildPayload();
    if (!payload) {
      pushToast(mode === "Nameplate" ? "Enter a name" : mode === "FreeText" ? "Enter some text" : "Pick a song first");
      return;
    }
    send(payload);
  };

  const hide = () => {
    if (!guard()) return;
    command("lower_third.hide").catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const isActive = active === mode;

  const searchSongs = async (q = query) => {
    setSearching(true);
    try {
      const res = await command<RemoteSongSummary[]>("songs.search", { query: q ?? "", include_hymns: true });
      setSongResults(res ?? []);
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    } finally {
      setSearching(false);
    }
  };

  const pickSong = async (song: RemoteSongSummary) => {
    setPickedSong(song);
    setLineIndex(0);
    setLines([]);
    try {
      const res = await command<RemoteLtLine[]>("song.lines", { song_id: song.id });
      setLines(res ?? []);
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    }
  };

  // Lyrics navigation re-sends the overlay while a lyrics lower third is on air
  // (matching the operator's live-update behavior).
  const navigate = (dir: 1 | -1) => {
    if (lines.length === 0) return;
    const max = lines.length - 1;
    const next = Math.max(0, Math.min(lineIndex + dir * linesPerDisplay, max));
    setLineIndex(next);
    if (active === "Lyrics") {
      const payload = buildPayloadForIndex(next);
      if (payload) send(payload);
    }
  };

  const buildPayloadForIndex = (idx: number): RemoteLowerThirdPayload | null => {
    if (!pickedSong || lines.length === 0) return null;
    const line1 = lines[idx];
    if (!line1) return null;
    const line2 = linesPerDisplay === 2 ? lines[idx + 1] : undefined;
    const base: RemoteLowerThirdPayload = {
      kind: "Lyrics",
      data: { line1: line1.text, line2: line2?.text, section_label: line1.section_label },
    };
    if (templateId) base.template_id = templateId;
    return base;
  };

  const current = lines[lineIndex];
  const upNext = lines[lineIndex + linesPerDisplay];

  return (
    <div className="flex flex-col gap-3">
      {canLower ? (
        <Card>
          {/* Mode tabs */}
          <div className="flex gap-1.5 mb-3">
            {(["Nameplate", "FreeText", "Lyrics"] as const).map((m) => (
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
                {m === "Nameplate" ? <User size={12} /> : m === "FreeText" ? <MessageSquare size={12} /> : <Music2 size={12} />}
                {m === "FreeText" ? "Free Text" : m}
              </button>
            ))}
          </div>

          {/* Template picker */}
          {templates.length > 0 && (
            <div className="mb-3">
              <Label>Template</Label>
              <Select
                value={templateId}
                options={templates.map((t) => ({ value: t.id, label: t.name }))}
                onChange={setTemplateId}
              />
            </div>
          )}

          {mode === "Nameplate" ? (
            <div className="flex flex-col gap-2">
              <TextInput value={name} onChange={setName} placeholder="Name / headline" />
              <TextInput value={title} onChange={setTitle} placeholder="Title / subline (optional)" />
            </div>
          ) : mode === "FreeText" ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Free text (e.g. announcements)"
                className="bg-slate-800 border border-slate-600 text-slate-100 text-xs rounded-lg px-2.5 py-2 w-full placeholder:text-slate-500 focus:outline-2 focus:outline-cyan-400 resize-none h-20"
              />
              <div className="flex gap-1.5 items-center flex-wrap">
                <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Scroll:</span>
                {SCROLL_OPTIONS.map((opt) => {
                  const activeOpt =
                    scroll.enabled === opt.enabled && (opt.enabled ? scroll.direction === opt.direction : true);
                  return (
                    <button
                      key={opt.label}
                      onClick={() => setScroll((s) => ({ ...s, enabled: opt.enabled, direction: opt.direction }))}
                      className={cx(
                        "px-2 py-1 text-[10px] font-bold rounded transition-all",
                        activeOpt ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {scroll.enabled && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">Repeats:</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={scroll.count}
                    onChange={(e) => setScroll((s) => ({ ...s, count: Math.max(0, Number(e.target.value) || 0) }))}
                    className="w-14 bg-slate-800 border border-slate-600 text-slate-100 text-xs rounded-lg px-2 py-1 text-center focus:outline-2 focus:outline-cyan-400"
                  />
                  <span className="text-[9px] text-slate-500">(0 = infinite)</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {/* Song picker */}
              <div className="flex gap-2">
                <TextInput value={query} onChange={setQuery} placeholder="Find a song…" onKeyDown={(e) => e.key === "Enter" && searchSongs()} />
                <Btn variant="primary" onClick={() => searchSongs()} disabled={searching} className="shrink-0 px-3">
                  {searching ? <Spinner /> : <Search size={13} />}
                </Btn>
              </div>

              {!pickedSong ? (
                <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
                  {songResults.map((song) => (
                    <button
                      key={song.id}
                      onClick={() => pickSong(song)}
                      className="flex items-center gap-2 px-2 py-1.5 text-left rounded-lg bg-slate-800/60 border border-slate-700 hover:bg-slate-700/70 transition-colors"
                    >
                      <ChevronRight size={12} className="shrink-0 text-slate-500" />
                      <div className="min-w-0">
                        <p className="text-[11px] text-slate-100 font-semibold truncate">{song.title}</p>
                        <p className="text-[9px] text-slate-500 truncate">{song.section_labels.join(" · ")}</p>
                      </div>
                    </button>
                  ))}
                  {songResults.length === 0 && !searching && (
                    <p className="text-[10px] text-slate-500 py-1">Search to pick a song.</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPickedSong(null)} className="text-[10px] text-cyan-300 hover:text-cyan-200 font-semibold shrink-0">
                      ← Change
                    </button>
                    <p className="text-[12px] text-slate-100 font-semibold truncate">{pickedSong.title}</p>
                    <span className="flex-1" />
                    <span className="text-[9px] text-slate-500 tabular-nums">{lines.length > 0 ? `${lineIndex + 1} / ${lines.length}` : "…"}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 uppercase font-bold">Lines:</span>
                    {([1, 2] as const).map((n) => (
                      <button
                        key={n}
                        onClick={() => setLinesPerDisplay(n)}
                        className={cx(
                          "text-[10px] font-bold w-6 h-6 rounded",
                          linesPerDisplay === n ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-400"
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>

                  <div className="bg-slate-800 rounded-lg px-3 py-2">
                    {current ? (
                      <>
                        {current.section_label && (
                          <p className="text-[9px] text-amber-500 font-bold uppercase mb-0.5">{current.section_label}</p>
                        )}
                        <p className="text-[13px] text-slate-100 font-semibold leading-snug">{current.text}</p>
                        {linesPerDisplay === 2 && upNext && (
                          <p className="text-[12px] text-slate-300 mt-0.5">{upNext.text}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-[11px] text-slate-500">No lyrics found for this song.</p>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Btn variant="default" onClick={() => navigate(-1)} disabled={lineIndex === 0} className="flex-1">
                      ◀ Prev
                    </Btn>
                    <Btn variant="default" onClick={() => navigate(1)} disabled={!upNext && !current} className="flex-1">
                      Next ▶
                    </Btn>
                  </div>
                </div>
              )}
            </div>
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
