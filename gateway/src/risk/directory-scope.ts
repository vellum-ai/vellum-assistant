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

  // Resolve every path arg to an absolute path (expanding `~` and joining
  // relative paths against workingDir). If none were provided, fall back to
  // the working directory as the single target.
  const resolvedTargets =
    pathArgs.length === 0
      ? [workingDir]
      : pathArgs.map((p) => resolvePath(p, workingDir));

  // The "exact dir" ancestor is the most specific common ancestor of the
  // target paths. For a single target we use its dirname; for multiple we
  // walk down the shared path-segment prefix.
  const ancestor = commonAncestor(resolvedTargets);

  const options: DirectoryScopeOption[] = [];
  const seenScopes = new Set<string>();
  const push = (option: DirectoryScopeOption): void => {
    if (seenScopes.has(option.scope)) return;
    seenScopes.add(option.scope);
    options.push(option);
  };

  // Option 1 — exact dir. Skip when the ancestor collapsed to the fs root,
  // the user's home directory, or a path shallower than the workspace root.
  const home = homedir();
  const skipExact =
    ancestor === sep ||
    ancestor === home ||
    (workspaceRoot !== undefined && !isWithin(ancestor, workspaceRoot));
  if (!skipExact) {
    push({
      scope: `${ancestor}${sep}*`,
      label: `In ${basename(ancestor)}/`,
    });
  }

  // Option 2 — nearest project boundary above the ancestor. Only emit if the
  // boundary differs from both the ancestor itself and the workspace root.
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
 * absolute paths. For a single path this is its `dirname`; for multiple it
 * is the deepest directory whose path is a prefix of every input.
 */
function commonAncestor(paths: string[]): string {
  if (paths.length === 1) {
    return dirname(paths[0]!);
  }

  // Split each path into its segments. An absolute POSIX path like
  // "/a/b/c" splits as ["", "a", "b", "c"]; the leading empty segment
  // represents the filesystem root and is preserved so we can rejoin it
  // correctly below.
  const splits = paths.map((p) => p.split(sep));
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
  return joined === "" ? sep : joined;
}

/**
 * Return true when `candidate` is equal to or nested under `root`.
 */
function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}
