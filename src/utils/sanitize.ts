/**
 * HTML sanitization bridge for slide text content.
 *
 * P1.7 of the slide-modernization plan. Phase 1 keeps using HTML strings
 * for `TextElement.content` (Phase 2 will swap to ProseMirror JSON). To
 * eliminate the XSS surface on the projection window, all HTML rendered
 * via `dangerouslySetInnerHTML` is passed through `sanitizeSlideHtml`,
 * which uses a strict DOM allowlist and discards everything else.
 *
 * Allowed tags: `p, br, span, b, strong, i, em, u, h1, h2, h3, ul, ol, li`.
 * Allowed attributes: `style` (with a property allowlist), `class` (only
 * `tiptap-rendered-content`). Inline event handlers, `href`, `src`, `srcdoc`,
 * `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, etc. are stripped.
 */

const ALLOWED_TAGS = new Set([
  "P", "BR", "SPAN",
  "B", "STRONG", "I", "EM", "U",
  "H1", "H2", "H3",
  "UL", "OL", "LI",
]);

const ALLOWED_STYLE_PROPS = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-align",
  "text-decoration",
  "background-color",
  "line-height",
  "letter-spacing",
  "margin",
  "padding",
]);

const ALLOWED_CLASS_VALUES = new Set(["tiptap-rendered-content"]);

/**
 * Sanitize an HTML string for safe rendering inside the projection
 * window. Returns an empty string for non-string input.
 */
export function sanitizeSlideHtml(input: string): string {
  if (!input || typeof input !== "string") return "";
  // Fast path: plain text (no `<`) is safe.
  if (!input.includes("<")) return input;

  const parser = new DOMParser();
  const doc = parser.parseFromString(input, "text/html");
  const fragment = doc.createDocumentFragment();

  // Walk the body's children, sanitizing each into the fragment.
  for (const node of Array.from(doc.body.childNodes)) {
    fragment.appendChild(sanitizeNode(node));
  }

  const container = doc.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

function sanitizeNode(node: Node): Node {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.cloneNode(true);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    // Comments, processing instructions, CDATA — drop entirely.
    return new Text("");
  }

  const el = node as Element;
  const tag = el.tagName.toUpperCase();

  if (!ALLOWED_TAGS.has(tag)) {
    // Keep the kid text content of disallowed tags rather than dropping
    // whole subtrees; this preserves "less than 100" style content.
    const text = new Text(el.textContent ?? "");
    return text;
  }

  const clean = el.ownerDocument!.createElement(tag.toLowerCase());

  // Whitelist attributes
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    if (name === "class") {
      if (value.split(/\s+/).some((c) => ALLOWED_CLASS_VALUES.has(c))) {
        clean.setAttribute("class", "tiptap-rendered-content");
      }
      continue;
    }

    if (name === "style") {
      const filtered = filterStyle(value);
      if (filtered) clean.setAttribute("style", filtered);
      continue;
    }

    // Drop everything else: href, src, srcdoc, onclick, on*, data-*, etc.
  }

  for (const child of Array.from(el.childNodes)) {
    clean.appendChild(sanitizeNode(child));
  }

  return clean;
}

function filterStyle(styleValue: string): string {
  return styleValue
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => {
      if (!decl) return false;
      const colon = decl.indexOf(":");
      if (colon < 0) return false;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const val = decl.slice(colon + 1).trim();
      if (!ALLOWED_STYLE_PROPS.has(prop)) return false;
      // Reject url() / expression() / javascript: in any value to be safe.
      if (/(?:url\s*\(|expression\s*\(|javascript:|behavior\s*:)/i.test(val)) return false;
      return true;
    })
    .join("; ");
}

/**
 * Strip all HTML tags and return only the plain text content. Useful for
 * computeFallbackLabels (e.g., stage-monitor summary) where the renderer
 * previously called `.filter(e => e.kind === "text").map(e => e.content).join("\n")`.
 */
export function toPlainText(input: string): string {
  if (!input || typeof input !== "string") return "";
  if (!input.includes("<")) return input;
  const parser = new DOMParser();
  return parser.parseFromString(input, "text/html").body.textContent ?? "";
}