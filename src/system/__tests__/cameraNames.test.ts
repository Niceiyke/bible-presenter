import { describe, expect, it } from "vitest";
import {
  applyCameraNameMaps,
  engineNameForWebviewId,
  matchEngineName,
  matchWebviewDeviceId,
  webviewDeviceIdForEngineName,
} from "../cameraNames";

/**
 * Phase I1 fix — the webview/engine camera ID-namespace bridge.
 *
 * Broadcast items must carry the ENGINE's Media Foundation friendly name
 * (dshow opens devices by name), while webview previews need the Chromium
 * deviceId back. Both directions map through the device label, which is the
 * same friendly name on both sides.
 */
describe("cameraNames bridge", () => {
  const webview = [
    { deviceId: "hash-hd", label: "HD Webcam" },
    { deviceId: "hash-cam", label: "Cam Link 4K" },
    { deviceId: "hash-int", label: "Integrated Camera" },
  ];
  const engine = ["Integrated Camera", "HD Webcam", "Cam Link 4K"];

  describe("matchEngineName", () => {
    it("matches exact labels", () => {
      expect(matchEngineName(engine, " HD Webcam ")).toBe("HD Webcam");
    });

    it("falls back to case-insensitive matching", () => {
      expect(matchEngineName(engine, "hd webcam")).toBe("HD Webcam");
    });

    it("returns null for unlabeled or unknown devices", () => {
      expect(matchEngineName(engine, "")).toBeNull();
      expect(matchEngineName([], "HD Webcam")).toBeNull();
      expect(matchEngineName(engine, "Ghost Cam")).toBeNull();
    });
  });

  describe("matchWebviewDeviceId", () => {
    it("matches exact labels first", () => {
      expect(matchWebviewDeviceId(webview, "Cam Link 4K")).toBe("hash-cam");
    });

    it("falls back to case-insensitive matching", () => {
      expect(matchWebviewDeviceId(webview, "integrated camera")).toBe("hash-int");
    });

    it("returns null when nothing matches", () => {
      expect(matchWebviewDeviceId(webview, "Ghost Cam")).toBeNull();
      expect(matchWebviewDeviceId([], "HD Webcam")).toBeNull();
    });
  });

  describe("applyCameraNameMaps + sync lookups", () => {
    it("builds both directions of the mapping", () => {
      applyCameraNameMaps(webview, engine);
      expect(engineNameForWebviewId("hash-hd")).toBe("HD Webcam");
      expect(webviewDeviceIdForEngineName("HD Webcam")).toBe("hash-hd");
      expect(webviewDeviceIdForEngineName("Integrated Camera")).toBe("hash-int");
    });

    it("case-insensitive reverse matches still land in the map", () => {
      applyCameraNameMaps(
        [{ deviceId: "w1", label: "weird cam" }],
        ["Weird Cam"]
      );
      expect(engineNameForWebviewId("w1")).toBe("Weird Cam");
      expect(webviewDeviceIdForEngineName("Weird Cam")).toBe("w1");
    });

    it("duplicate webview labels keep the first id on the reverse map", () => {
      applyCameraNameMaps(
        [
          { deviceId: "dup-a", label: "Twin" },
          { deviceId: "dup-b", label: "Twin" },
        ],
        ["Twin"]
      );
      expect(webviewDeviceIdForEngineName("Twin")).toBe("dup-a");
      expect(engineNameForWebviewId("dup-b")).toBe("Twin");
    });

    it("unmapped ids fall through unchanged so callers degrade safely", () => {
      applyCameraNameMaps([], []);
      expect(engineNameForWebviewId("unknown-hash")).toBeNull();
      // getUserMedia will simply fail NotFoundError as with any bogus id.
      expect(webviewDeviceIdForEngineName("phone-camera-x")).toBe("phone-camera-x");
    });

    it("replacing the maps drops stale entries from a previous refresh", () => {
      applyCameraNameMaps([{ deviceId: "old", label: "Old Cam" }], ["Old Cam"]);
      applyCameraNameMaps([{ deviceId: "new", label: "New Cam" }], ["New Cam"]);
      expect(engineNameForWebviewId("old")).toBeNull();
      expect(engineNameForWebviewId("new")).toBe("New Cam");
    });
  });
});
