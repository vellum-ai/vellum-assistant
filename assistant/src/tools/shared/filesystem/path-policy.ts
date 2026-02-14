import { resolve, relative, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { FsError } from './errors.js';
import { pathOutOfBounds, pathNotAbsolute } from './errors.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type PathCheckResult =
  | { ok: true; resolved: string }
  | { ok: false; error: FsError };

// ---------------------------------------------------------------------------
// Sandbox policy — resolves a path against a boundary directory and rejects
// anything that escapes via `..` traversal or symlink indirection.
// ---------------------------------------------------------------------------

export function sandboxPolicy(
  rawPath: string,
  boundary: string,
  options?: { mustExist?: boolean },
): PathCheckResult {
  const mustExist = options?.mustExist ?? true;

  const resolved = resolve(boundary, rawPath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false (file writes), walk up to the nearest existing
  // ancestor and resolve it, then re-append the trailing components.
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

  // Resolve the boundary's real path too (in case it's a symlink)
  let realBoundary: string;
  try {
    realBoundary = realpathSync(boundary);
  } catch {
    realBoundary = boundary;
  }

  const rel = relative(realBoundary, realResolved);
  if (rel.startsWith('..') || resolve(realBoundary, rel) !== realResolved) {
    return { ok: false, error: pathOutOfBounds(rawPath, realBoundary) };
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Host policy — only enforces that the path is absolute (no sandbox boundary).
// ---------------------------------------------------------------------------

export function hostPolicy(rawPath: string): PathCheckResult {
  if (!rawPath.startsWith('/')) {
    return { ok: false, error: pathNotAbsolute(rawPath) };
  }
  return { ok: true, resolved: resolve(rawPath) };
}
