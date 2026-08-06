/**
 * Brand-font bridge for sandboxed widget iframes.
 *
 * A `srcdoc` iframe without `allow-same-origin` has an opaque origin, so it
 * cannot load the app's font files by URL — a cross-origin font fetch needs
 * CORS headers the app's asset server does not send. The workable path is to
 * inline the fonts as `data:` URIs inside the widget document.
 *
 * The font URLs are discovered from the host's own `@font-face` rules rather
 * than imported by path, so the bundler's asset hashing (and any future
 * change of font format or location) is picked up automatically. The result is
 * fetched and encoded once per session and cached module-level; every widget
 * reuses the same CSS string.
 *
 * The snapshot resolves asynchronously. Callers read it through
 * {@link getWidgetFontCss} — an empty string until the fonts are ready, and
 * an empty string forever if discovery or fetching fails, in which case
 * widgets fall back to the `system-ui` tail of `--font-sans`.
 */

/** Font families inlined into widgets. Anything else the host loads is ignored. */
const WIDGET_FONT_FAMILIES = new Set(["dm sans", "dm mono", "instrument serif"]);

/** Per-file ceiling. A font larger than this is skipped rather than inlined. */
const MAX_FONT_BYTES = 400_000;

const FONT_FACE_RE = /^@font-face/i;
const URL_RE = /url\((['"]?)([^'")]+)\1\)/;

const MIME_BY_EXTENSION: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

let cachedCss = "";
let loadPromise: Promise<string> | null = null;
const listeners = new Set<() => void>();

/** The cached font CSS — empty until {@link ensureWidgetFontCss} resolves. */
export function getWidgetFontCss(): string {
  return cachedCss;
}

/** Subscribe to the one transition from "not loaded" to "loaded". */
export function subscribeWidgetFontCss(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Kick off (or join) the font snapshot. Safe to call on every widget mount —
 * the work happens once.
 */
export function ensureWidgetFontCss(): Promise<string> {
  if (!loadPromise) {
    loadPromise = loadWidgetFontCss().then((css) => {
      cachedCss = css;
      for (const listener of listeners) {
        listener();
      }
      return css;
    });
  }
  return loadPromise;
}

/** Reset the module cache. Test-only seam. */
export function resetWidgetFontCssForTests(): void {
  cachedCss = "";
  loadPromise = null;
}

function familyOf(rule: CSSStyleRule): string {
  return rule.style
    .getPropertyValue("font-family")
    .replace(/["']/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Collect the host's `@font-face` rules for the brand families. Stylesheets
 * whose rules are unreachable (cross-origin) are skipped.
 */
function collectFontFaceRules(): CSSStyleRule[] {
  if (typeof document === "undefined") {
    return [];
  }
  const rules: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let sheetRules: CSSRuleList;
    try {
      sheetRules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(sheetRules)) {
      if (!FONT_FACE_RE.test(rule.cssText)) {
        continue;
      }
      const styleRule = rule as CSSStyleRule;
      if (WIDGET_FONT_FAMILIES.has(familyOf(styleRule))) {
        rules.push(styleRule);
      }
    }
  }
  return rules;
}

function mimeForUrl(url: string): string {
  const extension = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Rewrite one `@font-face` rule's `src` URL to an inlined `data:` URI. */
async function inlineFontFace(rule: CSSStyleRule): Promise<string | null> {
  const src = rule.style.getPropertyValue("src");
  const match = URL_RE.exec(src);
  const url = match?.[2];
  if (!url) {
    return null;
  }
  if (url.startsWith("data:")) {
    return rule.cssText;
  }
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_FONT_BYTES) {
    return null;
  }
  const dataUri = `data:${mimeForUrl(url)};base64,${toBase64(buffer)}`;
  return rule.cssText.replace(match[0], `url("${dataUri}")`);
}

async function loadWidgetFontCss(): Promise<string> {
  try {
    const rules = collectFontFaceRules();
    if (rules.length === 0) {
      return "";
    }
    const inlined = await Promise.all(
      rules.map((rule) => inlineFontFace(rule).catch(() => null)),
    );
    const usable = inlined.filter((css): css is string => css !== null);
    if (usable.length === 0) {
      return "";
    }
    return `<style>${usable.join("")}</style>`;
  } catch {
    return "";
  }
}
