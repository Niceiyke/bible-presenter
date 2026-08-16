import { create } from "zustand";
import { createAppSlice, AppSlice } from "./slices/appSlice";
import { createLiveSlice, LiveSlice } from "./slices/liveSlice";
import { createBibleSlice, BibleSlice } from "./slices/bibleSlice";
import { createMediaSlice, MediaSlice } from "./slices/mediaSlice";
import { createLowerThirdSlice, LowerThirdSlice } from "./slices/lowerThirdSlice";
import { createServiceSlice, ServiceSlice } from "./slices/serviceSlice";
import { createCameraSlice, CameraSlice } from "./slices/cameraSlice";
import { createOutputSlice, OutputSlice } from "./slices/outputSlice";

export type AppStore = AppSlice &
  LiveSlice &
  BibleSlice &
  MediaSlice &
  LowerThirdSlice &
  ServiceSlice &
  CameraSlice &
  OutputSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createAppSlice(...a),
  ...createLiveSlice(...a),
  ...createBibleSlice(...a),
  ...createMediaSlice(...a),
  ...createLowerThirdSlice(...a),
  ...createServiceSlice(...a),
  ...createCameraSlice(...a),
  ...createOutputSlice(...a),
}));
