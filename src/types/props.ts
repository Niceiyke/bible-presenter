export interface PropItem {
  id: string;
  kind: "image" | "clock";
  path?: string; text?: string; color?: string;
  x: number; y: number; w: number; h: number;
  opacity: number; visible: boolean;
}
