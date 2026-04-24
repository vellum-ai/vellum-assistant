import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import { findProjectBoundary } from "./project-boundary.js";
import type { DirectoryScopeOption } from "./risk-types.js";

/**
 * Input to {@link generateDirectoryScopeOptions}.
 */
export interface GenerateDirectoryScopeInput {
  /** Resolved path args (absolute or cwd-relative). Empty for bare cmds. */
  pathArgs: readonly string[];
  /** The invocation's working directory. */
  workingDir: string;
  /** Workspace root for containerized invocations; may equal workingDir. */
  workspaceRoot?: string;
}

/**
 * Generate the directory scope ladder for a filesystem-targeting invocation.
 *
 * Returns a narrowest-to-broadest list of {@link DirectoryScopeOption}s:
 *   1. The most specific common ancestor of all path args (or `workingDir`
 *      when no path args are provided), rendered as `${ancestor}/*`.
 *   2. The nearest project boundary above that ancestor (found via
 *      {@link findProjectBoundary}), when distinct from the ancestor and the
 *      workspace root.
 *   3. The sentinel `"everywhere"` option.
 *
 * Pure except for the filesystem reads performed by `findProjectBoundary`.
 * Does not mutate its inputs.
 */
export function generateDirectoryScopeOptions(
  input: GenerateDirectoryScopeInput,
): DirectoryScopeOption[] {
  const { pathArgs, workingDir, workspaceRoot } = input;

  // The "exact dir" ancestor is the most specific common ancestor of the
  // target paths.
  //   - Empty pathArgs: treat `workingDir` itself as the ancestor. Taking
  //     `dirname(workingDir)` here would widen the scope to the parent of the
  //     cwd, which is not what users expect from a bare command like `ls`.
  //   - Single pathArg: resolve it. If it's an existing directory, use it as
  //     the ancestor directly; otherwise (file path or missing) fall back to
  //     `dirname`.
  //   - Multiple pathArgs: resolve, dedupe, and walk the shared segment prefix.
  //     If the shared prefix is an existing directory, keep it; otherwise
  //     `dirname` the prefix to drop any partial-filename component.
  let ancestor: string;
  if (pathArgs.length === 0) {
    ancestor = workingDir;
  } else {
    const resolvedTargets = pathArgs.map((p) => resolvePath(p, workingDir));
    ancestor = commonAncestor(resolvedTargets);
  }

  const options: DirectoryScopeOption[] = [];
  const seenScopes = new Set<string>();
  const push = (option: DirectoryScopeOption): void => {
    if (seenScopes.has(option.scope)) return;
    seenScopes.add(option.scope);
    options.push(option);
  };

  // Option 1 — exact dir. Skip when the ancestor collapsed to the fs root,
  // the user's home directory or a strict ancestor of it (e.g. `/home`,
  // `/Users`), or a path shallower than the workspace root.
  const home = homedir();
  const skipExact =
    ancestor === sep ||
    ancestor === home ||
    isWithin(home, ancestor) ||
    (workspaceRoot !== undefined && !isWithin(ancestor, workspaceRoot));
  if (!skipExact) {
    push({
      scope: `${ancestor}${sep}*`,
      label: `In ${basename(ancestor)}/`,
    });
  }

  // Option 2 — nearest project boundary above the ancestor. Only emit if the
  // ancestor is itself inside the workspaceRoot (otherwise the boundary walk
  // can escape the cap and return an unrelated project) and the boundary
  // differs from both the ancestor itself and the workspace root.
  if (workspaceRoot === undefined || isWithin(ancestor, workspaceRoot)) {
    const boundary = findProjectBoundary(ancestor, workspaceRoot);
    if (
      boundary !== undefined &&
      boundary !== ancestor &&
      boundary !== workspaceRoot
    ) {
      push({
        scope: `${boundary}${sep}*`,
        label: `In ${basename(boundary)}/`,
      });
    }
  }

  // Option 3 — always-emit sentinel.
  push({ scope: "everywhere", label: "Everywhere" });

  return options;
}

/**
 * Resolve a single path arg against the working directory, expanding a
 * leading `~` to the user's home directory.
 */
function resolvePath(path: string, workingDir: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) {
    return resolve(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) return resolve(path);
  return resolve(workingDir, path);
}

/**
 * Compute the most specific common ancestor directory of a non-empty list of
 * absolute paths.
 *
 * For a single path, the result is the path itself when it resolves to an
 * existing directory (so `ls src` where `src/` is a dir scopes to `src/*`,
 * not `<parent>/*`) and its `dirname` otherwise (file path or missing —
 * best-effort fallback). For multiple paths it is the deepest directory
 * whose path is a prefix of every input; if that prefix is not an existing
 * directory we `dirname` it to drop any partial-filename component (e.g.
 * `/a/b/src` vs `/a/b/style` share the prefix `/a/b/s`, which is not a real
 * directory, so we return `/a/b`).
 *
 * Duplicate paths are collapsed first so that `[p, p]` behaves identically
 * to `[p]` — otherwise the multi-path branch's segment-prefix walk would
 * return the full path (a file), not its dirname.
 */
function commonAncestor(paths: string[]): string {
  const unique = [...new Set(paths)];
  if (unique.length === 1) {
    const only = unique[0]!;
    return pathIsExistingDirectory(only) ? only : dirname(only);
  }

  // Split each path into its segments. An absolute POSIX path like
  // "/a/b/c" splits as ["", "a", "b", "c"]; the leading empty segment
  // represents the filesystem root and is preserved so we can rejoin it
  // correctly below.
  const splits = unique.map((p) => p.split(sep));
  const minLen = Math.min(...splits.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const segment = splits[0]![i]!;
    if (splits.every((s) => s[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }

  // Nothing in common → fs root (POSIX) or empty (pathological). We return
  // the root separator so upstream skip-checks can detect it.
  if (common.length === 0) return sep;
  // Only the leading empty segment survived → the shared prefix is the root.
  if (common.length === 1 && common[0] === "") return sep;

  const joined = common.join(sep);
  const prefix = joined === "" ? sep : joined;
  // If the common prefix is already a real directory (e.g. `cp -r src dst`
  // sharing `/a/b` as their prefix), keep it. Otherwise it's likely a
  // partial filename — drop the last segment.
  return pathIsExistingDirectory(prefix) ? prefix : dirname(prefix);
}

/**
 * Best-effort sync check whether a path refers to an existing directory.
 * Swallows all errors (most importantly ENOENT for paths that don't exist
 * and EACCES for paths we can't stat) and returns false — callers then fall
 * back to the file-path dirname heuristic.
 */
function pathIsExistingDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return true when `candidate` is equal to or nested under `root`.
 */
function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}
