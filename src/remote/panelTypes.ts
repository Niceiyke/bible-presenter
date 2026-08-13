import type { UseRemote } from "./wsClient";

export interface PanelProps {
  client: UseRemote;
  pushToast: (msg: unknown, kind?: "error" | "info") => void;
}
