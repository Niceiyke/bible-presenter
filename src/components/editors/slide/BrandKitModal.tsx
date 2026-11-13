import React, { useEffect, useState } from "react";
import { Palette, Sparkles, X } from "lucide-react";
import { Button } from "../../ui";
import { useFonts } from "../../../hooks/useFonts";
import { loadBrandKit, saveBrandKit, type PresentationBrandKit } from "../../../presentations/editorFeatures";

export function BrandKitModal({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (kit: PresentationBrandKit) => void }) {
  const [kit, setKit] = useState<PresentationBrandKit>(loadBrandKit);
  const { availableFonts } = useFonts();
  useEffect(() => { if (open) setKit(loadBrandKit()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  if (!open) return null;

  const apply = () => {
    saveBrandKit(kit);
    onApply(kit);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Brand kit">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-console-border-strong bg-console-surface shadow-2xl shadow-black/60">
        <header className="flex items-center gap-3 border-b border-console-border bg-gradient-to-r from-tool-design/15 to-state-stage/5 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-tool-design text-console-canvas shadow-lg shadow-tool-design/25"><Palette size={18} /></span>
          <div className="flex-1">
            <h2 className="text-sm font-black text-console-text">Presentation Brand Kit</h2>
            <p className="mt-0.5 text-[10px] text-console-text-subtle">Apply consistent typography and colors across the entire deck.</p>
          </div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-console-text-muted hover:bg-console-surface-strong hover:text-console-text" aria-label="Close brand kit"><X size={16} /></button>
        </header>

        <div className="grid gap-4 p-5 sm:grid-cols-[1fr_190px]">
          <div className="space-y-3">
            <BrandField label="Kit name"><input value={kit.name} onChange={(event) => setKit({ ...kit, name: event.target.value })} className="brand-input" /></BrandField>
            <BrandField label="Brand font">
              <select value={kit.fontFamily} onChange={(event) => setKit({ ...kit, fontFamily: event.target.value })} className="brand-input">
                {availableFonts.map((font) => <option key={font} value={font}>{font}</option>)}
              </select>
            </BrandField>
            <div className="grid grid-cols-3 gap-2">
              <BrandColor label="Text" value={kit.textColor} onChange={(textColor) => setKit({ ...kit, textColor })} />
              <BrandColor label="Accent" value={kit.accentColor} onChange={(accentColor) => setKit({ ...kit, accentColor })} />
              <BrandColor label="Background" value={kit.backgroundColor} onChange={(backgroundColor) => setKit({ ...kit, backgroundColor })} />
            </div>
          </div>

          <div className="aspect-[9/12] overflow-hidden rounded-xl border border-console-border shadow-xl" style={{ background: `linear-gradient(145deg, ${kit.backgroundColor}, ${kit.accentColor}33)` }}>
            <div className="flex h-full flex-col justify-between p-4" style={{ fontFamily: kit.fontFamily, color: kit.textColor }}>
              <span className="h-1.5 w-10 rounded-full" style={{ backgroundColor: kit.accentColor }} />
              <div>
                <p className="text-xl font-black leading-tight">Your message.<br />Your identity.</p>
                <p className="mt-2 text-[9px] opacity-65">Live brand preview</p>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-console-border bg-console-canvas/35 px-5 py-4">
          <p className="max-w-xs text-[9px] leading-relaxed text-console-text-subtle">Color and gradient slide backgrounds are updated. Image and video backgrounds are preserved.</p>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={apply}><Sparkles size={13} /> Apply to deck</Button></div>
        </footer>
      </div>
    </div>
  );
}

function BrandField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[9px] font-black uppercase tracking-wider text-console-text-subtle">{label}</span>{children}</label>;
}

function BrandColor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="cursor-pointer rounded-xl border border-console-border bg-console-surface-raised p-2 transition-colors hover:border-tool-design/50">
      <span className="relative block h-10 overflow-hidden rounded-lg border border-white/10 shadow-inner" style={{ backgroundColor: value }}>
        <input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`${label} color`} />
      </span>
      <span className="mt-1.5 block text-[8px] font-black uppercase text-console-text-subtle">{label}</span>
      <span className="block truncate text-[8px] font-bold uppercase text-console-text">{value}</span>
    </label>
  );
}
