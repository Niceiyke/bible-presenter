/**
 * Shared micro-UI primitives used by the split SlideEditor components
 * (P1.4). Previously defined as module-local helpers at the bottom of
 * `SlideEditor.tsx`; extracted so each sub-component can import them
 * without circular imports.
 */

import React from "react";

export function Btn({ onClick, icon, children, className = "" }: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 bg-white/8 hover:bg-white/14 text-slate-300 hover:text-white text-[11px] font-semibold rounded-lg transition-all shrink-0 ${className}`}
    >
      {icon}{children}
    </button>
  );
}

export function ToggleBtn({ active, onClick, title, children }: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shrink-0 ${active ? "bg-indigo-500 text-white" : "bg-white/8 text-slate-400 hover:text-white hover:bg-white/14"}`}
    >
      {children}
    </button>
  );
}

export function Div() {
  return <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />;
}

export function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/4 rounded-xl border border-white/8 p-3 flex flex-col gap-2.5">
      <p className="text-[8px] font-black uppercase tracking-widest text-slate-600">{label}</p>
      {children}
    </div>
  );
}

export function IconBtn({ onClick, title, children }: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-2 bg-white/6 hover:bg-white/12 text-slate-400 hover:text-white rounded-lg flex items-center justify-center transition-all"
    >
      {children}
    </button>
  );
}

export function TextBtn({ onClick, title, children }: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-2 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-white rounded-lg flex items-center justify-center transition-all text-[9px] font-bold"
    >
      {children}
    </button>
  );
}