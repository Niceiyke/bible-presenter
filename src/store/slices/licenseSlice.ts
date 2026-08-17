import { StateCreator } from "zustand";
import { AppStore } from "../index";
import type { LicenseInfo } from "../../types/license";

export interface LicenseSlice {
  /** Current license snapshot from the backend, or null before hydration. */
  license: LicenseInfo | null;
  setLicense: (v: LicenseInfo | null) => void;
}

export const createLicenseSlice: StateCreator<AppStore, [], [], LicenseSlice> = (set) => ({
  license: null,
  setLicense: (v) => set({ license: v }),
});