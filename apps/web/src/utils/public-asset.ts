/**
 * Resolve a path under `public/` to a URL that respects Vite's `base`
 * configuration. Required because Vite does NOT rewrite absolute `src`/`href`
 * strings in JSX/data at runtime — only HTML entry points and CSS `url()`s.
 *
 * Pass either `/foo.svg` or `foo.svg` — both forms produce `{BASE_URL}foo.svg`.
 */
export function publicAsset(path: string): string {
  const base = import.meta.env.BASE_URL;
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  return `${base}${trimmed}`;
}
