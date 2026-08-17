import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  drawProgramFrame,
  getEffectiveBg,
  ProgramFeedFrame,
  CanvasResources,
} from "./canvasProgramFeed";
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
  /** The program frame to composite each tick. Callers re-render this
   *  object with fresh state (e.g. from `useAppStore`); the compositor
   *  reads it through a ref so the rAF loop always paints the newest. */
  frame: ProgramFeedFrame;
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
}

export function ProgramFeedCanvas({
  geometry,
  frame,
  cameraStreams,
  onStream,
  fps = 30,
  className,
  active = true,
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
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const appDataDir = frame.res.appDataDir ?? null;

  // Collect every media path the current frame draws, so we only load what's
  // needed and drop references that are gone.
  const collectPaths = useCallback((): { images: string[]; videos: string[] } => {
    const imgs = new Set<string>();
    const vids = new Set<string>();
    const f = frameRef.current;
    const addResolved = (path?: string, isVideo = false) => {
      if (!path) return;
      const resolved = resolvePath(path, appDataDir);
      if (isVideo) vids.add(resolved);
      else imgs.add(resolved);
    };

    // Backgrounds — the effective one depends on the live item type, so
    // resolve it the same way the draw pass does.
    const bg = getEffectiveBg(f.settings, f.item);
    if (bg.type === "Image") addResolved(bg.value.path);
    else if (bg.type === "Video") addResolved(bg.value.path, true);

    const item = f.item;
    if (item) {
      switch (item.type) {
        case "Media":
          if (item.data.media_type === "Image") addResolved(item.data.path);
          else if (item.data.media_type === "Video") addResolved(item.data.path, true);
          break;
        case "CustomSlide": {
          const sb = item.data.background;
          if (sb.type === "image") addResolved(sb.value);
          else if (sb.type === "video") addResolved(sb.value, true);
          for (const el of item.data.elements ?? []) {
            if (el.kind === "image") addResolved(el.content);
            else if (el.kind === "video") addResolved(el.content, true);
          }
          break;
        }
        case "SceneComposition": {
          for (const zone of item.data.zones) {
            // The zone's effective background (bible/song/media override) is
            // drawn behind the zone content, so load it like the draw pass.
            const zbg = getEffectiveBg(f.settings, zone.item);
            if (zbg.type === "Image") addResolved(zbg.value.path);
            else if (zbg.type === "Video") addResolved(zbg.value.path, true);
            if (zone.item.type === "Media") {
              if (zone.item.data.media_type === "Image") addResolved(zone.item.data.path);
              else if (zone.item.data.media_type === "Video") addResolved(zone.item.data.path, true);
            } else if (zone.item.type === "CustomSlide") {
              const sb = zone.item.data.background;
              if (sb.type === "image") addResolved(sb.value);
              else if (sb.type === "video") addResolved(sb.value, true);
              for (const el of zone.item.data.elements ?? []) {
                if (el.kind === "image") addResolved(el.content);
                else if (el.kind === "video") addResolved(el.content, true);
              }
            }
          }
          break;
        }
      }
    }

    // Props
    for (const p of f.propItems ?? []) {
      if (p.visible && p.kind === "image" && p.path) addResolved(p.path);
    }
    // Logo
    if (f.settings.logo_path) addResolved(f.settings.logo_path);

    return { images: [...imgs], videos: [...vids] };
  }, [appDataDir]);

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
      };
      const g: CanvasGeometry = { width, height };
      drawProgramFrame(ctx, g, { ...f, res, now: Date.now() });
    });
  }, [setDraw, images, videos, cameraStreams, cameraVideos, appDataDir]);

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