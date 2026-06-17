/**
 * Lazy-chunk fetch failure detection.
 *
 * Browsers expose dynamic-import (`import("…")`) rejection with a few
 * different shapes depending on what went wrong: a 404 / abort / network
 * drop on Vite is typically a `TypeError` with one of the messages
 * below; Webpack-emitted bundles surface `ChunkLoadError`. We need to
 * tell these apart from real render bugs so we can:
 *
 *   - Render a smaller "section couldn't load, reload" UI instead of
 *     the full-page "Something went wrong" treatment used for genuine
 *     render failures.
 *   - Tag Sentry events so chunk-fetch noise is sliceable.
 *
 * Single source of truth for the predicate so route-level and
 * component-level boundaries agree.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  const msg = error.message;
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Loading chunk")
  );
}
