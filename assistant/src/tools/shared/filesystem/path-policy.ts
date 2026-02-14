import { resolve, relative, dirname, basename, join, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type PathPolicyResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

/**
 * Validate that a path stays within a sandbox boundary (workingDir).
 *
 * Resolves symlinks to prevent symlink-based escapes. For new files
 * (mustExist: false), walks up to the nearest existing ancestor and
 * resolves it, then re-appends trailing components.
 */
export function sandboxPathPolicy(
  rawPath: string,
  workingDir: string,
  options?: { mustExist?: boolean },
): PathPolicyResult {
  const mustExist = options?.mustExist ?? true;

  const resolved = resolve(workingDir, rawPath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false (file_write), walk up to the nearest existing
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

  // Resolve the working directory's real path too (in case it's a symlink)
  let realWorkingDir: string;
  try {
    realWorkingDir = realpathSync(workingDir);
  } catch {
    realWorkingDir = workingDir;
  }

  const rel = relative(realWorkingDir, realResolved);
  if (rel.startsWith('..') || resolve(realWorkingDir, rel) !== realResolved) {
    return {
      ok: false,
      error: `Path "${rawPath}" resolves to "${realResolved}" which is outside the working directory "${realWorkingDir}"`,
    };
  }

  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

/**
 * Validate that a path is absolute. Host filesystem tools operate without
 * a sandbox boundary, but require absolute paths to avoid ambiguity.
 */
export function hostPathPolicy(rawPath: string): PathPolicyResult {
  if (!isAbsolute(rawPath)) {
    return {
      ok: false,
      error: `Path must be absolute: ${rawPath}`,
    };
  }
  return { ok: true, resolved: rawPath };
}
