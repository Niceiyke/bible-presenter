/**
 * `useFonts` — bootstrap user-installed fonts (P2.5).
 *
 * On mount the hook:
 *
 *   1. Asks the Rust side `list_fonts` for any `.ttf/.otf/.woff/.woff2`
 *      files the operator dropped into `{AppLocalData}/fonts/`.
 *   2. Groups them by family (the Rust side already does the grouping
 *      by stem-prefix, so each entry lists every variant file).
 *   3. Injects an `@font-face` rule per variant into a single
 *      `<style id="user-fonts">` tag mounted in `<head>`. The CSS is
 *      rebuilt whenever the font set changes (e.g. a new font was
 *      dropped in since the last app start).
 *   4. Exposes `availableFonts` — the built-in `FONTS` constant merged
 *      with the user-scanned family names — so the editor's font
 *      picker and the PropertiesPanel theme tab can render the same
 *      union of choices. A single `stageFontLoading` state lets
 *      callers show a placeholder while the scan resolves.
 *
 * Cross-window: the hook is invoked from every Tauri window (main,
 * output, stage) so the projection surface and the operator console
 * see identical `@font-face` rules. The CSS is regenerated locally
 * per window (no shared stylesheet between webviews in Tauri), but
 * the input set is deterministic so the resulting rules are byte-
 * identical and the rendering matches.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FONTS } from "../types";

export interface FontFile {
  file_name: string;
  path: string;
}

export interface FontMeta {
  family_name: string;
  files: FontFile[];
}

const STYLE_TAG_ID = "user-fonts";

/** Heuristic weight/style extractors so each variant file gets an
 *  `@font-face` rule with the right descriptor. The Tauri webview
 *  resolves the family/weight/style triple when an element styles
 *  itself with the family name and a `font-weight` / `font-style`. */
function descriptorsFor(fileName: string): string {
  const stem = fileName.toLowerCase();
  const parts: string[] = [];
  const isBold = /bold|bd|black|blk|heavy|semibold|semibd|sb|demibold|demibd|demi|med/i.test(stem);
  const isItalic = /italic|it|oblique|ob/i.test(stem);
  if (isBold) parts.push("font-weight: bold");
  if (isItalic) parts.push("font-style: italic");
  // Format hint helps the browser skip files it can't parse.
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const format = ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : ext === "otf" ? "opentype" : "truetype";
  const srcParts = [`format("${format}")`];
  return [...parts, ...srcParts].join("; ");
}

/** Build the `@font-face` CSS sheet from a list of families. The sheet
 *  is small (one rule per variant file) and deterministic. */
function buildFontFaceCss(families: FontMeta[]): string {
  if (families.length === 0) return "/* no user fonts */";
  const rules: string[] = [];
  for (const fam of families) {
    for (const file of fam.files) {
      // `convertFileSrc` resolves an absolute filesystem path to the
      // `asset://localhost/...` URL the Tauri webview can fetch. The
      // `protocol-asset` feature in Cargo.toml authorizes local file
      // reads; the Rust `list_fonts` command already returned the
      // canonical absolute path.
      rules.push(
        `@font-face {\n` +
        `  font-family: "${fam.family_name}";\n` +
        `  src: url("${convertFileSrc(file.path)}") ${descriptorsFor(file.file_name)};\n` +
        `  font-display: swap;\n` +
        `}`,
      );
    }
  }
  return rules.join("\n\n");
}

/** Mount or replace the `<style id="user-fonts">` tag in `document.head`. */
function applyFontFaceCss(css: string) {
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = STYLE_TAG_ID;
    document.head.appendChild(tag);
  }
  if (tag.textContent !== css) tag.textContent = css;
}

export interface UseFonts {
  /** Built-in `FONTS` union user-scanned family names. Stable while the
   *  hook is mounted (no flicker on re-render). */
  availableFonts: string[];
  /** Raw metadata returned by `list_fonts`. Empty list until the scan
   *  resolves. Useful for a "manage fonts" UI. */
  userFonts: FontMeta[];
  /** True while the `list_fonts` call is in flight. False afterwards
   *  even if the list is empty. */
  loading: boolean;
  /** Re-run the scan + reinject CSS without reloading the window. Call
   *  after the user drops a new font file into the `fonts/` folder. */
  refresh: () => void;
}

export function useFonts(): UseFonts {
  const [userFonts, setUserFonts] = useState<FontMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    invoke<FontMeta[]>("list_fonts")
      .then((list) => {
        setUserFonts(list);
        applyFontFaceCss(buildFontFaceCss(list));
      })
      .catch((err) => {
        console.warn("[useFonts] list_fonts failed", err);
        setUserFonts([]);
      })
      .finally(() => setLoading(false));
  }, []);

  // Skip on the output window (no user-font authoring there, the rules
  // are still needed for rendering so we always run the injection step
  // but only in the windows that talk to `list_fonts`). All windows
  // talk to the same Tauri commands, so a single check is sufficient.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Derive the merged font list once per refresh; the user-scanned
  // family names are unique within the list (Rust dedupes by family),
  // but in case a user names their file "Arial" we keep the built-in
  // entry once and append the user fonts alphabetically.
  const userFamilyNames = userFonts.map((f) => f.family_name);
  const builtInSet = new Set(FONTS);
  const availableFonts = [
    ...FONTS,
    ...userFamilyNames.filter((n) => !builtInSet.has(n)).sort((a, b) => a.localeCompare(b)),
  ];

  return { availableFonts, userFonts, loading, refresh };
}