import { StateCreator } from "zustand";
import { AppStore } from "../index";

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
      // Enumerate devices only (WP4 P1-2): do NOT open a temporary capture here.
      // The source registry opens the device once per webview (which also grants
      // label access), so opening a throwaway getUserMedia here would be a
      // second, unref-counted acquisition path that fights the registry.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices
        .filter(device => device.kind === "videoinput")
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${device.deviceId.slice(0, 5)}...`
        }));

      set({ availableCameras: cameras });

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
