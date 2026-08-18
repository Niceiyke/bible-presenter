import type {
  DisplayItem,
  PresentationSettings,
  PropItem,
} from "../../types";
import { DEFAULT_LT_TEMPLATE, THEMES } from "../../types";

/**
 * Representative presentation frames for fixture-based tests (plan §6 Phase 0).
 *
 * Each fixture is a complete, valid `DisplayItem` plus the surrounding context
 * a renderer needs (settings, props). The canvas compositor and DOM renderers
 * must produce the same frame from these fixtures; test cases reference them
 * instead of hand-rolling item literals so parity expectations stay in one
 * place.
 */

export const baseSettings: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "Color", value: "#000000" },
  is_blanked: false,
  font_size: 72,
  disabled_bible_versions: [],
  auto_split_verses: true,
  verse_split_threshold: 200,
};

export const baseTheme = THEMES.dark;

export const verseItem: DisplayItem = {
  type: "Verse",
  data: {
    book: "John",
    chapter: 3,
    verse: 16,
    text: "For God so loved the world that he gave his one and only Son.",
    version: "KJV",
  },
};

export const songItem: DisplayItem = {
  type: "Song",
  data: {
    song_id: "song-1",
    title: "Amazing Grace",
    author: "John Newton",
    section_label: "Chorus",
    lines: ["Amazing grace, how sweet the sound", "That saved a wretch like me"],
    slide_index: 0,
    total_slides: 2,
    style: "FullSlide",
  },
};

export const slideItem: DisplayItem = {
  type: "CustomSlide",
  data: {
    presentation_id: "pres-1",
    presentation_name: "Announcements",
    slide_index: 0,
    slide_count: 1,
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: "e1",
        kind: "text",
        x: 10,
        y: 10,
        w: 80,
        h: 20,
        z_index: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Welcome" }],
            },
          ],
        },
        font_size: 48,
        font_family: "Arial",
        color: "#ffffff",
        align: "center",
        v_align: "middle",
      },
    ],
  },
};

export const mediaItem: DisplayItem = {
  type: "Media",
  data: {
    id: "media-1",
    name: "Sermon Bumper",
    path: "media/sermon-bumper.mp4",
    media_type: "Video",
    tags: [],
    fit_mode: "cover",
    loop_playback: true,
    playback_rate: 1,
    volume: 0.8,
  },
};

export const cameraItem: DisplayItem = {
  type: "Camera",
  data: {
    deviceId: "cam-local-1",
    opacity: 1,
    objectFit: "cover",
    mirrored: false,
  },
};

export const timerItem: DisplayItem = {
  type: "Timer",
  data: {
    timer_type: "countdown",
    duration_secs: 300,
    label: "Sermon",
    started_at: 1_700_000_000_000,
  },
};

export const sceneCompositionItem: DisplayItem = {
  type: "SceneComposition",
  data: {
    scene_id: "scene-1",
    name: "Cam + Bible",
    zones: [
      {
        id: "cam",
        item: cameraItem,
        source: { type: "camera" },
        x: 0,
        y: 0,
        w: 0.5,
        h: 1,
        fit: "cover",
        opacity: 1,
        z: 1,
      },
      {
        id: "verse",
        item: verseItem,
        source: { type: "verse" },
        x: 0.5,
        y: 0,
        w: 0.5,
        h: 1,
        fit: "cover",
        opacity: 1,
        z: 2,
      },
    ],
  },
};

export const clockItem: DisplayItem = {
  type: "Timer",
  data: { timer_type: "clock" },
};

export const imageProp: PropItem = {
  id: "prop-1",
  kind: "image",
  path: "media/logo.png",
  x: 10,
  y: 10,
  w: 20,
  h: 20,
  opacity: 1,
  visible: true,
};

export const clockProp: PropItem = {
  id: "prop-2",
  kind: "clock",
  x: 80,
  y: 5,
  w: 15,
  h: 10,
  opacity: 1,
  visible: true,
};

export const lowerThirdFixture = {
  data: {
    kind: "Nameplate",
    data: {
      name: "Pastor Smith",
      role: "Senior Pastor",
    },
  },
  template: DEFAULT_LT_TEMPLATE,
};

export const lowerThirdItem: DisplayItem = {
  type: "CustomSlide",
  data: {
    presentation_id: "lt-pres-1",
    presentation_name: "Lower Third",
    slide_index: 0,
    slide_count: 1,
    background: { type: "color", value: "#00000000" },
    elements: [],
  },
};

/** Every representative item, for exhaustive parity iteration. */
export const allItems: DisplayItem[] = [
  verseItem,
  songItem,
  slideItem,
  mediaItem,
  cameraItem,
  timerItem,
  sceneCompositionItem,
  clockItem,
];

export const allProps: PropItem[] = [imageProp, clockProp];
