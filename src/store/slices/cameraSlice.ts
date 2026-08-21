import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { primeCameraPermission } from "../../system/sourceRegistry";
import { refreshCameraNameMaps } from "../../system/cameraNames";

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export interface PhoneCameraInfo {
  deviceId: string;
  label: string;
  peerConnection?: RTCPeerConnection;
  stream?: MediaStream | null;
}

export interface CameraSlice {
  availableCameras: CameraDeviceInfo[];
  selectedCameraId: string | null;
  phoneCameras: PhoneCameraInfo[];
  setAvailableCameras: (cameras: CameraDeviceInfo[]) => void;
  setSelectedCameraId: (id: string | null) => void;
  addPhoneCamera: (camera: PhoneCameraInfo) => void;
  removePhoneCamera: (deviceId: string) => void;
  updatePhoneCameraStream: (deviceId: string, stream: MediaStream | null) => void;
  refreshCameras: () => Promise<void>;
}

export const createCameraSlice: StateCreator<AppStore, [], [], CameraSlice> = (set, get) => ({
  availableCameras: [],
  selectedCameraId: null,
  phoneCameras: [],
  setAvailableCameras: (cameras) => set({ availableCameras: cameras }),
  setSelectedCameraId: (id) => set({ selectedCameraId: id }),
  addPhoneCamera: (camera) => set((state) => ({
    phoneCameras: [...state.phoneCameras.filter(c => c.deviceId !== camera.deviceId), camera]
  })),
  removePhoneCamera: (deviceId) => set((state) => ({
    phoneCameras: state.phoneCameras.filter(c => c.deviceId !== deviceId)
  })),
  updatePhoneCameraStream: (deviceId, stream) => set((state) => ({
    phoneCameras: state.phoneCameras.map(c => 
      c.deviceId === deviceId ? { ...c, stream } : c
    )
  })),
  refreshCameras: async () => {
    try {
      // WP4 P1-2: enumerate devices without opening a throwaway, unref-counted
      // capture. But browsers only reveal camera labels (and sometimes the list
      // itself) after the user grants permission — so route ONE permission
      // request through the source-registry policy first, then enumerate. This
      // warms the webcam list without becoming a second acquisition path.
      await primeCameraPermission();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices
        .filter(device => device.kind === "videoinput")
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${device.deviceId.slice(0, 5)}...`
        }));

      set({ availableCameras: cameras });

      // Phase I1: re-bridge the webview/engine ID namespaces so broadcast
      // staging can carry engine friendly names and previews translate back.
      void refreshCameraNameMaps();

      // Auto-select first camera if none selected
      set((state) => {
        if (!state.selectedCameraId && cameras.length > 0) {
          return { selectedCameraId: cameras[0].deviceId };
        }
        return {};
      });
    } catch (error) {
      console.error("Failed to refresh cameras:", error);
    }
  }
});
