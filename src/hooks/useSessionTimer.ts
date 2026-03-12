import { useEffect, useState } from "react";
import { useAppStore } from "../store";

export function useSessionTimer() {
  const sessionState = useAppStore(s => s.sessionState);
  const [sessionSecs, setSessionSecs] = useState(0);
  useEffect(() => {
    if (sessionState !== "running") { setSessionSecs(0); return; }
    const t = setInterval(() => setSessionSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [sessionState]);
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  return { sessionSecs, fmtTime };
}
