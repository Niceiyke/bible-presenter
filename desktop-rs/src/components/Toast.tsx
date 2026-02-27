import React, { useEffect } from "react";
import { motion } from "framer-motion";

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <motion.div
      className="fixed bottom-6 left-1/2 z-50"
      style={{ translateX: "-50%" }}
      initial={{ opacity: 0, y: 8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.18 }}
    >
      <div className="bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-full shadow-xl border border-slate-600">
        {message}
      </div>
    </motion.div>
  );
}
