import { THEMES } from "../types";
import type {
  DisplayItem,
  PresentationSettings,
  BackgroundSetting,
  ThemeColors,
  LowerThirdPayload,
  Scene,
  SceneCompositionData,
} from "../types";
import type { OutputConfig } from "../types";
import type { PresentationSnapshot } from "../types";
import type {
  AudioProgramDescriptor,
  LogoState,
  ProgramFrame,
  ProgramLayer,
  ResolvedBackground,
  ResolvedOutputSource,
} from "./ProgramFrame";

/**
 * Phase 3 — program-frame resolver.
 *
 * Pure function that turns an `OutputConfig` + the authoritative presentation
 * snapshot into a fully-resolved `ProgramFrame`. Every output surface calls
 * this with its own config and the same snapshot, so projection, stage
 * preview, recorder, and streamer all resolve the same frame: output source
 * (`live`/`staged`/`item`/`scene`/`blank`), presentation overrides
 * (theme / reference_output_height / background / blanked), overlay masks
 * (props / lower_third / logo), scene-zone compositions, blackout, and
 * structural resource problems.
 *
 * The resolver never mutates engine state and never reads a window — it is a
 * pure function of its inputs so it can be fixture-tested.
 */

/** Inputs the resolver needs. `snapshot` is a subset of the authoritative
 *  `PresentationSnapshot` — surfaces that don't carry a full snapshot (e.g.
 *  the Cockpit preview) can build it from their store slices. */
export interface ProgramFrameInput {
  config: OutputConfig;
  snapshot: Pick<
    PresentationSnapshot,
    "live" | "staged" | "settings" | "props" | "lower_third" | "revision"
  >;
  /** Saved scenes, used to resolve `scene` sources. Optional — a missing
   *  scene resolves to a safe "waiting" frame and reports `scene:<id>`. */
  scenes?: Scene[];
  /** Fallback theme colors when neither the output override nor the settings
   *  theme resolve (used by surfaces that already know their theme). */
  colors?: ThemeColors;
  /** Paint timestamp. Defaults to `Date.now()`. */
  timestamp?: number;
  /** Capture fps for the canvas. Defaults to `config.capture_fps` ?? 30. */
  fps?: number;
}

/** The effective background for an item, honoring content-type overrides
 *  (bible/media/song) the same way the DOM outputs and the canvas draw pass
 *  do. */
export function getEffectiveBg(
  settings: PresentationSettings,
  item: DisplayItem | null
): BackgroundSetting {
  if (item?.type === "Verse" && settings.bible_background?.type !== "None" && settings.bible_background) {
    return settings.bible_background;
  }
  if (item?.type === "Media" && settings.media_background?.type !== "None" && settings.media_background) {
    return settings.media_background;
  }
  if (item?.type === "Song") {
    if (item.data.background?.type !== "None" && item.data.background) return item.data.background;
    if (settings.song_background?.type !== "None" && settings.song_background) return settings.song_background;
  }
  return settings.background;
}

/** Resolve theme colors: output override > settings theme > fallback/dark. */
export function resolveThemeColors(
  config: OutputConfig,
  settings: PresentationSettings,
  fallback?: ThemeColors
): ThemeColors {
  if (config.presentation?.theme) {
    const t = THEMES[config.presentation.theme];
    if (t) return t.colors;
  }
  return (THEMES[settings.theme] ?? THEMES.dark).colors ?? fallback ?? THEMES.dark.colors;
}

/** Resolve the persistent logo overlay from settings. */
export function deriveLogoState(settings: PresentationSettings): LogoState | null {
  if (settings.logo_text) return { text: settings.logo_text, textColor: settings.logo_text_color ?? "#ffffff", opacity: 0.6 };
  if (settings.logo_path) return { path: settings.logo_path, opacity: 0.5 };
  return null;
}

function resolveSceneItem(
  scene: Scene | undefined,
  sceneId: string
): { item: DisplayItem | null; missing: string[] } {
  if (!scene) return { item: null, missing: [`scene:${sceneId}`] };
  if (scene.layout?.zones?.length) {
    const item: DisplayItem = {
      type: "SceneComposition",
      data: { scene_id: scene.id, name: scene.name, zones: scene.layout.zones } satisfies SceneCompositionData,
    };
    return { item, missing: [] };
  }
  if (scene.camera) return { item: scene.camera, missing: [] };
  // Saved scene with no live content — safe frame.
  return { item: null, missing: [] };
}

function itemLayers(item: DisplayItem | null): ProgramLayer[] {
  if (!item) return [{ kind: "waiting" }];
  if (item.type === "SceneComposition") {
    const zones = item.data.zones.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    return zones.map((z): ProgramLayer => ({ kind: "zone", zone: z }));
  }
  return [{ kind: "item", item }];
}

function resolveSource(
  source: OutputConfig["source"],
  snapshot: ProgramFrameInput["snapshot"],
  scenes?: Scene[]
): { source: ResolvedOutputSource; layers: ProgramLayer[]; missing: string[] } {
  switch (source.type) {
    case "blank":
      return { source: { kind: "blank" }, layers: [{ kind: "blank" }], missing: [] };
    case "item":
      return {
        source: { kind: "item", item: source.item },
        layers: itemLayers(source.item),
        missing: [],
      };
    case "staged":
      if (snapshot.staged) {
        return {
          source: { kind: "staged", item: snapshot.staged },
          layers: itemLayers(snapshot.staged),
          missing: [],
        };
      }
      return { source: { kind: "staged", item: null }, layers: [{ kind: "waiting" }], missing: [] };
    case "scene": {
      const { item, missing } = resolveSceneItem(scenes?.find((s) => s.id === source.scene_id), source.scene_id);
      return {
        source: { kind: "scene", item, scene_id: source.scene_id },
        layers: itemLayers(item),
        missing,
      };
    }
    case "live":
    default:
      if (snapshot.live) {
        return {
          source: { kind: "live", item: snapshot.live },
          layers: itemLayers(snapshot.live),
          missing: [],
        };
      }
      return { source: { kind: "live", item: null }, layers: [{ kind: "waiting" }], missing: [] };
  }
}

/** Structural resource problems the resolver can see without loading files:
 *  empty media/prop/logo paths. Runtime load failures (a file that is gone
 *  from disk) are tracked by the canvas resource pipeline instead. */
function structuralMissing(
  source: ResolvedOutputSource,
  overlays: ProgramFrame["overlays"],
  background: ResolvedBackground
): string[] {
  const missing = new Set<string>();
  const walk = (item: DisplayItem | null) => {
    if (!item) return;
    switch (item.type) {
      case "Media":
        if (!item.data.path || !item.data.path.trim()) missing.add("media");
        break;
      case "CustomSlide":
        for (const el of item.data.elements ?? []) {
          if ((el.kind === "image" || el.kind === "video") && (!el.content || !String(el.content).trim())) {
            missing.add("slide:media");
          }
        }
        break;
      case "SceneComposition":
        for (const zone of item.data.zones) walk(zone.item);
        break;
      default:
        break;
    }
  };
  if (source.kind !== "blank") {
    walk(source.item);
    if (background.setting.type === "Image" && !background.setting.value.path.trim()) missing.add("background");
    if (background.setting.type === "Video" && !background.setting.value.path.trim()) missing.add("background");
  }
  for (const p of overlays.props) {
    if (p.kind === "image" && (!p.path || !p.path.trim())) missing.add(`prop:${p.id}`);
  }
  if (overlays.logo && !overlays.logo.text && !overlays.logo.path) missing.add("logo");
  return [...missing];
}

/** Every media path the frame references (backgrounds, item media, slide
 *  elements, zone contents, props, logo) keyed by type. The canvas resource
 *  pipeline uses this to load exactly what the draw pass needs — one walk, so
 *  a loading gap can never diverge from what a frame actually paints. */
export function collectFrameMediaPaths(frame: ProgramFrame): {
  images: string[];
  videos: string[];
} {
  const images = new Set<string>();
  const videos = new Set<string>();
  const addBg = (bg: BackgroundSetting) => {
    if (bg.type === "Image") images.add(bg.value.path);
    else if (bg.type === "Video") videos.add(bg.value.path);
  };
  const addSlide = (data: { background?: any; elements?: any[] }) => {
    const sb = data.background;
    if (sb?.type === "image") images.add(sb.value);
    else if (sb?.type === "video") videos.add(sb.value);
    for (const el of data.elements ?? []) {
      if (el.kind === "image") images.add(el.content);
      else if (el.kind === "video") videos.add(el.content);
    }
  };
  const addItem = (item: DisplayItem | null) => {
    if (!item) return;
    switch (item.type) {
      case "Media":
        if (item.data.media_type === "Image") images.add(item.data.path);
        else if (item.data.media_type === "Video") videos.add(item.data.path);
        break;
      case "CustomSlide":
        addSlide(item.data);
        break;
      case "SceneComposition":
        for (const zone of item.data.zones) {
          addBg(getEffectiveBg(frame.settings, zone.item));
          addItem(zone.item);
        }
        break;
      default:
        break;
    }
  };
  if (frame.source.kind !== "blank") {
    addBg(frame.background.setting);
    addItem(frame.source.item);
  }
  for (const p of frame.overlays.props) {
    if (p.kind === "image" && p.path) images.add(p.path);
  }
  if (frame.overlays.logo?.path) images.add(frame.overlays.logo.path);
  return { images: [...images].filter(Boolean), videos: [...videos].filter(Boolean) };
}

function deriveAudio(item: DisplayItem | null): AudioProgramDescriptor {
  if (item?.type === "Media" && item.data.media_type !== "Image") {
    return { kind: "media", muted: false };
  }
  return { kind: "none" };
}

/**
 * Resolve one authoritative program frame for an output.
 *
 * Order of operations:
 *  1. Source — what the output is subscribed to.
 *  2. Presentation overrides — theme, reference height, background, blanked.
 *  3. Background — override wins, else effective setting for the source item
 *     (scene sources fall back to the scene's saved settings).
 *  4. Overlays — masked per the output config.
 *  5. Blackout, layers, missing, audio.
 */
export function resolveProgramFrame(input: ProgramFrameInput): ProgramFrame {
  const { config, snapshot, scenes } = input;
  const settings = snapshot.settings;
  const now = input.timestamp ?? Date.now();
  const canvas = {
    width: config.geometry.width,
    height: config.geometry.height,
    fps: input.fps ?? config.capture_fps ?? 30,
  };

  const { source, layers, missing: sourceMissing } = resolveSource(config.source, snapshot, scenes);

  const colors = resolveThemeColors(config, settings, input.colors);
  const reference_output_height =
    config.presentation?.reference_output_height ?? settings.reference_output_height ?? 1080;

  const blankSource = source.kind === "blank";
  const blackout = blankSource ? true : (config.presentation?.blanked ?? settings.is_blanked);

  let backgroundSetting: BackgroundSetting;
  if (blankSource) {
    backgroundSetting = { type: "Color", value: "#000000" };
  } else if (config.presentation?.background) {
    backgroundSetting = config.presentation.background;
  } else if (source.kind === "scene" && source.scene_id) {
    const scene = scenes?.find((s) => s.id === source.scene_id);
    backgroundSetting = getEffectiveBg(scene?.settings ?? settings, source.item);
  } else {
    backgroundSetting = getEffectiveBg(settings, source.item);
  }
  const background: ResolvedBackground = { setting: backgroundSetting, fallback: colors.background };

  const mask = config.overlays;
  const overlays = blankSource
    ? { props: [], lower_third: null, logo: null }
    : {
        props: mask.props ? (snapshot.props ?? []) : [],
        lower_third: mask.lower_third ? (snapshot.lower_third as LowerThirdPayload | null) ?? null : null,
        logo: mask.logo ? deriveLogoState(settings) : null,
      };

  const audio = blankSource ? { kind: "none" as const } : deriveAudio(source.item);

  const frame: ProgramFrame = {
    revision: snapshot.revision ?? 0,
    timestamp: now,
    canvas,
    source,
    layers: blackout
      ? [{ kind: "blank" }]
      : [
          ...(blankSource ? [] : [{ kind: "background" as const, setting: backgroundSetting }]),
          ...(blankSource ? [] : layers),
          ...(overlays.logo ? [{ kind: "logo" as const }] : []),
          ...(overlays.props.length ? [{ kind: "props" as const, count: overlays.props.length }] : []),
          ...(overlays.lower_third ? [{ kind: "lower_third" as const, payload: overlays.lower_third }] : []),
        ],
    background,
    overlays,
    blackout,
    missing: [...sourceMissing, ...structuralMissing(source, overlays, background)],
    audio,
    settings,
    colors,
    reference_output_height,
    now,
  };
  return frame;
}
