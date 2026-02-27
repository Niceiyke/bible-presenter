import { create } from "zustand";
import { createAppSlice, AppSlice } from "./slices/appSlice";
import { createLiveSlice, LiveSlice } from "./slices/liveSlice";
import { createBibleSlice, BibleSlice } from "./slices/bibleSlice";
import { createMediaSlice, MediaSlice } from "./slices/mediaSlice";
import { createStudioSlice, StudioSlice } from "./slices/studioSlice";
import { createLowerThirdSlice, LowerThirdSlice } from "./slices/lowerThirdSlice";
import { createServiceSlice, ServiceSlice } from "./slices/serviceSlice";
import { createTimerSlice, TimerSlice } from "./slices/timerSlice";
import { createSceneSlice, SceneSlice } from "./slices/sceneSlice";
import { createSessionSlice, SessionSlice } from "./slices/sessionSlice";

export type AppStore = AppSlice &
  LiveSlice &
  BibleSlice &
  MediaSlice &
  StudioSlice &
  LowerThirdSlice &
  ServiceSlice &
  TimerSlice &
  SceneSlice &
  SessionSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createAppSlice(...a),
  ...createLiveSlice(...a),
  ...createBibleSlice(...a),
  ...createMediaSlice(...a),
  ...createStudioSlice(...a),
  ...createLowerThirdSlice(...a),
  ...createServiceSlice(...a),
  ...createTimerSlice(...a),
  ...createSceneSlice(...a),
  ...createSessionSlice(...a),
}));
