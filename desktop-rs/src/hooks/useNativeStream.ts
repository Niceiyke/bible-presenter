import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A hook that provides a URL for the native video stream.
 * It uses the custom 'wordlyte-stream://' protocol which is significantly
 * more efficient than IPC polling (invoke) for binary data.
 */
export function useNativeStream(active: boolean) {
  const [frameUrl, setFrameUrl] = useState<string>("");

  useEffect(() => {
    if (!active) {
      setFrameUrl("");
      return;
    }

    // Instead of polling bytes, we just provide a URL with a cache-busting timestamp.
    // The browser's <img> tag will handle the fetch through the custom protocol.
    const updateInterval = setInterval(() => {
      // We append a timestamp to force the browser to request a new frame
      // from the 'wordlyte-stream' protocol handler in main.rs
      setFrameUrl(`wordlyte-stream://mixer?t=${Date.now()}`);
    }, 40); // ~25fps is plenty for preview and saves CPU

    return () => clearInterval(updateInterval);
  }, [active]);

  return frameUrl;
}
