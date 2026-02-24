/**
 * pptxParser.ts
 *
 * Parses .pptx files in-browser using jszip + DOMParser.
 * PPTX is a ZIP archive of OpenXML files. This module extracts:
 *   - Slide background color
 *   - Text boxes (with basic font size, color, bold)
 *   - Embedded images (as base64 data: URLs)
 */

import JSZip from "jszip";
import { convertFileSrc } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// XML namespace constants
// ---------------------------------------------------------------------------

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TextBox {
  text: string;
  fontSize: number | null; // in points
  color: string | null;    // CSS hex string e.g. "#ffffff"
  bold: boolean;
}

export interface EmbeddedImage {
  dataUrl: string;  // data:<mime>;base64,<data>
  mimeType: string;
}

export interface ParsedSlide {
  index: number;
  backgroundColor: string | null; // CSS hex or null
  textBoxes: TextBox[];
  images: EmbeddedImage[];
}

export interface ParsedPresentation {
  slideCount: number;
  slides: ParsedSlide[];
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Loads the zip object for a PPTX file from an absolute OS path.
 * Cache the returned zip to avoid re-downloading for subsequent slide parses.
 */
export async function loadPptxZip(pptxPath: string): Promise<JSZip> {
  const url = convertFileSrc(pptxPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch PPTX (${response.status}): ${pptxPath}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return JSZip.loadAsync(arrayBuffer);
}

/**
 * Returns the number of slides in the zip without parsing slide content.
 */
export async function getSlideCount(zip: JSZip): Promise<number> {
  return Object.keys(zip.files).filter(name =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name)
  ).length;
}

/**
 * Parses a single slide by zero-based index.
 * Pass in the zip (from loadPptxZip) to avoid re-parsing the archive.
 */
export async function parseSingleSlide(
  zip: JSZip,
  slideIndex: number
): Promise<ParsedSlide> {
  const slideNumber = slideIndex + 1;
  const slideXmlPath = `ppt/slides/slide${slideNumber}.xml`;
  const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;

  const slideXmlStr = await zip.file(slideXmlPath)?.async("string");
  if (!slideXmlStr) {
    throw new Error(`Slide ${slideNumber} not found in PPTX`);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(slideXmlStr, "application/xml");

  // ── Background color ─────────────────────────────────────────────────────
  let backgroundColor: string | null = null;
  const bgPrEls = doc.getElementsByTagNameNS(NS_P, "bgPr");
  if (bgPrEls.length > 0) {
    const bgPr = bgPrEls[0];
    // Try <a:solidFill><a:srgbClr val="xxxxxx"/>
    const solidFills = bgPr.getElementsByTagNameNS(NS_A, "solidFill");
    if (solidFills.length > 0) {
      const srgbClr = solidFills[0].getElementsByTagNameNS(NS_A, "srgbClr")[0];
      if (srgbClr) {
        const val = srgbClr.getAttribute("val");
        if (val) backgroundColor = `#${val}`;
      }
    }
  }

  // ── Text boxes ───────────────────────────────────────────────────────────
  const textBoxes: TextBox[] = [];
  const shapes = doc.getElementsByTagNameNS(NS_P, "sp");

  for (const sp of Array.from(shapes)) {
    const txBodyEls = sp.getElementsByTagNameNS(NS_P, "txBody");
    if (txBodyEls.length === 0) continue;
    const txBody = txBodyEls[0];

    // Collect all paragraphs, joining with newline
    const paragraphs = txBody.getElementsByTagNameNS(NS_A, "p");
    const lines: string[] = [];
    let fontSize: number | null = null;
    let color: string | null = null;
    let bold = false;

    for (const para of Array.from(paragraphs)) {
      let line = "";
      const runs = para.getElementsByTagNameNS(NS_A, "r");
      for (const run of Array.from(runs)) {
        const tEl = run.getElementsByTagNameNS(NS_A, "t")[0];
        if (!tEl?.textContent) continue;
        line += tEl.textContent;

        // Extract run properties (first run wins for style)
        if (fontSize === null || color === null) {
          const rPr = run.getElementsByTagNameNS(NS_A, "rPr")[0];
          if (rPr) {
            if (fontSize === null) {
              const sz = rPr.getAttribute("sz");
              if (sz) fontSize = parseInt(sz, 10) / 100; // hundredths of a point → points
            }
            if (!bold) {
              bold = rPr.getAttribute("b") === "1" || rPr.getAttribute("b") === "true";
            }
            if (color === null) {
              const solidFill = rPr.getElementsByTagNameNS(NS_A, "solidFill")[0];
              if (solidFill) {
                const srgb = solidFill.getElementsByTagNameNS(NS_A, "srgbClr")[0];
                if (srgb) {
                  const val = srgb.getAttribute("val");
                  if (val) color = `#${val}`;
                }
              }
            }
          }
        }
      }
      if (line) lines.push(line);
    }

    const text = lines.join("\n");
    if (text.trim()) {
      textBoxes.push({ text, fontSize, color, bold });
    }
  }

  // ── Embedded images ──────────────────────────────────────────────────────
  const images: EmbeddedImage[] = [];
  const relsXmlStr = await zip.file(relsPath)?.async("string");

  if (relsXmlStr) {
    const relsDoc = parser.parseFromString(relsXmlStr, "application/xml");
    // Build map: rId → media path inside the zip
    const imgRels: Record<string, string> = {};
    const relationships = relsDoc.getElementsByTagName("Relationship");
    for (const rel of Array.from(relationships)) {
      const type = rel.getAttribute("Type") ?? "";
      if (!type.includes("/image")) continue;
      const rId = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (!rId || !target) continue;
      // Target is like "../media/image1.png" — resolve relative to ppt/slides/
      const mediaPath = `ppt/${target.replace(/^\.\.\//, "")}`;
      imgRels[rId] = mediaPath;
    }

    // Find <p:pic> elements and load their images
    const picElements = doc.getElementsByTagNameNS(NS_P, "pic");
    for (const pic of Array.from(picElements)) {
      const blipFillEls = pic.getElementsByTagNameNS(NS_P, "blipFill");
      if (blipFillEls.length === 0) continue;
      const blipEl = blipFillEls[0].getElementsByTagNameNS(NS_A, "blip")[0];
      if (!blipEl) continue;
      const rEmbed = blipEl.getAttributeNS(NS_R, "embed");
      if (!rEmbed || !imgRels[rEmbed]) continue;

      const mediaPath = imgRels[rEmbed];
      const imgFile = zip.file(mediaPath);
      if (!imgFile) continue;

      const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeType =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "svg" ? "image/svg+xml"
        : ext === "webp" ? "image/webp"
        : "image/png";

      const base64 = await imgFile.async("base64");
      images.push({ dataUrl: `data:${mimeType};base64,${base64}`, mimeType });
    }
  }

  return { index: slideIndex, backgroundColor, textBoxes, images };
}

/**
 * Parses all slides in a PPTX file eagerly.
 * For large decks use loadPptxZip + parseSingleSlide lazily instead.
 */
export async function parsePptx(pptxPath: string): Promise<ParsedPresentation> {
  const zip = await loadPptxZip(pptxPath);
  const slideCount = await getSlideCount(zip);
  const slides: ParsedSlide[] = [];
  for (let i = 0; i < slideCount; i++) {
    slides.push(await parseSingleSlide(zip, i));
  }
  return { slideCount, slides };
}
