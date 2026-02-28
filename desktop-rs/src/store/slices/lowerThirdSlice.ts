import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { LowerThirdTemplate, Song } from "../../types";

export interface LowerThirdSlice {
  ltMode: "nameplate" | "lyrics" | "freetext";
  setLtMode: (v: "nameplate" | "lyrics" | "freetext") => void;
  ltVisible: boolean;
  setLtVisible: (v: boolean) => void;
  ltTemplate: LowerThirdTemplate;
  setLtTemplate: (v: LowerThirdTemplate | ((prev: LowerThirdTemplate) => LowerThirdTemplate)) => void;
  ltSavedTemplates: LowerThirdTemplate[];
  setLtSavedTemplates: (v: LowerThirdTemplate[]) => void;
  ltDesignOpen: boolean;
  setLtDesignOpen: (v: boolean) => void;
  showLtImgPicker: boolean;
  setShowLtImgPicker: (v: boolean) => void;
  ltName: string;
  setLtName: (v: string) => void;
  ltTitle: string;
  setLtTitle: (v: string) => void;
  ltFreeText: string;
  setLtFreeText: (v: string) => void;
  ltSongId: string | null;
  setLtSongId: (v: string | null) => void;
  ltLineIndex: number;
  setLtLineIndex: (v: number | ((prev: number) => number)) => void;
  ltLinesPerDisplay: 1 | 2;
  setLtLinesPerDisplay: (v: 1 | 2) => void;
  ltAutoAdvance: boolean;
  setLtAutoAdvance: (v: boolean) => void;
  ltAutoSeconds: number;
  setLtAutoSeconds: (v: number) => void;
  ltAtEnd: boolean;
  setLtAtEnd: (v: boolean) => void;
  ltPreviewBg: "dark" | "green" | "checkered";
  setLtPreviewBg: (v: "dark" | "green" | "checkered") => void;
  songs: Song[];
  setSongs: (v: Song[]) => void;
  songSearch: string;
  setSongSearch: (v: string) => void;
  editingSong: Song | null;
  setEditingSong: (v: Song | null) => void;
  songImportText: string;
  setSongImportText: (v: string) => void;
  showSongImport: boolean;
  setShowSongImport: (v: boolean) => void;
}

export const createLowerThirdSlice: StateCreator<AppStore, [], [], LowerThirdSlice> = (set) => ({
  ltMode: "nameplate",
  setLtMode: (v) => set({ ltMode: v }),
  ltVisible: false,
  setLtVisible: (v) => set({ ltVisible: v }),
  ltTemplate: {
    id: "default", name: "Default",
    bgType: "solid", bgColor: "#000000", bgOpacity: 85, bgGradientEnd: "#141428", bgBlur: false, bgBlurAmount: 8,
    accentEnabled: true, accentColor: "#f59e0b", accentSide: "left", accentWidth: 4,
    borderEnabled: false, borderColor: "#ffffff", borderWidth: 1,
    hAlign: "left", vAlign: "bottom", offsetX: 48, offsetY: 40,
    widthPct: 60, paddingX: 24, paddingY: 16, borderRadius: 12,
    primaryFont: "Georgia", primarySize: 36, primaryColor: "#ffffff",
    primaryBold: true, primaryItalic: false, primaryUppercase: false,
    secondaryFont: "Arial", secondarySize: 22, secondaryColor: "#f59e0b",
    secondaryBold: false, secondaryItalic: false, secondaryUppercase: false,
    labelVisible: true, labelColor: "#f59e0b", labelSize: 13, labelUppercase: true,
    textShadow: true, textShadowColor: "rgba(0,0,0,0.8)", textShadowBlur: 4,
    textOutline: false, textOutlineColor: "#000000", textOutlineWidth: 1,
    boxShadow: false, boxShadowColor: "rgba(0,0,0,0.5)", boxShadowBlur: 20,
    animation: "slide-up", animationDuration: 0.5, exitDuration: 0.2,
    variant: "classic", bannerBadgeText: "LIVE",
    scrollEnabled: false, scrollDirection: "rtl", scrollSpeed: 5, scrollSeparator: "  •  ",
    scrollGap: 50, maxLines: 0,
  },
  setLtTemplate: (v) => set((s) => ({ ltTemplate: typeof v === "function" ? v(s.ltTemplate) : v })),
  ltSavedTemplates: [],
  setLtSavedTemplates: (v) => set({ ltSavedTemplates: v }),
  ltDesignOpen: false,
  setLtDesignOpen: (v) => set({ ltDesignOpen: v }),
  showLtImgPicker: false,
  setShowLtImgPicker: (v) => set({ showLtImgPicker: v }),
  ltName: "",
  setLtName: (v) => set({ ltName: v }),
  ltTitle: "",
  setLtTitle: (v) => set({ ltTitle: v }),
  ltFreeText: "",
  setLtFreeText: (v) => set({ ltFreeText: v }),
  ltSongId: null,
  setLtSongId: (v) => set({ ltSongId: v }),
  ltLineIndex: 0,
  setLtLineIndex: (v) => set((s) => ({ ltLineIndex: typeof v === "function" ? v(s.ltLineIndex) : v })),
  ltLinesPerDisplay: 2,
  setLtLinesPerDisplay: (v: 1 | 2) => set({ ltLinesPerDisplay: v }),
  ltAutoAdvance: false,
  setLtAutoAdvance: (v) => set({ ltAutoAdvance: v }),
  ltAutoSeconds: 4,
  setLtAutoSeconds: (v) => set({ ltAutoSeconds: v }),
  ltAtEnd: false,
  setLtAtEnd: (v) => set({ ltAtEnd: v }),
  ltPreviewBg: "dark",
  setLtPreviewBg: (v) => set({ ltPreviewBg: v }),
  songs: [],
  setSongs: (v) => set({ songs: v }),
  songSearch: "",
  setSongSearch: (v) => set({ songSearch: v }),
  editingSong: null,
  setEditingSong: (v) => set({ editingSong: v }),
  songImportText: "",
  setSongImportText: (v) => set({ songImportText: v }),
  showSongImport: false,
  setShowSongImport: (v) => set({ showSongImport: v }),
});
