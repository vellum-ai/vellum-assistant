import { resolve, relative, dirname, basename, join, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Result type shared by both sandbox and host path policies.
 */
export type PathResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against a boundary directory and verify
 * that the result stays within it.
 *
 * For existing paths, symlinks are resolved via realpathSync so a symlink
 * pointing outside the boundary is caught. For new paths (e.g. file_write),
 * pass `mustExist: false` — the nearest existing ancestor directory is
 * resolved via realpathSync to catch symlinks in parent dirs.
 */
export function sandboxPolicy(
  rawPath: string,
  boundaryDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  const mustExist = options?.mustExist ?? true;

  const resolved = resolve(boundaryDir, rawPath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false, walk up to the nearest existing ancestor and
  // resolve it, then re-append the trailing components.
  let realResolved = resolved;
  if (mustExist) {
    try {
      realResolved = realpathSync(resolved);
    } catch {
      // File doesn't exist — will be caught by the tool's own existence check
      realResolved = resolved;
    }
  } else {
    let current = resolved;
    const trailing: string[] = [];
    while (current !== dirname(current)) {
      try {
        const real = realpathSync(current);
        realResolved = trailing.length > 0 ? join(real, ...trailing) : real;
        break;
      } catch {
        trailing.unshift(basename(current));
        current = dirname(current);
      }
    }
  }

  // Resolve the boundary directory's real path too (in case it's a symlink)
  let realBoundary: string;
  try {
    realBoundary = realpathSync(boundaryDir);
  } catch {
    realBoundary = boundaryDir;
  }

  const rel = relative(realBoundary, realResolved);
  if (rel.startsWith('..') || resolve(realBoundary, rel) !== realResolved) {
    return {
      ok: false,
      error: `Path "${rawPath}" resolves to "${realResolved}" which is outside the working directory "${realBoundary}"`,
    };
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

/**
 * Validate a path for host filesystem access.
 * Only requirement: the path must be absolute. No sandbox boundary check.
 */
export function hostPolicy(rawPath: string): PathResult {
  if (!isAbsolute(rawPath)) {
    return {
      ok: false,
      error: `path must be absolute for host file access: ${rawPath}`,
    };
  }
  return { ok: true, resolved: rawPath };
}
