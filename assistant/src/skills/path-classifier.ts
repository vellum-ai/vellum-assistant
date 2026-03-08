import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve, sep } from "node:path";

import { getBundledSkillsDir } from "../config/skills.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";

/**
 * Returns the managed skills root directory. Managed skills are user-installed
 * skills that live under ~/.vellum/workspace/skills.
 */
export function getManagedSkillsRoot(): string {
  return normalizeDirPath(getWorkspaceSkillsDir());
}

/**
 * Returns the bundled skills root directory. Bundled skills ship with the
 * application binary and are read-only.
 */
export function getBundledSkillsRoot(): string {
  return normalizeDirPath(getBundledSkillsDir());
}

/**
 * Normalizes a directory path to a canonical form suitable for prefix
 * comparison. Resolves relative segments and ensures a trailing separator
 * so that "/foo/bar" won't false-match "/foo/barbaz".
 *
 * When the path exists on disk, realpath is used to resolve symlinks.
 * Otherwise resolve() is used for pure lexical normalization.
 */
export function normalizeDirPath(dirPath: string): string {
  // If the path exists, resolve symlinks directly
  if (existsSync(dirPath)) {
    const resolved = realpathSync(dirPath);
    const normalized = normalize(resolved);
    return normalized.endsWith(sep) ? normalized : normalized + sep;
  }

  // Walk up to find the nearest existing ancestor and resolve through it
  // (mirrors normalizeFilePath behavior for consistency)
  const absPath = resolve(dirPath);
  const segments: string[] = [];
  let current = absPath;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      const realBase = realpathSync(current);
      const tail = segments.reduceRight((acc, seg) => acc + sep + seg, "");
      const full = normalize(realBase + tail);
      return full.endsWith(sep) ? full : full + sep;
    }
    segments.push(basename(current));
    current = dirname(current);
  }

  // Nothing on the path exists — fall back to pure lexical resolution
  const normalized = normalize(absPath);
  return normalized.endsWith(sep) ? normalized : normalized + sep;
}

/**
 * Normalizes an absolute file path for comparison. Resolves symlinks
 * through the nearest existing ancestor so that a symlinked parent
 * directory is detected even when the leaf file doesn't exist yet.
 */
export function normalizeFilePath(filePath: string): string {
  if (existsSync(filePath)) {
    return realpathSync(filePath);
  }

  // Walk up until we find an ancestor that exists on disk, resolve it,
  // then re-append the tail segments. This catches symlinked parent dirs.
  const resolved = resolve(filePath);
  const segments: string[] = [];
  let current = resolved;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      const realBase = realpathSync(current);
      return segments.reduceRight((acc, seg) => acc + sep + seg, realBase);
    }
    segments.push(basename(current));
    current = dirname(current);
  }

  // Nothing on the path exists — fall back to pure lexical resolution
  return resolved;
}

/**
 * Returns all known skill root directories as normalized paths with trailing
 * separators. Additional roots (e.g. workspace-local skill directories) can
 * be passed via the `extraRoots` parameter.
 */
export function getSkillRoots(extraRoots?: string[]): string[] {
  const roots = [getManagedSkillsRoot(), getBundledSkillsRoot()];
  if (extraRoots) {
    for (const root of extraRoots) {
      roots.push(normalizeDirPath(root));
    }
  }
  return roots;
}

/**
 * Checks whether an absolute path falls under any known skill directory.
 *
 * Returns true if the path is inside the managed skills dir, the bundled
 * skills dir, or any of the provided extra roots. The check is
 * symlink-safe: both the candidate path and the skill roots are resolved
 * through realpath when the paths exist on disk.
 *
 * @param absPath  - The absolute path to classify.
 * @param extraRoots - Optional additional skill root directories to check.
 * @returns true if the path is inside any skill directory.
 */
export function isSkillSourcePath(
  absPath: string,
  extraRoots?: string[],
): boolean {
  const normalizedPath = normalizeFilePath(absPath);
  const roots = getSkillRoots(extraRoots);

  for (const root of roots) {
    if (normalizedPath.startsWith(root)) {
      return true;
    }
  }

  return false;
}
