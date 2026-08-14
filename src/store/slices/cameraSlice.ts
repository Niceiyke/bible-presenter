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
  stream?: MediaStream;
}

export interface CameraSlice {
  availableCameras: CameraDeviceInfo[];
  selectedCameraId: string | null;
  phoneCameras: PhoneCameraInfo[];
  setAvailableCameras: (cameras: CameraDeviceInfo[]) => void;
  setSelectedCameraId: (id: string | null) => void;
  addPhoneCamera: (camera: PhoneCameraInfo) => void;
  removePhoneCamera: (deviceId: string) => void;
  updatePhoneCameraStream: (deviceId: string, stream: MediaStream) => void;
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
