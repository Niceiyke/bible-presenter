import type {
  DisplayItem,
  OutputConfig,
  OutputSource,
  PresentationSettings,
  PropItem,
  LowerThirdData,
  LowerThirdTemplate,
  CameraBackground,
  VideoBackground,
  AudioBackground,
  ImageBackground,
  BackgroundSetting,
} from "../types";
import { THEMES, type ThemeColors } from "../types";
import type { LicenseInfo } from "../types/license";
import { tierCapabilities } from "../system/tiers";
import { getVideoBackground, getCameraBackground, getAudioBackground, getImageBackground } from "../utils";

export interface LowerThirdState {
  data: LowerThirdData;
  template: LowerThirdTemplate;
}

/**
 * The resolved program frame for one output surface. A pure, renderer-ready
 * model produced by `resolveOutputFrame`. Renderers (the DOM OutputWindow, the
 * shared DOM ProgramSurface preview, and future native-capture consumers)
 * derive their pixels from this single object, so no renderer combines global
 * settings with per-output overrides itself.
 */
export interface ResolvedOutputFrame {
  /** The display item this output actually renders after resolving its source. */
  item: DisplayItem | null;
  /** The staged item (used by staged sources). */
  staged: DisplayItem | null;
  /** Broadcast presentation settings overlaid with this output's overrides. */
  settings: PresentationSettings;
  /** Raw broadcast settings (before output overrides). */
  baseSettings: PresentationSettings;
  /** Theme colors resolved from `settings.theme`. */
  colors: ThemeColors;
  /** Effective overlay visibility after applying this output's mask. */
  overlays: { props: boolean; lower_third: boolean; logo: boolean };
  /** Whether the output is blanked and should render solid black. */
  blanked: boolean;
  /** Lower third after applying the output's overlay mask. */
  lowerThird: LowerThirdState | null;
  /** Lower third BEFORE the overlay mask (so masks can be reasoned about). */
  rawLowerThird: LowerThirdState | null;
  /** Persistent props after applying the output's overlay mask. */
  propItems: PropItem[];
  /** The resolved `OutputSource` for this output. */
  source: OutputSource;
  /** The output config that produced this frame (null for pure live). */
  config: OutputConfig | null;
  /** Effective background layers resolved for the current item. */
  backgrounds: {
    video: VideoBackground | null;
    camera: CameraBackground | null;
    audio: AudioBackground | null;
    image: ImageBackground | null;
  };
  /** Whether a Free-tier watermark must be rendered. */
  watermark: boolean;
  /** Effective reference scale resolved from settings / output override. */
  referenceOutputHeight: number;
}

export interface ResolveOutputFrameInput {
  live: DisplayItem | null;
  staged: DisplayItem | null;
  settings: PresentationSettings;
  lowerThird: LowerThirdState | null;
  propItems: PropItem[];
  config: OutputConfig | null;
  license: LicenseInfo | null;
}

/**
 * Resolve a single output's renderer-ready frame from the broadcast program
 * state and its own configuration. This is the single place where output
 * source selection, presentation overrides, and overlay masks are applied, so
 * every renderer (audience window, staged window, Cockpit preview, native
 * capture consumer) manifests identical pixels.
 */
export function resolveOutputFrame(input: ResolveOutputFrameInput): ResolvedOutputFrame {
  const { live, staged, settings, lowerThird, propItems, config, license } = input;

  const effSettings: PresentationSettings = config?.presentation
    ? {
        ...settings,
        theme: config.presentation.theme ?? settings.theme,
        reference_output_height:
          config.presentation.reference_output_height ?? settings.reference_output_height,
        background: config.presentation.background ?? settings.background,
        is_blanked: config.presentation.blanked ?? settings.is_blanked,
      }
    : settings;

  const overlays = config?.overlays ?? { props: true, lower_third: true, logo: true };

  const source = config?.source ?? { type: "live" };

  const rawLowerThird = lowerThird;
  const resolvedLowerThird = overlays.lower_third ? lowerThird : null;
  const resolvedProps = overlays.props ? propItems : [];

  const item = resolveSourceItem(source, live, staged);
  const resolvedItem = effSettings.is_blanked ? null : item;

  const { colors } = THEMES[effSettings.theme] ?? THEMES.dark;

  const backgrounds = {
    video: getVideoBackground(effSettings, resolvedItem),
    camera: getCameraBackground(effSettings, resolvedItem),
    audio: getAudioBackground(effSettings, resolvedItem),
    image: getImageBackground(effSettings, resolvedItem),
  };

  const watermark =
    license?.status === "active" ? tierCapabilities(license.tier).watermark : false;

  return {
    item: resolvedItem,
    staged,
    settings: effSettings,
    baseSettings: settings,
    colors,
    overlays,
    blanked: effSettings.is_blanked,
    lowerThird: resolvedLowerThird,
    rawLowerThird,
    propItems: resolvedProps,
    source,
    config,
    backgrounds,
    watermark,
    referenceOutputHeight: effSettings.reference_output_height ?? 1080,
  };
}

/**
 * Resolve which item a source references. `blank` yields a black output; most
 * sources yield live. Staged/scene/item sources are honored for completeness
 * so a real multi-output deployment renders the configured program.
 */
function resolveSourceItem(
  source: OutputSource,
  live: DisplayItem | null,
  staged: DisplayItem | null,
): DisplayItem | null {
  switch (source.type) {
    case "blank":
      return null;
    case "staged":
      return staged ?? live;
    case "scene":
    case "item":
      // Scene pins and fixed items are resolved by the backend/output config at
      // authoring time; for the live-defined sources we only render the fields
      // captured in the source. Scenes are loaded via their own app flow.
      return (source as { item?: DisplayItem }).item ?? null;
    case "live":
    default:
      return live;
  }
}
