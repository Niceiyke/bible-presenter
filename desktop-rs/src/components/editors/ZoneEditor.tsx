import React from "react";
import type { TextZone } from "../../types";
import { FONTS } from "../../types";

interface ZoneEditorProps {
  label: string;
  zone: TextZone;
  onChange: (z: TextZone) => void;
}

export function ZoneEditor({ label, zone, onChange }: ZoneEditorProps) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <textarea
        value={zone.text}
        onChange={(e) => onChange({ ...zone, text: e.target.value })}
        rows={2}
        className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-sm text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500"
        placeholder={`Type ${label.toLowerCase()} here...`}
      />
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={zone.fontFamily}
          onChange={(e) => onChange({ ...zone, fontFamily: e.target.value })}
          className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-300 focus:outline-none"
        >
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-600 font-bold uppercase">Size</span>
          <input
            type="number" min={12} max={200}
            value={zone.fontSize}
            onChange={(e) => onChange({ ...zone, fontSize: parseInt(e.target.value) || 24 })}
            className="w-14 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-300 focus:outline-none"
          />
        </div>
        <input
          type="color"
          value={zone.color}
          onChange={(e) => onChange({ ...zone, color: e.target.value })}
          className="w-7 h-7 rounded cursor-pointer border border-slate-700 bg-transparent"
          title="Text color"
        />
        <div className="flex gap-1 bg-slate-800 p-0.5 rounded border border-slate-700">
          {(["left", "center", "right"] as const).map((a) => (
            <button
              key={a}
              onClick={() => onChange({ ...zone, align: a })}
              className={`px-2 py-0.5 text-[9px] font-bold rounded transition-all ${zone.align === a ? "bg-slate-600 text-white" : "text-slate-500 hover:text-slate-300"}`}
            >
              {a[0].toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onChange({ ...zone, bold: !zone.bold })}
            className={`w-7 h-7 rounded border transition-all text-xs font-bold ${zone.bold ? "bg-amber-500/20 border-amber-500 text-amber-400" : "bg-slate-800 border-slate-700 text-slate-500"}`}
          >B</button>
          <button
            onClick={() => onChange({ ...zone, italic: !zone.italic })}
            className={`w-7 h-7 rounded border transition-all text-xs italic font-serif ${zone.italic ? "bg-amber-500/20 border-amber-500 text-amber-400" : "bg-slate-800 border-slate-700 text-slate-500"}`}
          >I</button>
        </div>
      </div>
    </div>
  );
}
