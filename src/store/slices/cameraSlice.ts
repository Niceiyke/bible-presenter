import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export interface CameraSlice {
  availableCameras: CameraDeviceInfo[];
  selectedCameraId: string | null;
  setAvailableCameras: (cameras: CameraDeviceInfo[]) => void;
  setSelectedCameraId: (id: string | null) => void;
  refreshCameras: () => Promise<void>;
}

export const createCameraSlice: StateCreator<AppStore, [], [], CameraSlice> = (set) => ({
  availableCameras: [],
  selectedCameraId: null,
  setAvailableCameras: (cameras) => set({ availableCameras: cameras }),
  setSelectedCameraId: (id) => set({ selectedCameraId: id }),
  refreshCameras: async () => {
    try {
      // First request permission to get labels
      await navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
        stream.getTracks().forEach(track => track.stop());
      }).catch(() => {});

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
