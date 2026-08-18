import type {
  DisplayItem,
  PresentationSettings,
  ThemeColors,
  PropItem,
  LowerThirdPayload,
  BackgroundSetting,
  SceneZone,
} from "../types";

/**
 * Phase 3 — resolved program-frame model.
 *
 * Every output surface (projection, stage preview, recorder, streamer)
 * resolves the SAME `ProgramFrame` from its `OutputConfig` plus the
 * authoritative presentation snapshot via `ProgramFrameResolver`. An output
 * never independently reconstructs live state — it subscribes to a resolved
 * frame. The DOM outputs (`OutputWindow`/`StageWindow`) and the canvas
 * compositor are both consumers of this model; the canvas renderer paints
 * `frame` directly.
 *
 * `layers` is a declarative, ordered description of the same composition
 * (documentation + fixture parity). The canvas draw pass paints the resolved
 * fields directly; tests assert `layers` to lock the ordering contract.
 */

/** What the output is subscribed to, after resolution. */
export type ResolvedOutputSource =
  | { kind: "live"; item: DisplayItem | null }
  | { kind: "staged"; item: DisplayItem | null }
  | { kind: "scene"; item: DisplayItem | null; scene_id: string }
  | { kind: "item"; item: DisplayItem }
  | { kind: "blank" };

/** The background to paint — already accounting for content-type overrides
 *  (bible/media/song) and output presentation overrides. */
export interface ResolvedBackground {
  setting: BackgroundSetting;
  /** Fallback color when the setting's media is unavailable. */
  fallback: string;
}

/** Resolved persistent logo overlay. */
export interface LogoState {
  text?: string;
  textColor?: string;
  path?: string;
  opacity: number;
}

/** The audio the composited program carries (drives recorder/streamer
 *  audio selection). Kept minimal on purpose — the hub only needs to know
 *  whether the program has audio and whether a zone muted it. */
export type AudioProgramDescriptor =
  | { kind: "none" }
  | { kind: "media"; muted: boolean };

/** Declarative paint-order description of a resolved frame. */
export type ProgramLayer =
  | { kind: "blank" }
  | { kind: "background"; setting: BackgroundSetting }
  | { kind: "item"; item: DisplayItem }
  | { kind: "zone"; zone: SceneZone }
  | { kind: "props"; count: number }
  | { kind: "lower_third"; payload: LowerThirdPayload }
  | { kind: "logo" }
  | { kind: "waiting" };

/** One fully-resolved program frame, shared by every output surface. */
export interface ProgramFrame {
  /** Presentation snapshot revision this frame resolves. */
  revision: number;
  /** When the frame was resolved. */
  timestamp: number;
  /** Render surface geometry + capture cadence. */
  canvas: { width: number; height: number; fps: number };
  source: ResolvedOutputSource;
  /** Declarative paint order (see module doc). */
  layers: ProgramLayer[];
  background: ResolvedBackground;
  /** Overlay payloads AFTER applying the output's overlay mask. An empty
   *  array / null means the layer is masked off (or empty) for this output. */
  overlays: {
    props: PropItem[];
    lower_third: LowerThirdPayload | null;
    logo: LogoState | null;
  };
  blackout: boolean;
  /** Structural resource problems: empty media paths, missing scene
   *  `scene:<id>`, unmasked-without-resource overlays. Runtime load failures
   *  are tracked separately by the canvas resource pipeline. */
  missing: string[];
  audio: AudioProgramDescriptor;
  // Render material shared by the DOM + canvas compositors:
  settings: PresentationSettings;
  colors: ThemeColors;
  reference_output_height: number;
  /** The frame's paint timestamp (timer/clock rendering reads this). */
  now: number;
  /** App data dir for resolving persisted (relativized) media paths. Set by
   *  the surface that materializes the frame; the resolver leaves it unset. */
  appDataDir?: string | null;
}
