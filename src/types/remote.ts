import type { DisplayItem, ScheduleEntry, ServiceMeta } from "./display";
import type { Verse } from "./verse";

/**
 * Remote Control protocol shared between the Tauri backend
 * (`src-tauri/src/remote/protocol.rs`) and the browser remote bundle
 * (`src/remote/`). Bump REMOTE_PROTOCOL_VERSION whenever the wire format
 * changes incompatibly; the server rejects clients with an older version.
 */
export const REMOTE_PROTOCOL_VERSION = 1;

export type RemoteRole = "viewer" | "operator" | "admin";

/** Granular content-domain permissions a paired device may be granted. Mirrors
 * `RemotePermissions` in `src-tauri/src/remote/protocol.rs`. Roles provide
 * presets; the operator refines per device from Settings → Remote Control. */
export interface RemotePermissions {
  scripture: boolean;
  song: boolean;
  camera: boolean;
  lower_third: boolean;
  presentation: boolean;
}

export type RemoteCommandType =
  | "remote.pair"
  | "remote.authenticate"
  | "remote.request_control"
  | "remote.release_control"
  | "remote.renew_lease"
  | "snapshot.get"
  | "bible.versions"
  | "bible.books"
  | "bible.chapters"
  | "bible.verse_numbers"
  | "bible.chapter"
  | "bible.search"
  | "bible.stage"
  | "bible.go_live"
  | "bible.stage_next"
  | "bible.go_live_next"
  | "bible.stage_previous"
  | "bible.go_live_previous"
  | "bible.add_to_service"
  | "display.go_live"
  | "display.stage_next"
  | "display.stage_previous"
  | "display.clear_live"
  | "display.clear_all"
  | "display.blackout"
  | "display.logo_toggle"
  | "service.list"
  | "songs.search"
  | "song.stage"
  | "song.go_live"
  | "lower_third.show"
  | "lower_third.hide"
  | "camera.start"
  | "camera.stop"
  | "camera.offer"
  | "camera.answer"
  | "camera.ice";

export interface RemoteCommand {
  command_id: string;
  type: RemoteCommandType;
  payload?: unknown;
  /** Optional expected backend revision; mutating commands reject stale clients. */
  expected_revision?: number;
}

export interface RemoteCommandResult {
  command_id: string;
  ok: boolean;
  revision: number;
  error?: {
    code: string;
    message: string;
  };
  result?: unknown;
}

export type RemoteEventKind =
  | "snapshot"
  | "live.changed"
  | "staged.changed"
  | "schedule.changed"
  | "lower_third.changed"
  | "output.changed"
  | "blackout.changed"
  | "logo.changed"
  | "controller.changed"
  | "operator.notice"
  | "camera.answer"
  | "camera.ice";

export interface RemoteEvent {
  kind: RemoteEventKind;
  revision: number;
  timestamp: number;
  source_device_id?: string;
  payload: unknown;
}

export interface RemoteControllerState {
  kind: "viewing" | "requested" | "held";
  device_id?: string;
  device_name?: string;
  expires_at?: number;
}

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  role: RemoteRole;
  permissions: RemotePermissions;
  paired_at: number;
  last_seen_at?: number;
  connected: boolean;
}

export interface RemoteSongSummary {
  id: string;
  title: string;
  style?: string;
  section_labels: string[];
}

export interface RemoteSnapshot {
  protocol_version: number;
  revision: number;
  connected: boolean;
  role: RemoteRole;
  permissions: RemotePermissions;
  controller_device_id?: string;
  controller_state: RemoteControllerState;
  live_item: DisplayItem | null;
  staged_item: DisplayItem | null;
  active_service: ServiceMeta | null;
  schedule_entries: ScheduleEntry[];
  output_visible: boolean;
  blackout: boolean;
  background_logo: boolean;
  lower_third: unknown | null;
  bible_versions: string[];
  active_bible_version: string;
  songs: RemoteSongSummary[];
}

export interface RemoteStatus {
  enabled: boolean;
  port?: number;
  urls: string[];
  pairing_code?: string;
  pairing_expires_at?: number;
  devices: RemoteDeviceInfo[];
  controller_state: RemoteControllerState;
  revision: number;
}

export interface RemotePairPayload {
  pairing_token: string;
  device_name: string;
}

export interface RemotePairResult {
  device_id: string;
  device_token: string;
  role: RemoteRole;
  permissions: RemotePermissions;
}

export interface RemoteAuthPayload {
  device_token: string;
}

export interface RemoteAuthResult {
  device_id: string;
  role: RemoteRole;
  permissions: RemotePermissions;
  controller_state: RemoteControllerState;
}

export interface RemoteBibleRef {
  book: string;
  chapter: number;
  verse: number;
  version: string;
}

export interface RemoteBibleSearch {
  query: string;
  version: string;
}

export interface RemoteBibleChapterRequest {
  book: string;
  chapter: number;
  version: string;
}

export interface RemoteSearchResult {
  results: Verse[];
  method: string;
}

export interface RemoteServiceList {
  active_service: ServiceMeta | null;
  entries: ScheduleEntry[];
}

export interface RemoteSongsSearch {
  query: string;
  include_hymns?: boolean;
}

export interface RemoteSongControlPayload {
  song_id: string;
  style?: "FullScreen" | "LowerThird";
  section_index?: number;
}

export interface RemoteLowerThirdPayload {
  kind: "Nameplate" | "Lyrics" | "FreeText";
  data: unknown;
  template?: unknown;
}

/** WebRTC peer target for a phone camera: which operator-side window answers. */
export type RemoteCameraTarget = "operator" | "output";

/** How a phone camera feed is oriented when displayed (operator preview and
 *  projected output). Stored per phone camera device id in the operator store
 *  and persisted to localStorage so a fixed landscape-mounted phone keeps its
 *  orientation across sessions and windows. */
export type PhoneCameraOrientation = "portrait" | "landscape";

/** Per-feed display tuning applied to a camera feed (CSS filter + transform).
 *  Stored per phone camera device id in the operator store and persisted to
 *  localStorage so a feed keeps its look across sessions and windows. */
export interface CameraLook {
  brightness: number;
  contrast: number;
  saturation: number;
  zoom: number;
  panX: number;
  panY: number;
}

export const DEFAULT_CAMERA_LOOK: CameraLook = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  zoom: 1,
  panX: 0,
  panY: 0,
};

export interface RemoteCameraStartPayload {
  device_id: string;
  device_name: string;
  facing_mode?: "user" | "environment";
}

export interface RemoteCameraOfferPayload {
  sdp: string;
  device_id: string;
  target?: RemoteCameraTarget;
}

export interface RemoteCameraAnswerPayload {
  sdp: string;
  device_id: string;
  target?: RemoteCameraTarget;
}

export interface RemoteCameraIcePayload {
  candidate: string;
  sdp_mid: string;
  sdp_m_line_index: number;
  device_id: string;
  target?: RemoteCameraTarget;
}

export function isRemoteCommand(value: unknown): value is RemoteCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RemoteCommand).command_id === "string" &&
    typeof (value as RemoteCommand).type === "string"
  );
}

export function isRemoteEvent(value: unknown): value is RemoteEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RemoteEvent).kind === "string" &&
    typeof (value as RemoteEvent).revision === "number"
  );
}

export function isRemoteCommandResult(value: unknown): value is RemoteCommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RemoteCommandResult).command_id === "string" &&
    typeof (value as RemoteCommandResult).ok === "boolean" &&
    typeof (value as RemoteCommandResult).revision === "number"
  );
}