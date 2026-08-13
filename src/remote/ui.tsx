import React, { type ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Btn({
  children,
  onClick,
  variant = "default",
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: "default" | "primary" | "live" | "stage" | "danger" | "ghost";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variants: Record<string, string> = {
    default: "bg-slate-800 text-slate-200 border-slate-600 hover:bg-slate-700",
    primary: "bg-amber-500 text-black border-amber-400 hover:bg-amber-400 font-bold",
    live: "bg-red-600 text-white border-red-500 hover:bg-red-500",
    stage: "bg-cyan-950/70 text-cyan-300 border-cyan-700 hover:bg-cyan-900/60",
    danger: "bg-red-950/60 text-red-300 border-red-800/70 hover:bg-red-900/50",
    ghost: "bg-transparent text-slate-400 border-slate-700 hover:text-white hover:border-slate-500",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        "flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-all disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98]",
        variants[variant],
        className
      )}
    >
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("bg-slate-900/70 border border-slate-800 rounded-xl p-3", className)}>{children}</div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">{children}</p>;
}

export function Spinner() {
  return <Loader2 size={16} className="animate-spin text-slate-500" />;
}

export function Select({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        "bg-slate-800 border border-slate-600 text-slate-100 text-xs rounded-lg px-2.5 py-2 w-full focus:outline-2 focus:outline-cyan-400",
        className
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={cx(
        "bg-slate-800 border border-slate-600 text-slate-100 text-xs rounded-lg px-2.5 py-2 w-full placeholder:text-slate-500 focus:outline-2 focus:outline-cyan-400",
        className
      )}
    />
  );
}