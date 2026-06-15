import path from "node:path";

/**
 * Path-traversal guard for the `app://` protocol handler. Given the
 * renderer-root directory and a request URL, returns either the
 * normalized absolute path to serve, or a sentinel telling the caller
 * to respond with 403.
 *
 * Lives in its own file so tests don't have to import `src/main/index.ts`
 * (which evaluates the full lifecycle wiring at module load) just to
 * exercise URL parsing. Pure: no Electron, no filesystem, no I/O.
 *
 * Implementation is split in two so the guard itself is directly
 * testable:
 *
 *   - `resolveAppProtocolPath` is the public entry point. It parses
 *     the URL, decodes the pathname, and delegates to
 *     `resolveRelativePath` for the actual guard. Malformed
 *     percent-encoding (e.g. `%ZZ`) throws `URIError` out of
 *     `decodeURIComponent`; we catch and convert to `forbidden` so
 *     `protocol.handle` returns a clean 403 instead of a 500.
 *
 *   - `resolveRelativePath` is the predicate the URL-agnostic guard
 *     is built from. Exported so tests can probe the
 *     `startsWith(rendererRoot + sep)` invariant directly with
 *     synthetic inputs (e.g. `../renderer-evil/x`) the URL parser
 *     would otherwise normalize away.
 *
 * Rules `resolveRelativePath` enforces:
 *
 * - The relative path is joined onto `rendererRoot` and normalized.
 * - The resolved path must be exactly `rendererRoot` or sit inside it
 *   (`rendererRoot + sep`-prefixed). Anything else — `..` climbs
 *   surviving normalization, absolute-path overrides, sibling
 *   directories — returns `forbidden`.
 */
export type ResolveResult =
  | { kind: "ok"; resolved: string }
  | { kind: "forbidden" };

export const resolveRelativePath = (
  rendererRoot: string,
  relativePath: string,
): ResolveResult => {
  const resolved = path.normalize(path.join(rendererRoot, relativePath));
  const rendererRootWithSep = rendererRoot + path.sep;
  if (
    resolved !== rendererRoot &&
    !resolved.startsWith(rendererRootWithSep)
  ) {
    return { kind: "forbidden" };
  }
  return { kind: "ok", resolved };
};

export const resolveAppProtocolPath = (
  rendererRoot: string,
  requestUrl: string,
  mountPrefix?: string,
): ResolveResult => {
  const url = new URL(requestUrl);
  // `apps/web/vite.config.ts` sets `base: "/assistant/"`, so the
  // built HTML references assets under `/assistant/assets/...`. The
  // renderer files on disk live directly under `rendererRoot` — they
  // are NOT nested in a `/assistant/` subdirectory. Stripping the
  // mount prefix here maps `/assistant/<rest>` requests to
  // `rendererRoot/<rest>`. A `mountPrefix` of `"/assistant"` matches
  // both the bare `/assistant` (mapped to the root) and
  // `/assistant/<rest>` paths; other top-level requests pass
  // through untouched (and 404 or land in `forbidden`).
  let pathname = url.pathname;
  if (mountPrefix) {
    if (pathname === mountPrefix) {
      pathname = "/";
    } else if (pathname.startsWith(`${mountPrefix}/`)) {
      pathname = pathname.slice(mountPrefix.length);
    }
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    // Malformed percent-encoding (e.g. `%ZZ`) throws `URIError`.
    // Convert to `forbidden` so the protocol handler returns a clean
    // 403 instead of a 500 from an uncaught error.
    return { kind: "forbidden" };
  }
  return resolveRelativePath(rendererRoot, relativePath);
};
