import type { CustomPresentation, ProseMirrorJSON, SlideElement } from "../types";

export type PresentationIssueSeverity = "error" | "warning";

export interface PresentationIssue {
  code: "blank-slide" | "missing-source" | "unsafe-geometry" | "small-text" | "dense-text";
  severity: PresentationIssueSeverity;
  slideIndex: number;
  elementId?: string;
  message: string;
}

function proseMirrorText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  const own = typeof record.text === "string" ? record.text : "";
  const children = Array.isArray(record.content) ? record.content.map(proseMirrorText).join(" ") : "";
  return `${own} ${children}`.trim();
}

function elementText(element: SlideElement): string {
  if (element.kind !== "text") return "";
  if (typeof element.content === "string") return element.content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return proseMirrorText(element.content as ProseMirrorJSON).replace(/\s+/g, " ").trim();
}

export function analyzePresentation(presentation: CustomPresentation): PresentationIssue[] {
  const issues: PresentationIssue[] = [];

  presentation.slides.forEach((slide, slideIndex) => {
    const visible = slide.elements.filter((element) => !element.hidden && (element.opacity ?? 1) > 0);
    const backgroundProvidesContent = (slide.background.type === "image" || slide.background.type === "video") && !!slide.background.value.trim();
    if (visible.length === 0 && !backgroundProvidesContent) {
      issues.push({
        code: "blank-slide",
        severity: "warning",
        slideIndex,
        message: `Slide ${slideIndex + 1} appears blank.`,
      });
    }

    let slideTextLength = 0;
    visible.forEach((element) => {
      if ((element.kind === "image" || element.kind === "video") && !element.content.trim()) {
        issues.push({
          code: "missing-source",
          severity: "error",
          slideIndex,
          elementId: element.id,
          message: `Slide ${slideIndex + 1} has a ${element.kind} with no media source.`,
        });
      }

      if (element.x < 0 || element.y < 0 || element.w <= 0 || element.h <= 0 || element.x + element.w > 100 || element.y + element.h > 100) {
        issues.push({
          code: "unsafe-geometry",
          severity: "error",
          slideIndex,
          elementId: element.id,
          message: `Slide ${slideIndex + 1} has content outside the canvas.`,
        });
      }

      if (element.kind === "text") {
        const text = elementText(element);
        slideTextLength += text.length;
        if (typeof element.font_size === "number" && element.font_size < 20 && text.length > 0) {
          issues.push({
            code: "small-text",
            severity: "warning",
            slideIndex,
            elementId: element.id,
            message: `Slide ${slideIndex + 1} uses text smaller than 20 pt.`,
          });
        }
        if (text.length > 450) {
          issues.push({
            code: "dense-text",
            severity: "warning",
            slideIndex,
            elementId: element.id,
            message: `Slide ${slideIndex + 1} has a dense text block (${text.length} characters).`,
          });
        }
      }
    });

    if (slideTextLength > 700 && !issues.some((issue) => issue.slideIndex === slideIndex && issue.code === "dense-text")) {
      issues.push({
        code: "dense-text",
        severity: "warning",
        slideIndex,
        message: `Slide ${slideIndex + 1} may contain too much text for projection.`,
      });
    }
  });

  return issues;
}
