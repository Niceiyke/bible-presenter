import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ltBuildLyricsPayload } from "../utils";
import { resolveSongLtTemplate, stepLtPage } from "../utils/song";
import { useLtFlatLines } from "./useLtFlatLines";

/**
 * Owns the lower-third auto-advance timer for the whole app. It used to live
 * inside LowerThirdTab, which meant auto-advance silently stopped whenever the
 * operator left that tab. The Songs runner and the Lower Third tab now toggle
 * the same store flag, and this always-mounted hook drives the pages.
 */
export function useLtAutoAdvance(): void {
  const ltFlatLines = useLtFlatLines();

  useEffect(() => {
    if (ltFlatLines.length === 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) clearInterval(timer);
      const state = useAppStore.getState();
      if (!state.ltAutoAdvance || !state.ltVisible || state.ltMode !== "lyrics") return;
      const seconds = Math.max(1, state.ltAutoSeconds || 1);
      timer = setInterval(() => {
        const current = useAppStore.getState();
        if (!current.ltAutoAdvance || !current.ltVisible || current.ltMode !== "lyrics") {
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        const next = stepLtPage(ltFlatLines, current.ltLineIndex, current.ltLinesPerDisplay, 1);
        if (next === current.ltLineIndex) {
          current.setLtAtEnd(true);
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
        current.setLtLineIndex(next);
        if (next >= ltFlatLines.length - 1) current.setLtAtEnd(true);
        const payload = ltBuildLyricsPayload(ltFlatLines, next, current.ltLinesPerDisplay);
        if (!payload) return;
        const template = resolveSongLtTemplate(
          current.ltSongId,
          current.songs,
          current.ltSavedTemplates,
          current.ltTemplate,
        );
        invoke("show_lower_third", { data: payload, template })
          .catch((err: any) => current.setBackendError(`Overlay update failed: ${err?.message ?? err}`));
      }, seconds * 1000);
    };

    // Re-evaluate immediately when any input changes; the store subscription
    // is intentionally shallow because the timer reads fresh state on each
    // tick anyway.
    start();
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.ltAutoAdvance !== previous.ltAutoAdvance ||
        state.ltVisible !== previous.ltVisible ||
        state.ltMode !== previous.ltMode ||
        state.ltAutoSeconds !== previous.ltAutoSeconds ||
        state.ltLinesPerDisplay !== previous.ltLinesPerDisplay ||
        state.ltSongId !== previous.ltSongId
      ) {
        start();
      }
    });

    return () => {
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, [ltFlatLines]);
}
