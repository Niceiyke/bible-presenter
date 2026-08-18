import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  drawProgramFrame,
  CanvasResources,
} from "./canvasProgramFeed";
import { collectFrameMediaPaths } from "../../compositor/ProgramFrameResolver";
import type { ProgramFrame } from "../../compositor/ProgramFrame";
import { useCanvasCapture } from "../../hooks/useCanvasCapture";
import { resolvePath } from "../../utils";
import type { CanvasGeometry } from "./canvasProgramFeed";

/**
 * `ProgramFeedCanvas` — Phase 2 compositor component.
 *
 * Renders the authoritative program feed (live item + overlays, resolved
 * against settings) into a `<canvas>` at the given geometry and exposes the
 * composited `MediaStream` via the capture hook. Recorder and streamer
 * surfaces attach here; window outputs may switch to it later for a single
 * render path.
 *
 * The component owns the resource pipeline: it resolves media paths to
 * `convertFileSrc` URLs, keeps image/video elements loaded for the paths the
 * current frame references, and passes pre-warmed camera streams (native or
 * relayed phone feeds) through to the draw call.
 */
export interface ProgramFeedCanvasProps {
  geometry: CanvasGeometry;
  /** The resolved program frame to composite each tick. Callers produce it
   *  via `resolveProgramFrame` (or re-resolve store state); the compositor
   *  reads it through a ref so the rAF loop always paints the newest. */
  frame: ProgramFrame;
  /** Pre-warmed camera streams (native getUserMedia or relayed phone
   *  feeds), keyed by device id. Optional — the compositor also lazily
   *  opens native streams via `getUserMedia` when the frame references
   *  them. */
  cameraStreams?: Record<string, MediaStream>;
  /** Callback delivering the live composited stream once running. */
  onStream?: (stream: MediaStream | null) => void;
  /** Capture fps. Default 30. */
  fps?: number;
  /** CSS size of the rendered canvas element (defaults to geometry px). */
  className?: string;
  /** Whether the compositor should be running. When false the loop and the
   *  capture stream are stopped (tracks ended), which is useful for an
   *  always-mounted hidden canvas that must not waste CPU while idle.
   *  Defaults to true. */
  active?: boolean;
  /** Called with the set of media paths that failed to load for the current
   *  frame (rendered as safe missing panels). Empty array when all clear. */
  onMissingMedia?: (failedPaths: string[]) => void;
}

export function ProgramFeedCanvas({
  geometry,
  frame,
  cameraStreams,
  onStream,
  fps = 30,
  className,
  active = true,
  onMissingMedia,
}: ProgramFeedCanvasProps) {
  const { canvasRef, stream, running, start, stop, setDraw } = useCanvasCapture({ fps, autoStart: false });

  // Start/stop with the `active` flag. `start` is idempotent, so repeated
  // renders with `active` true are cheap; flipping to false stops the tracks.
  useEffect(() => {
    if (active) start();
    else stop();
  }, [active, start, stop]);

  // Restart the capture loop when the requested geometry or fps changes so the
  // stream reflects the new capture resolution/cadence (changing canvas
  // width/height resets the drawing buffer, and captureStream was created with
  // the old fps). Skipped on mount so the `active` effect owns first start.
  const prevCaptureRef = useRef<{ w: number; h: number; fps: number } | null>(null);
  useEffect(() => {
    const prev = prevCaptureRef.current;
    prevCaptureRef.current = { w: geometry.width, h: geometry.height, fps };
    if (!active) return;
    if (prev && (prev.w !== geometry.width || prev.h !== geometry.height || prev.fps !== fps)) {
      stop();
      start();
    }
  }, [geometry.width, geometry.height, fps, active, start, stop]);

  // External resources: images/videos keyed by resolved path; camera videos
  // keyed by device id (pre-warmed to a playing frame for drawImage).
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});
  const [videos, setVideos] = useState<Record<string, HTMLVideoElement>>({});
  const [cameraVideos, setCameraVideos] = useState<Record<string, HTMLVideoElement>>({});
  const [failedPaths, setFailedPaths] = useState<string[]>([]);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const appDataDir = frame.appDataDir ?? null;

  // Collect every media path the current frame draws, so we only load what's
  // needed and drop references that are gone. The walk is shared with the
  // resolver (`collectFrameMediaPaths`) so a loading gap can never diverge
  // from what the frame actually paints.
  const collectPaths = useCallback((): { images: string[]; videos: string[] } => {
    const { images, videos } = collectFrameMediaPaths(frameRef.current);
    return {
      images: images.map((p) => resolvePath(p, appDataDir)),
      videos: videos.map((p) => resolvePath(p, appDataDir)),
    };
  }, [appDataDir]);

  // Prune failed paths that are no longer referenced by the frame.
  useEffect(() => {
    const { images, videos } = collectPaths();
    setFailedPaths((prev) => prev.filter((p) => images.includes(p) || videos.includes(p)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(collectPaths())]);

  // Load images referenced by the frame.
  useEffect(() => {
    const { images: paths } = collectPaths();
    let cancelled = false;
    const next = { ...images };
    const load = (path: string) => {
      if (next[path]) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        setImages((prev) => ({ ...prev, [path]: img }));
      };
      img.onerror = () => {
        if (cancelled) return;
        setFailedPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      };
      img.src = convertFileSrc(path);
    };
    paths.forEach(load);
    // Drop images no longer referenced
    for (const key of Object.keys(next)) {
      if (!paths.includes(key)) delete next[key];
    }
    setImages(next);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(collectPaths().images)]);

  // Load videos referenced by the frame.
  useEffect(() => {
    const { videos: paths } = collectPaths();
    let cancelled = false;
    const next = { ...videos };
    const load = (path: string) => {
      if (next[path]) return;
      const vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.loop = true;
      vid.crossOrigin = "anonymous";
      vid.addEventListener("loadeddata", () => {
        if (cancelled) return;
        setVideos((prev) => ({ ...prev, [path]: vid }));
      });
      vid.addEventListener("error", () => {
        if (cancelled) return;
        setFailedPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      });
      vid.src = convertFileSrc(path);
      vid.play().catch(() => {});
    };
    paths.forEach(load);
    for (const key of Object.keys(next)) {
      if (!paths.includes(key)) {
        next[key].pause();
        delete next[key];
      }
    }
    setVideos(next);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(collectPaths().videos)]);

  // Pre-warm camera videos for every supplied stream (native or phone).
  useEffect(() => {
    if (!cameraStreams) return;
    const entries = Object.entries(cameraStreams);
    if (entries.length === 0) return;
    let cancelled = false;
    const next = { ...cameraVideos };
    for (const [deviceId, stream] of entries) {
      if (next[deviceId]) continue;
      const vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.addEventListener("loadeddata", () => {
        if (cancelled) return;
        setCameraVideos((prev) => ({ ...prev, [deviceId]: vid }));
      });
      vid.srcObject = stream;
      vid.play().catch(() => {});
      next[deviceId] = vid;
    }
    setCameraVideos(next);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStreams]);

  // Report runtime load failures (safe panels are painted for these).
  const missingKey = JSON.stringify(failedPaths);
  useEffect(() => {
    onMissingMedia?.(failedPaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, onMissingMedia]);

  // Deliver the stream to the caller whenever it (re)starts.
  useEffect(() => {
    onStream?.(stream);
  }, [stream, onStream]);

  // Register the draw callback once; it reads fresh state from refs.
  useEffect(() => {
    setDraw((ctx, width, height) => {
      const f = frameRef.current;
      const res: CanvasResources = {
        images,
        videos,
        cameraStreams,
        cameraVideos,
        appDataDir,
        failedPaths,
      };
      drawProgramFrame(ctx, { ...f, canvas: { width, height, fps: f.canvas.fps } }, res);
    });
  }, [setDraw, images, videos, cameraStreams, cameraVideos, appDataDir, failedPaths]);

  return (
    <canvas
      ref={canvasRef}
      width={geometry.width}
      height={geometry.height}
      className={className}
      style={className ? { display: running ? undefined : "none" } : { width: geometry.width, height: geometry.height, display: running ? undefined : "none" }}
    />
  );
}