import React from "react";
import type { TallyState } from "../types";

interface Props { tally: TallyState; size?: "sm" | "md" | "lg" }

const SIZE = { sm: "w-2 h-2", md: "w-3 h-3", lg: "w-4 h-4" };
const COLOR = {
  program: "bg-red-500 shadow-red-500/70",
  preview: "bg-green-500 shadow-green-500/70",
  off:     "bg-zinc-600",
};

export function TallyIndicator({ tally, size = "md" }: Props) {
  const pulse = tally !== "off";
  return (
    <span
      className={[
        "rounded-full inline-block",
        SIZE[size],
        COLOR[tally],
        pulse ? "animate-pulse shadow-md" : "",
      ].join(" ")}
      title={tally.toUpperCase()}
    />
  );
}
