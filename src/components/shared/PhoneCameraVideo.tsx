import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PhoneCameraOrientation, CameraLook, CameraChromaConfig } from "../../types/remote";

const STORAGE_KEY = "cameraOrientations";
const REPORTED_STORAGE_KEY = "reportedCameraOrientations";

function readMapValue(key: string, deviceId: string | null | undefined, allowed: readonly PhoneCameraOrientation[]): PhoneCameraOrientation | null {
  if (!deviceId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    const v = map?.[deviceId];
    return allowed.includes(v as PhoneCameraOrientation) ? (v as PhoneCameraOrientation) : null;
  } catch {
    return null;
  }
}

function readStoredOrientation(deviceId: string | null | undefined): PhoneCameraOrientation | null {
  return readMapValue(STORAGE_KEY, deviceId, ["portrait", "landscape"]);
}

/** Physical orientation reported by the phone in its `camera.start` payload
 *  ("portrait" | "landscape"). The main window persists it here so auxiliary
 *  windows (output, stage) can fall back to it without mounting the store. */
function readReportedOrientation(deviceId: string | null | undefined): PhoneCameraOrientation | null {
  return readMapValue(REPORTED_STORAGE_KEY, deviceId, ["portrait", "landscape"]);
}

/** Stored operator override first, then the phone-reported orientation. Returns
 *  `null` when neither is known so caller-provided feeds that are NOT phone
 *  cameras (local webcams, Media cameras) are never auto-rotated. */
function readEffectiveOrientation(deviceId: string | null | undefined): PhoneCameraOrientation | null {
  return readStoredOrientation(deviceId) ?? readReportedOrientation(deviceId);
}

/**
 * Reads the effective per-phone-camera orientation (operator override, else
 * the phone-reported physical orientation). The operator windows (main,
 * output, stage) share the same WebView2 origin and localStorage, and the
 * main window writes this map on every change, so listening to the `storage`
 * event keeps auxiliary windows (which do not mount the operator store) in
 * sync. The `phone-cameras-changed` Tauri event is also consumed directly so
 * the feed re-orients the instant the phone reports a rotation — `storage`
 * events never fire in the window that performed the write, which would
 * otherwise leave the main window's own preview stale until some other
 * re-render.
 */
export function usePhoneCameraOrientation(deviceId: string | null | undefined): PhoneCameraOrientation | null {
  const [orientation, setOrientation] = useState<PhoneCameraOrientation | null>(() => readEffectiveOrientation(deviceId));
  useEffect(() => {
    const refresh = () => setOrientation(readEffectiveOrientation(deviceId));
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === STORAGE_KEY || e.key === REPORTED_STORAGE_KEY) {
        refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    if (deviceId) {
      listen("phone-cameras-changed", (e) => {
        if (cancelled) return;
        const cameras = (e.payload as { cameras?: { device_id?: string; orientation?: PhoneCameraOrientation }[] })?.cameras ?? [];
        const cam = cameras.find((c) => c.device_id === deviceId);
        if (cam?.orientation) {
          // Persist the freshly reported orientation so the localStorage
          // fallback (used by windows/views without a live Tauri listener)
          // is never stale, then re-read the effective value.
          try {
            const map = JSON.parse(localStorage.getItem(REPORTED_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
            if (map[deviceId] !== cam.orientation) {
              map[deviceId] = cam.orientation;
              localStorage.setItem(REPORTED_STORAGE_KEY, JSON.stringify(map));
            }
          } catch {
            /* localStorage unavailable — in-memory state still updates */
          }
          refresh();
        }
      }).then((f) => {
        unlisten = f;
        if (cancelled) { f(); unlisten = undefined; }
      });
    }
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("storage", onStorage);
    };
  }, [deviceId]);
  return orientation;
}

const LOOK_STORAGE_KEY = "cameraLook";

function readStoredLook(deviceId: string | null | undefined): CameraLook | null {
  if (!deviceId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}") as Record<string, CameraLook>;
    return map?.[deviceId] ?? null;
  } catch {
    return null;
  }
}

/** Same localStorage + storage-event sync as `usePhoneCameraOrientation`, but
 *  for the per-feed color/crop tuning map. Used by windows that do not mount
 *  the operator store (output, stage). */
export function usePhoneCameraLook(deviceId: string | null | undefined): CameraLook | null {
  const [look, setLook] = useState<CameraLook | null>(() => readStoredLook(deviceId));
  useEffect(() => {
    setLook(readStoredLook(deviceId));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === LOOK_STORAGE_KEY) {
        setLook(readStoredLook(deviceId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [deviceId]);
  return look;
}

const CHROMA_STORAGE_KEY = "cameraChroma";

function readStoredChroma(deviceId: string | null | undefined): CameraChromaConfig | null {
  if (!deviceId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(CHROMA_STORAGE_KEY) ?? "{}") as Record<string, CameraChromaConfig>;
    const c = map?.[deviceId];
    return c && typeof c === "object" && "keyColor" in c ? c : null;
  } catch {
    return null;
  }
}

/** Same localStorage + storage-event sync as `usePhoneCameraLook`, but for the
 *  per-camera chroma-key configuration. */
export function useCameraChroma(deviceId: string | null | undefined): CameraChromaConfig | null {
  const [chroma, setChroma] = useState<CameraChromaConfig | null>(() => readStoredChroma(deviceId));
  useEffect(() => {
    setChroma(readStoredChroma(deviceId));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === CHROMA_STORAGE_KEY) {
        setChroma(readStoredChroma(deviceId));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [deviceId]);
  return chroma;
}

interface Props {
  /** Relayed MediaStream to show. When omitted, srcObject is managed by the
   *  caller through `videoRef` (e.g. PreviewCard's own getUserMedia flow). */
  stream?: MediaStream | null;
  /** How the phone is physically held: "portrait" upright, "landscape" rotated
   *  a quarter turn. The stream is rotated to match this, compensating for
   *  whichever orientation the browser delivered. Pass `null` when the feed is
   *  NOT a phone camera (local webcam, Media camera) — those are never
   *  auto-rotated because the browser already orients them natively. */
  orientation: PhoneCameraOrientation | null;
  mirrored?: boolean;
  /** object-fit used when NOT rotating. "landscape" always uses `contain` on
   *  the pre-rotation step so the whole frame is shown before being rotated
   *  and scaled to cover the container. */
  objectFit?: "contain" | "cover";
  /** Per-feed color/crop tuning (CSS filter + pan/zoom transform). */
  look?: CameraLook | null;
  /** Fires with the video frame dimensions once known (used for feed status). */
  onMetadata?: (w: number, h: number) => void;
  className?: string;
  style?: CSSProperties;
  /** Forwards the underlying <video> element so existing refs keep working. */
  videoRef?: (el: HTMLVideoElement | null) => void;
  /** Chroma-key (green/blue screen) config. When enabled the feed is rendered
   *  through a WebGL shader that removes the keyed color so only the subject
   *  remains (composited over whatever sits behind this element — the camera
   *  backdrop or the global background). */
  chromaKey?: CameraChromaConfig | null;
}

const CHROMA_VERT = `
attribute vec2 aPos;
varying vec2 v_uv;
void main() {
  v_uv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const CHROMA_FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D uTexture;
uniform vec3 uKey;
uniform float uThreshold;
uniform float uSmoothness;
uniform float uSpill;

vec3 rgb2yuv(vec3 c) {
  return vec3(
    dot(c, vec3(0.299, 0.587, 0.114)),
    dot(c, vec3(-0.169, -0.331, 0.500)) + 0.5,
    dot(c, vec3(0.500, -0.419, -0.081)) + 0.5
  );
}

void main() {
  vec4 src = texture2D(uTexture, v_uv);
  vec3 yuv = rgb2yuv(src.rgb);
  float cb = yuv.y - uKey.y;
  float cr = yuv.z - uKey.z;
  float chromaDist = sqrt(cb * cb + cr * cr);
  float alpha = 1.0 - smoothstep(uThreshold, uThreshold + uSmoothness, chromaDist);
  // Spill suppression: desaturate pixels on the subject's edge that still carry
  // a hint of the key color, so no green/magenta fringe survives.
  float keyness = clamp((uThreshold - chromaDist) / max(uSmoothness, 0.0001), 0.0, 1.0);
  float spill = uSpill * keyness * (1.0 - alpha);
  vec3 gray = vec3(dot(src.rgb, vec3(0.299, 0.587, 0.114)));
  vec3 color = mix(src.rgb, gray, spill);
  // Premultiplied output for the transparent WebGL canvas.
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

/** Convert a #rrggbb color to the YCbCr space the key shader works in. */
function hexToYuv(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.169 * r - 0.331 * g + 0.5 * b + 0.5;
  const v = 0.5 * r - 0.419 * g - 0.081 * b + 0.5;
  return [y, u, v];
}

/**
 * Renders a camera feed matching the phone's physical orientation. The
 * operator windows receive whatever orientation the browser delivers (the
 * sensor is landscape even when the phone is held portrait, with rotation
 * metadata that the browser may or may not apply), so we only rotate the
 * frame when the delivered frame contradicts the phone's orientation: a
 * portrait phone delivering landscape frames needs a 90deg turn, a landscape
 * phone delivering portrait frames does too. `videoSize` is the rotation-
 * corrected frame dimension reported by the video element, so the two cases
 * are distinguished by comparing it against the requested orientation. When
 * `orientation` is `null` (any non-phone feed) the frame is never rotated.
 * Used by the operator preview (Cockpit, Camera tab) and the projected output
 * window.
 */
export default function PhoneCameraVideo({
  stream,
  orientation,
  mirrored,
  objectFit = "cover",
  look,
  onMetadata,
  className,
  style,
  videoRef,
  chromaKey,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const rawVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  const isChroma = !!chromaKey?.enabled && !!stream;

  useEffect(() => {
    const el = rawVideoRef.current;
    if (!el || stream === undefined) return;
    el.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep `videoSize` current: browsers may re-negotiate the delivered frame
  // dimensions when the phone physically rotates (the element fires `resize`
  // whenever `videoWidth`/`videoHeight` change). The rotation heuristic below
  // compares `videoSize` against the phone-reported orientation, so a stale
  // size would apply (or omit) a 90deg turn on an already-rotated frame and
  // the subject would appear flipped until the next metadata load.
  useEffect(() => {
    const el = rawVideoRef.current;
    if (!el) return;
    const syncSize = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setVideoSize({ w: el.videoWidth, h: el.videoHeight });
      }
    };
    el.addEventListener("resize", syncSize);
    el.addEventListener("loadedmetadata", syncSize);
    return () => {
      el.removeEventListener("resize", syncSize);
      el.removeEventListener("loadedmetadata", syncSize);
    };
  }, [isChroma]);

  // Chroma-key pipeline: a hidden <video> feeds a WebGL fragment shader that
  // keys out the selected color; the visible <canvas> keeps the same
  // orientation / fit / color-crop / mirror treatment as the plain video path.
  useEffect(() => {
    if (!isChroma) return;
    const canvas = canvasRef.current;
    const video = rawVideoRef.current;
    if (!canvas || !video) return;

    const gl = (canvas.getContext("webgl", { alpha: true }) ||
      canvas.getContext("experimental-webgl", { alpha: true })) as WebGLRenderingContext | null;
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, CHROMA_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, CHROMA_FRAG);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const uTexture = gl.getUniformLocation(program, "uTexture");
    const uKey = gl.getUniformLocation(program, "uKey");
    const uThreshold = gl.getUniformLocation(program, "uThreshold");
    const uSmoothness = gl.getUniformLocation(program, "uSmoothness");
    const uSpill = gl.getUniformLocation(program, "uSpill");

    const key = chromaKey ? hexToYuv(chromaKey.keyColor) : hexToYuv("#00B140");

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (video.readyState < 2 || video.videoWidth === 0) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.uniform1i(uTexture, 0);
      gl.uniform3fv(uKey, key);
      gl.uniform1f(uThreshold, chromaKey?.threshold ?? 0.4);
      gl.uniform1f(uSmoothness, chromaKey?.smoothness ?? 0.1);
      gl.uniform1f(uSpill, chromaKey?.spill ?? 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [isChroma, chromaKey?.keyColor, chromaKey?.threshold, chromaKey?.smoothness, chromaKey?.spill]);

  const rotate =
    orientation !== null &&
    !!videoSize &&
    videoSize.w !== videoSize.h &&
    ((orientation === "portrait" && videoSize.w > videoSize.h) ||
      (orientation === "landscape" && videoSize.w < videoSize.h));
  const scale =
    rotate && box && box.w > 0 && box.h > 0
      ? Math.max(box.w / box.h, videoSize && videoSize.h > 0 && videoSize.w > 0 ? videoSize.h / videoSize.w : 1.78)
      : 1;

  const base = rotate
    ? `rotate(90deg) scale(${scale}) scaleX(${mirrored ? -1 : 1})`
    : mirrored
      ? "scaleX(-1)"
      : "none";

  // User color/crop tuning: pan/zoom is prepended so it applies in the already
  // oriented frame's coordinate space; the filter is a plain CSS filter.
  const zoomT = look && look.zoom > 0 ? `translate(${look.panX ?? 0}%, ${look.panY ?? 0}%) scale(${look.zoom}) ` : "";
  const transform = zoomT ? `${zoomT}${base}` : base;
  const filter = look
    ? `brightness(${look.brightness}) contrast(${look.contrast}) saturate(${look.saturation})`
    : undefined;

  const handleMetadata = (el: HTMLVideoElement) => {
    setVideoSize({ w: el.videoWidth, h: el.videoHeight });
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      onMetadata?.(el.videoWidth, el.videoHeight);
    }
  };

  return (
    <div ref={boxRef} className="relative w-full h-full overflow-hidden">
      {isChroma ? (
        <>
          <video
            ref={(el) => {
              rawVideoRef.current = el;
              videoRef?.(el);
            }}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(e) => handleMetadata(e.currentTarget)}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ opacity: 0 }}
          />
          <canvas
            ref={canvasRef}
            className={"absolute inset-0 w-full h-full " + (className ?? "")}
            style={{ objectFit: rotate ? "contain" : objectFit, ...style, transform, filter }}
          />
        </>
      ) : (
        <video
          ref={(el) => {
            rawVideoRef.current = el;
            videoRef?.(el);
          }}
          autoPlay
          playsInline
          onLoadedMetadata={(e) => handleMetadata(e.currentTarget)}
          className={"absolute inset-0 w-full h-full " + (className ?? "")}
          style={{ objectFit: rotate ? "contain" : objectFit, ...style, transform, filter }}
        />
      )}
    </div>
  );
}