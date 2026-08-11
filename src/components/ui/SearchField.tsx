import React from "react";
import { Search } from "lucide-react";
import { cn } from "./cn";

interface SearchFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  placeholder?: string;
  className?: string;
}

/** Operator search field: always shows its icon and keeps keyboard focus visible. */
export function SearchField({ className, ...rest }: SearchFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-console-text-subtle" />
      <input
        type="text"
        className="w-full h-9 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs pl-8 pr-2.5 placeholder:text-console-text-subtle focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] transition-colors"
        {...rest}
      />
    </div>
  );
}