import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A hook that pulls video frames from the Rust backend using standard Tauri IPC.
 * This is 100% compatible with Windows WebView2 security restrictions.
 */
export function useNativeStream(active: boolean) {
  const [frameUrl, setFrameUrl] = useState<string>("");
  const lastUrlRef = useRef<string>("");

  useEffect(() => {
    let isRunning = true;
    
    const updateLoop = async () => {
      if (!active || !isRunning) return;

      try {
        // Direct IPC call to get latest JPEG bytes
        const bytes = await invoke<number[]>("get_mixer_frame");
        
        if (bytes && bytes.length > 0) {
          // Log occasionally to confirm arrival
          if (Math.random() < 0.01) {
            console.log(`IPC Bridge: Received frame of ${bytes.length} bytes`);
          }

          const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          
          setFrameUrl(url);

          // Clean up the previous URL to prevent massive memory leaks
          if (lastUrlRef.current) {
            URL.revokeObjectURL(lastUrlRef.current);
          }
          lastUrlRef.current = url;
        }
      } catch (err) {
        console.error("Frame pull error:", err);
      }

      // Aim for ~30fps
      if (isRunning) {
        setTimeout(() => requestAnimationFrame(updateLoop), 33);
      }
    };

    if (active) {
      updateLoop();
    }

    return () => {
      isRunning = false;
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
        lastUrlRef.current = "";
      }
    };
  }, [active]);

  return frameUrl;
}
