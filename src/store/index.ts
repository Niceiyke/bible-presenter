import { create } from "zustand";
import { createAppSlice, AppSlice } from "./slices/appSlice";
import { createLiveSlice, LiveSlice } from "./slices/liveSlice";
import { createBibleSlice, BibleSlice } from "./slices/bibleSlice";
import { createMediaSlice, MediaSlice } from "./slices/mediaSlice";
import { createAudioStudioSlice, AudioStudioSlice } from "./slices/audioStudioSlice";
import { createLowerThirdSlice, LowerThirdSlice } from "./slices/lowerThirdSlice";
import { createServiceSlice, ServiceSlice } from "./slices/serviceSlice";
import { createSessionSlice, SessionSlice } from "./slices/sessionSlice";
import { createModelSlice, ModelSlice } from "./slices/modelSlice";
import { createCameraSlice, CameraSlice } from "./slices/cameraSlice";

export type AppStore = AppSlice &
  LiveSlice &
  BibleSlice &
  MediaSlice &
  AudioStudioSlice &
  LowerThirdSlice &
  ServiceSlice &
  SessionSlice &
  ModelSlice &
  CameraSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createAppSlice(...a),
  ...createLiveSlice(...a),
  ...createBibleSlice(...a),
  ...createMediaSlice(...a),
  ...createAudioStudioSlice(...a),
  ...createLowerThirdSlice(...a),
  ...createServiceSlice(...a),
  ...createSessionSlice(...a),
  ...createModelSlice(...a),
  ...createCameraSlice(...a),
}));
