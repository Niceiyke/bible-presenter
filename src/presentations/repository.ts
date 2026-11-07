import { invoke } from "@tauri-apps/api/core";
import type { CustomPresentation, PresentationSummary } from "../types";

/**
 * Presentation persistence boundary. UI components depend on this small API,
 * not command names, so local storage can evolve without rewriting workflows.
 */
export interface PresentationRepository {
  list(): Promise<PresentationSummary[]>;
  load(id: string): Promise<CustomPresentation>;
  save(presentation: CustomPresentation): Promise<void>;
  remove(id: string): Promise<void>;
}

export const tauriPresentationRepository: PresentationRepository = {
  list: () => invoke<PresentationSummary[]>("list_studio_presentations"),
  load: (id) => invoke<CustomPresentation>("load_studio_presentation", { id }),
  save: (presentation) => invoke("save_studio_presentation", { presentation }),
  remove: (id) => invoke("delete_studio_presentation", { id }),
};
