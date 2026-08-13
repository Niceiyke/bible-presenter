import type { UseRemote } from "./wsClient";

export interface PanelProps {
  client: UseRemote;
  pushToast: (msg: string, kind?: "error" | "info") => void;
}
