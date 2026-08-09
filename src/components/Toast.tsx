import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Info, AlertTriangle } from "lucide-react";

function toastKind(message: string): { icon: React.ReactNode; ring: string; dot: string } {
  if (/failed|error|issue|missing/i.test(message)) {
    return {
      icon: <AlertTriangle size={13} className="text-amber-400" />,
      ring: "border-rose-500/30",
      dot: "bg-rose-400",
    };
  }
  if (/success|saved|restored|active/i.test(message)) {
    return {
      icon: <CheckCircle2 size={13} className="text-emerald-400" />,
      ring: "border-emerald-500/30",
      dot: "bg-emerald-400",
    };
  }
  return {
    icon: <Info size={13} className="text-indigo-400" />,
    ring: "border-white/10",
    dot: "bg-indigo-400",
  };
}

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, []); // Run once on mount

  const kind = toastKind(message);

  return (
    <motion.div
      className="fixed bottom-6 left-1/2 z-50"
      style={{ translateX: "-50%" }}
      initial={{ opacity: 0, y: 10, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.94 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={`flex items-center gap-2 bg-black/70 backdrop-blur-md text-white text-xs font-semibold px-3.5 py-2 rounded-full shadow-2xl border ${kind.ring}`}>
        <span className="relative flex shrink-0">
          {kind.icon}
          <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${kind.dot} dot-flash`} />
        </span>
        {message}
      </div>
    </motion.div>
  );
}