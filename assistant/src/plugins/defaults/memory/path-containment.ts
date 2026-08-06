/**
 * Path-containment predicate shared by the plugin modules that gate filesystem
 * access to a workspace-owned root (the prompt-override loader and the
 * context-search sources).
 *
 * Callers must pass paths with symlinks already resolved (realpaths) on both
 * sides — otherwise a symlinked directory component can alias out of the root.
 */
import { isAbsolute, relative, sep } from "node:path";

/** True when `pathToCheck` is `rootRealPath` itself or a descendant of it. */
export function isPathInsideRoot(
  pathToCheck: string,
  rootRealPath: string,
): boolean {
  const rel = relative(rootRealPath, pathToCheck);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
