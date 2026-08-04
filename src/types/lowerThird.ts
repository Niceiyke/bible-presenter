export interface LtPreset {
  id: string;
  label: string;
  template_id?: string;
  data: LowerThirdData;
}

export type LowerThirdData =
  | { kind: "Nameplate"; data: { name: string; title?: string } }
  | { kind: "Lyrics"; data: { line1: string; line2?: string; section_label?: string } }
  | { kind: "FreeText"; data: { text: string } };

export interface LowerThirdTemplate {
  id: string; name: string;
  bgType: "solid" | "gradient" | "transparent" | "image";
  bgColor: string; bgOpacity: number; bgGradientEnd: string; bgBlur: boolean;
  bgBlurAmount: number; bgImagePath?: string;
  accentEnabled: boolean; accentColor: string;
  accentSide: "left" | "right" | "top" | "bottom"; accentWidth: number;
  borderEnabled: boolean; borderColor: string; borderWidth: number;
  hAlign: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom";
  offsetX: number; offsetY: number;
  widthPct: number; paddingX: number; paddingY: number; borderRadius: number;
  primaryFont: string; primarySize: number; primaryColor: string;
  primaryBold: boolean; primaryItalic: boolean; primaryUppercase: boolean;
  secondaryFont: string; secondarySize: number; secondaryColor: string;
  secondaryBold: boolean; secondaryItalic: boolean; secondaryUppercase: boolean;
  labelVisible: boolean; labelColor: string; labelSize: number; labelUppercase: boolean;
  textShadow: boolean; textShadowColor: string; textShadowBlur: number;
  textOutline: boolean; textOutlineColor: string; textOutlineWidth: number;
  boxShadow: boolean; boxShadowColor: string; boxShadowBlur: number;
  animation: "fade" | "slide-up" | "slide-left" | "none";
  entryAnimation?: "fade" | "slide-up" | "slide-left" | "slide-right" | "blur-in" | "typewriter" | "none";
  exitAnimation?: "fade" | "slide-up" | "slide-left" | "slide-right" | "blur-out" | "none";
  animationDuration: number; exitDuration: number;
  variant: "classic" | "modern" | "banner";
  bannerBadgeText: string;
  scrollEnabled: boolean; scrollDirection: "ltr" | "rtl";
  scrollSpeed: number; scrollSeparator: string; scrollGap: number;
  scrollCount: number;
  autoHideSeconds: number;
  maxLines: number;
}

export const DEFAULT_LT_TEMPLATE: LowerThirdTemplate = {
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
  scrollEnabled: false, scrollDirection: "ltr", scrollSpeed: 5, scrollSeparator: "  •  ", scrollGap: 50,
  scrollCount: 0, autoHideSeconds: 0, maxLines: 0,
};
