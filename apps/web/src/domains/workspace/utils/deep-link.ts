/**
 * Helpers for deep-linking the workspace browser to a specific entry via the
 * `?path=` search param. Paths are workspace-relative (matching the keys the
 * workspace tree/file APIs use), e.g. `scratch/figma-cli/README.md`.
 */

/**
 * Normalize a raw `?path=` value into a workspace-relative path, or `null` when
 * it is absent or empty. Strips surrounding whitespace and leading/trailing
 * slashes so `/scratch/foo/` and `scratch/foo` resolve identically.
 */
export function normalizeDeepLinkPath(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Every ancestor directory prefix of `path`, plus `path` itself, ordered
 * shallowest-first. Seeding these into the tree's expanded set reveals a nested
 * target. Expanding the target itself is harmless when it turns out to be a
 * file — the tree simply renders no children.
 *
 * `ancestorPaths("a/b/c")` → `["a", "a/b", "a/b/c"]`.
 */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter((s) => s.length > 0);
  const prefixes: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    prefixes.push(segments.slice(0, i + 1).join("/"));
  }
  return prefixes;
}
