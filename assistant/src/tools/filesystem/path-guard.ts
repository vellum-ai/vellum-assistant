import { resolve, relative, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Resolve a user-supplied path against the working directory and verify
 * that the result stays within the allowed boundary (workingDir by default).
 *
 * Returns the resolved absolute path on success, or an error message string.
 *
 * For existing paths, symlinks are resolved via realpathSync so a symlink
 * pointing outside the boundary is caught. For new paths (file_write),
 * the caller should pass `mustExist: false` — the nearest existing ancestor
 * directory is resolved via realpathSync to catch symlinks in parent dirs.
 */
export function validateFilePath(
  rawPath: string,
  workingDir: string,
  options?: { mustExist?: boolean },
): { ok: true; resolved: string } | { ok: false; error: string } {
  const mustExist = options?.mustExist ?? true;

  // Resolve to absolute path (handles relative paths and ..)
  const resolved = resolve(workingDir, rawPath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false (file_write), walk up to the nearest existing
  // ancestor and resolve it, then re-append the trailing components.
  // This prevents symlink directories from escaping the boundary.
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

  // Check that the resolved path is within the working directory
  const rel = relative(realWorkingDir, realResolved);
  if (rel.startsWith('..') || resolve(realWorkingDir, rel) !== realResolved) {
    return {
      ok: false,
      error: `Path "${rawPath}" resolves to "${realResolved}" which is outside the working directory "${realWorkingDir}"`,
    };
  }

  return { ok: true, resolved };
}
