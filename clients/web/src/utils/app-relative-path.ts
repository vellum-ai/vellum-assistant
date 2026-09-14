/**
 * Base only used to resolve a candidate in-app path the way an anchor would;
 * a `.invalid` host so the value can never coincide with a real origin.
 */
const APP_PATH_PROBE_ORIGIN = "https://work-result-item.invalid";

/**
 * Whether `href` stays on this origin when the browser resolves it as an
 * anchor target. Resolving is the check, not a prefix test, because a
 * middle-click or copy-link reads the raw attribute: `//host/x`, the spec's
 * backslash form `/\host/x`, and `/<tab>/host/x` (the parser strips tabs and
 * newlines before it looks for an authority) all leave the origin, and every
 * other normalization the parser applies is covered the same way.
 */
export function isAppRelativePath(href: string): boolean {
  if (!href.startsWith("/")) {
    return false;
  }
  try {
    return (
      new URL(href, APP_PATH_PROBE_ORIGIN).origin === APP_PATH_PROBE_ORIGIN
    );
  } catch {
    // The parser rejected it (e.g. `//[` has an invalid host), which is the
    // verdict itself: something a browser cannot resolve is not a link.
    return false;
  }
}
