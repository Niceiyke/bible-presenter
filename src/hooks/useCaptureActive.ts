import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface StatusResponse {
  active: boolean;
}

/// Tracks whether a recording or streaming session is capturing the `capture`
/// window (the WGC source). There are no start/stop Tauri events for those
/// sessions, so the off-screen `capture` window polls the status commands. The
/// value drives camera decode gating: the capture window only opens cameras /
/// answers phone peers while something is actually capturing it.
export function useCaptureActive(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const [recording, streaming] = await Promise.all([
          invoke<StatusResponse>("recording_status"),
          invoke<StatusResponse>("stream_rtmp_status"),
        ]);
        if (!cancelled) setActive(Boolean(recording?.active || streaming?.active));
      } catch {
        // Backend unavailable or window lacks the command — keep current value.
      }
    };

    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return active;
}