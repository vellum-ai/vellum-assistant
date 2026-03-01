/**
 * Composes an upstream URL by preserving the base URL's path prefix.
 *
 * `new URL(path, base)` discards any path component on `base` — this helper
 * extracts the base pathname, strips trailing slashes, prepends it to `path`,
 * and normalises away accidental leading double-slashes so that `new URL()`
 * never interprets the result as a network-path reference.
 */
export function buildUpstreamUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "").replace(/^\/\/+/, "/");
  const combined = basePath + path;
  return new URL(combined, base).toString();
}
