import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/**
 * Result type shared by both sandbox and host path policies.
 */
export type PathFailureReason = "not_absolute" | "out_of_bounds" | "denied";

/**
 * Basenames that must never be read or written by the assistant, regardless
 * of where they resolve. Defense-in-depth: even if a key file is accidentally
 * placed inside the workspace boundary, the assistant cannot access it.
 */
const DENIED_BASENAMES = new Set([".backup.key", "backup.key"]);

export type PathResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: PathFailureReason; error: string };

// The Docker sandbox mounts the host workspace at /workspace inside the
// container. The model generates container-scoped paths (e.g.
// "/workspace/scratch/file.png") that need to be remapped to the host
// boundary directory before validation.
const CONTAINER_WORKSPACE_PREFIX = "/workspace/";
const CONTAINER_WORKSPACE_EXACT = "/workspace";

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against a boundary directory and verify
 * that the result stays within it.
 *
 * For existing paths, symlinks are resolved via realpathSync so a symlink
 * pointing outside the boundary is caught. For new paths (e.g. file_write),
 * pass `mustExist: false` - the nearest existing ancestor directory is
 * resolved via realpathSync to catch symlinks in parent dirs.
 *
 * Paths starting with `/workspace/` are treated as container-scoped and
 * remapped relative to the boundary directory (the Docker sandbox mounts
 * the host workspace at /workspace).
 */
export function sandboxPolicy(
  rawPath: string,
  boundaryDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  const mustExist = options?.mustExist ?? true;

  // Remap container-scoped /workspace paths to the host boundary dir.
  // Skip remapping if the path already starts with boundaryDir to avoid
  // double-nesting (e.g. /workspace/project/file.ts → /workspace/project/project/file.ts
  // when boundaryDir is /workspace/project).
  let effectivePath = rawPath;
  if (!rawPath.startsWith(boundaryDir + "/") && rawPath !== boundaryDir) {
    if (rawPath.startsWith(CONTAINER_WORKSPACE_PREFIX)) {
      effectivePath = rawPath.slice(CONTAINER_WORKSPACE_PREFIX.length);
    } else if (rawPath === CONTAINER_WORKSPACE_EXACT) {
      effectivePath = ".";
    }
  }

  const resolved = resolve(boundaryDir, effectivePath);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false, walk up to the nearest existing ancestor and
  // resolve it, then re-append the trailing components.
  let realResolved = resolved;
  if (mustExist) {
    try {
      realResolved = realpathSync(resolved);
    } catch {
      // File doesn't exist - will be caught by the tool's own existence check
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
  if (rel.startsWith("..") || resolve(realBoundary, rel) !== realResolved) {
    return {
      ok: false,
      reason: "out_of_bounds",
      error: `Path "${rawPath}" resolves to "${realResolved}" which is outside the working directory "${realBoundary}"`,
    };
  }

  // Check both the logical path and the symlink-resolved path so a symlink
  // with a non-denied name pointing at a denied file is still caught.
  if (DENIED_BASENAMES.has(basename(resolved)) || DENIED_BASENAMES.has(basename(realResolved))) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(resolved)}" is denied`,
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
      reason: "not_absolute",
      error: `path must be absolute for host file access: ${rawPath}`,
    };
  }
  if (DENIED_BASENAMES.has(basename(rawPath))) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(rawPath)}" is denied`,
    };
  }
  return { ok: true, resolved: rawPath };
}
