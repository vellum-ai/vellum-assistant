import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { getIsContainerized } from "../../../config/env-registry.js";

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

/**
 * Whether a path's basename is on the denylist of files the assistant must
 * never read or write. Shared so callers that walk the filesystem (e.g.
 * `code_search`) apply the same denylist as `sandboxPolicy`/`hostPolicy`,
 * keeping the three in sync.
 */
export function isDeniedBasename(path: string): boolean {
  return DENIED_BASENAMES.has(basename(path));
}

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
// Symlink resolution
// ---------------------------------------------------------------------------

/**
 * Resolve symlinks in an absolute path.
 *
 * For an existing path, returns its `realpathSync`. For a path that does not
 * exist yet (e.g. a `file_write` target), walks up to the nearest existing
 * ancestor, resolves that ancestor via `realpathSync`, then re-appends the
 * trailing (non-existent) components — so a symlink anywhere in the existing
 * prefix is still followed. Falls back to the lexical input when nothing on
 * the path resolves (e.g. the path lives on a filesystem this process cannot
 * see, as with host_file paths proxied to a remote client).
 *
 * Used both for sandbox-boundary enforcement and to canonicalize paths before
 * security risk classification, so a symlink cannot mask the true target of a
 * file operation.
 */
export function resolveRealPath(absolutePath: string): string {
  let current = absolutePath;
  const trailing: string[] = [];
  while (current !== dirname(current)) {
    try {
      const real = realpathSync(current);
      return trailing.length > 0 ? join(real, ...trailing) : real;
    } catch {
      trailing.unshift(basename(current));
      current = dirname(current);
    }
  }
  return absolutePath;
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

interface SandboxTarget {
  /** Lexically resolved absolute path (boundary-relative input resolved). */
  resolved: string;
  /** Symlink-canonicalized form of `resolved`. */
  realResolved: string;
  /** Symlink-canonicalized boundary directory. */
  realBoundary: string;
}

/**
 * Resolve a user-supplied path against the boundary directory: apply the
 * container /workspace remap, resolve to an absolute path, and canonicalize
 * symlinks on both the target and the boundary.
 */
function resolveSandboxTarget(
  rawPath: string,
  boundaryDir: string,
  mustExist: boolean,
): SandboxTarget {
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
    realResolved = resolveRealPath(resolved);
  }

  // Resolve the boundary directory's real path too (in case it's a symlink)
  let realBoundary: string;
  try {
    realBoundary = realpathSync(boundaryDir);
  } catch {
    realBoundary = boundaryDir;
  }

  return { resolved, realResolved, realBoundary };
}

/** Whether the canonicalized target escapes the canonicalized boundary. */
function isOutOfBounds(target: SandboxTarget): boolean {
  const rel = relative(target.realBoundary, target.realResolved);
  return (
    rel.startsWith("..") ||
    resolve(target.realBoundary, rel) !== target.realResolved
  );
}

function outOfBoundsFailure(
  rawPath: string,
  target: SandboxTarget,
): PathResult {
  return {
    ok: false,
    reason: "out_of_bounds",
    error: `Path "${rawPath}" resolves to "${target.realResolved}" which is outside the working directory "${target.realBoundary}"`,
  };
}

// The denied check covers both the logical path and the symlink-resolved
// path so a symlink with a non-denied name pointing at a denied file is
// still caught.
function deniedFailure(target: SandboxTarget): PathResult | null {
  if (
    isDeniedBasename(target.resolved) ||
    isDeniedBasename(target.realResolved)
  ) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(target.resolved)}" is denied`,
    };
  }
  return null;
}

function evaluateSandboxPolicy(
  rawPath: string,
  boundaryDir: string,
  options: { mustExist?: boolean } | undefined,
  allowOutOfBounds: boolean,
): PathResult {
  const target = resolveSandboxTarget(
    rawPath,
    boundaryDir,
    options?.mustExist ?? true,
  );

  if (!allowOutOfBounds && isOutOfBounds(target)) {
    return outOfBoundsFailure(rawPath, target);
  }

  const denied = deniedFailure(target);
  if (denied) {
    return denied;
  }

  return { ok: true, resolved: target.resolved };
}

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
  return evaluateSandboxPolicy(rawPath, boundaryDir, options, false);
}

/**
 * Sandbox policy that permits out-of-workspace targets on non-containerized
 * installs.
 *
 * Identical to {@link sandboxPolicy} for in-bounds targets. A target that
 * escapes the boundary is allowed with host-style validation (the basename
 * denylist still applies to both the logical and symlink-resolved paths).
 * The permission lane runs before tool execution and classifies
 * out-of-workspace file operations as elevated risk (see the gateway
 * FileRiskClassifier), so an escape reaching this policy has already been
 * threshold-approved or user-approved.
 *
 * In containerized mode the boundary stays hard: the container filesystem is
 * not the host, and the host_file_* proxy tools are the escape hatch for the
 * guardian's device.
 */
export function sandboxPolicyWithHostFallback(
  rawPath: string,
  boundaryDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  return evaluateSandboxPolicy(
    rawPath,
    boundaryDir,
    options,
    !getIsContainerized(),
  );
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
  if (isDeniedBasename(rawPath)) {
    return {
      ok: false,
      reason: "denied",
      error: `Access to "${basename(rawPath)}" is denied`,
    };
  }
  return { ok: true, resolved: rawPath };
}
