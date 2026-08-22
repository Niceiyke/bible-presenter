import { engineInvoke } from "./engineClient";

/**
 * Camera ID-namespace bridge (Phase I1 fix).
 *
 * The webview and the engine name cameras differently:
 *  - `navigator.mediaDevices.enumerateDevices()` yields opaque per-profile
 *    hashes (`c3d25e52…`) that CANNOT be reversed to a hardware name.
 *  - The engine's dshow capture needs the Media Foundation **friendly name**
 *    ("HD Webcam") — exactly what Chromium reports as the device `label`.
 *
 * This module builds both directions of that label mapping once per device
 * refresh, so broadcast items can be staged carrying the ENGINE name while
 * webview previews translate back to a real `getUserMedia` id. When the maps
 * have no answer (engine down, unlabeled device), every lookup falls back to
 * the input unchanged — degrading to the pre-engine behavior instead of
 * breaking.
 */

/** Exact-trimmed label match first, then case-insensitive. */
export function matchEngineName(engineNames: string[], webviewLabel: string): string | null {
  const label = webviewLabel.trim();
  if (!label) return null;
  return (
    engineNames.find((n) => n === label) ??
    engineNames.find((n) => n.toLowerCase() === label.toLowerCase()) ??
    null
  );
}

/**
 * Reverse map: engine friendly name → a webview deviceId whose label matches.
 * With duplicate-named devices the first unassigned webview id wins so two
 * entries never collapse onto one id.
 */
export function matchWebviewDeviceId(
  webviewDevices: { deviceId: string; label: string }[],
  engineName: string
): string | null {
  const target = engineName.trim().toLowerCase();
  if (!target) return null;
  let caseInsensitive: string | null = null;
  for (const d of webviewDevices) {
    const label = d.label.trim();
    if (label === engineName.trim()) return d.deviceId;
    if (!caseInsensitive && label.toLowerCase() === target) caseInsensitive = d.deviceId;
  }
  return caseInsensitive;
}

let engineNameByWebviewId = new Map<string, string>();
let webviewIdByEngineName = new Map<string, string>();
/// Last successfully fetched MF names, so single-device updates made after a
/// stream opens (`noteLocalStreamLabel`) can match without re-querying.
let lastEngineNames: string[] = [];

/**
 * Rebuild both lookup maps from the current webview enumeration + engine
 * device list. Exported for tests; production callers use
 * [`refreshCameraNameMaps`].
 */
export function applyCameraNameMaps(
  videoDevices: { deviceId: string; label: string }[],
  engineNames: string[]
): void {
  const nextForward = new Map<string, string>();
  const nextReverse = new Map<string, string>();
  for (const d of videoDevices) {
    const name = matchEngineName(engineNames, d.label);
    if (!name) continue;
    nextForward.set(d.deviceId, name);
    // First unassigned webview id wins the reverse slot (duplicate labels).
    if (!nextReverse.has(name)) nextReverse.set(name, d.deviceId);
  }
  // Also map any engine name matched only case-insensitively in reverse.
  for (const name of engineNames) {
    if (!nextReverse.has(name)) {
      const id = matchWebviewDeviceId(videoDevices, name);
      if (id) nextReverse.set(name, id);
    }
  }
  cacheEngineNames(engineNames);
  engineNameByWebviewId = nextForward;
  webviewIdByEngineName = nextReverse;
}

/** Remember the engine's device names for later single-device lookups. */
function cacheEngineNames(names: string[]): void {
  if (names.length > 0) lastEngineNames = names;
}

/**
 * Register one device id ↔ label pair learned from a LIVE stream (the track
 * label is the real MF name and proves camera permission was granted — the
 * pre-permission `enumerateDevices` pass has empty labels and can't match).
 * No-op when the bridge already knows this id or nothing matches.
 */
export function noteLocalStreamLabel(webviewDeviceId: string, trackLabel: string): void {
  const label = trackLabel.trim();
  if (!label || !webviewDeviceId) return;
  if (engineNameByWebviewId.has(webviewDeviceId)) return;
  const name = matchEngineName(lastEngineNames, label);
  if (!name) return;
  engineNameByWebviewId = new Map(engineNameByWebviewId).set(webviewDeviceId, name);
  if (!webviewIdByEngineName.has(name)) {
    webviewIdByEngineName = new Map(webviewIdByEngineName).set(name, webviewDeviceId);
  }
}

/** Live MF device names from the engine sidecar; `[]` when unreachable. */
export async function listEngineCameras(): Promise<string[]> {
  try {
    const reply = await engineInvoke({
      id: Date.now(),
      command: { cmd: "capture_list_devices" },
    });
    if (!reply.response.ok) return [];
    const result = reply.response.result as { devices?: { name?: string }[] } | undefined;
    const names = (result?.devices ?? []).map((d) => d.name ?? "").filter(Boolean);
    cacheEngineNames(names);
    return names;
  } catch {
    return [];
  }
}

/** Re-hydrate the sync caches after a camera refresh. Never throws. */
export async function refreshCameraNameMaps(): Promise<void> {
  try {
    const devices =
      (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
    const videoDevices = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    const engineNames = await listEngineCameras();
    applyCameraNameMaps(videoDevices, engineNames);
  } catch {
    // Keep whatever maps existed — stale is better than empty.
  }
}

/** Engine friendly name for a webview deviceId (sync cache); null when unknown. */
export function engineNameForWebviewId(webviewDeviceId: string): string | null {
  return engineNameByWebviewId.get(webviewDeviceId) ?? null;
}

/**
 * Webview deviceId for an engine friendly name (sync cache). Falls back to the
 * input when unknown, so callers can pass it straight to `getUserMedia` and
 * simply fail with NotFoundError as they would for any bogus id.
 */
export function webviewDeviceIdForEngineName(deviceId: string): string {
  return webviewIdByEngineName.get(deviceId) ?? deviceId;
}
