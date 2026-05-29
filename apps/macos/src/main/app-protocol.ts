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
 * Rules:
 *
 * - URL pathname is `decodeURIComponent`-ed once so `%2e%2e` -style
 *   bypasses get unescaped before normalization sees them.
 * - Leading slashes on the pathname are stripped so `path.join` doesn't
 *   treat the path as absolute and discard `rendererRoot`.
 * - After joining + normalizing, the resolved path must be exactly
 *   `rendererRoot` or sit inside it (`rendererRoot + sep`-prefixed).
 *   Anything else — `..` climbs, absolute-style overrides, sibling
 *   directories — returns `forbidden`.
 */
export type ResolveResult =
  | { kind: "ok"; resolved: string }
  | { kind: "forbidden" };

export const resolveAppProtocolPath = (
  rendererRoot: string,
  requestUrl: string,
): ResolveResult => {
  const url = new URL(requestUrl);
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
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
