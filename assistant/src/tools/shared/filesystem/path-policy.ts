import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { getIsContainerized } from "../../../config/env-registry.js";
import { resolveTrailingLinkTarget } from "../../../util/fs-symlinks.js";
import { getDotEnvPath } from "../../../util/platform.js";

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

/**
 * `/proc/<pid>/environ` for any pid, including the `self` and `thread-self`
 * aliases. Reading one yields the target process's full environment.
 */
const PROC_ENVIRON_PATTERN = /^\/proc\/(?:\d+|self|thread-self)\/environ$/;

/**
 * Whether a path exposes a process environment block.
 *
 * The daemon's own environment carries credential material the file tools
 * must never hand back: the actor token signing key, the CES service token,
 * the guardian bootstrap secret, and any provider API keys forwarded in at
 * launch. The bash tool strips those from the child processes it spawns via
 * the `SAFE_ENV_VARS` allowlist, so denying them here keeps the file tools
 * from becoming the looser path to the same secrets.
 */
export function isProcessEnvironPath(path: string): boolean {
  return PROC_ENVIRON_PATTERN.test(path);
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
 * A trailing (possibly dangling) symlink chain is followed first — see
 * {@link resolveTrailingLinkTarget} — so a link whose destination does not
 * exist yet still reports that destination. For an existing path, returns
 * its `realpathSync`. For a path that does not exist yet (e.g. a
 * `file_write` target), walks up to the nearest existing ancestor, resolves
 * that ancestor via `realpathSync`, then re-appends the trailing
 * (non-existent) components — so a symlink anywhere in the existing prefix
 * is still followed. Falls back to the lexical input when nothing on the
 * path resolves (e.g. the path lives on a filesystem this process cannot
 * see, as with host_file paths proxied to a remote client).
 *
 * Used both for sandbox-boundary enforcement and to canonicalize paths before
 * security risk classification, so a symlink cannot mask the true target of a
 * file operation.
 */
export function resolveRealPath(absolutePath: string): string {
  let current = resolveTrailingLinkTarget(absolutePath);
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

  // Follow a trailing (possibly dangling) symlink chain first — a write
  // through a dangling link creates the link's destination, so the
  // containment and denial checks below must run against it.
  const linkTarget = resolveTrailingLinkTarget(resolved);

  // Resolve symlinks to catch symlink-based escapes.
  // For mustExist=false, walk up to the nearest existing ancestor and
  // resolve it, then re-append the trailing components.
  let realResolved = linkTarget;
  if (mustExist) {
    try {
      realResolved = realpathSync(linkTarget);
    } catch {
      // File doesn't exist - will be caught by the tool's own existence check
      realResolved = linkTarget;
    }
  } else {
    realResolved = resolveRealPath(linkTarget);
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
  if (
    isProcessEnvironPath(target.resolved) ||
    isProcessEnvironPath(target.realResolved)
  ) {
    return {
      ok: false,
      reason: "denied",
      error: "Access to process environment blocks is denied",
    };
  }
  return null;
}

function safeUserInfoHomedir(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

const SECURITY_DIR_ENV_VARS = [
  "GATEWAY_SECURITY_DIR",
  "CREDENTIAL_SECURITY_DIR",
] as const;

/**
 * Secret-bearing paths the file tools must never touch, in any policy:
 *
 * - Gateway trust material and token signing keys (GATEWAY_SECURITY_DIR)
 *   and CES credential keys (CREDENTIAL_SECURITY_DIR — `keys.enc`,
 *   `store.key`). The daemon must never read from or write to them — that
 *   data flows through the gateway and CES APIs (root AGENTS.md). The
 *   env-based resolution mirrors the owning services', since the
 *   cross-package import boundary bars importing it; the shared bare-metal
 *   default `<home>/.vellum/protected` is always denied. Only absolute
 *   overrides join the set — a relative override is unmirrorable and
 *   disables the host fallback outright (see
 *   {@link securityDirConfigMirrorable}).
 * - The daemon dotenv (`<vellumRoot>/.env`), which carries provider
 *   secrets.
 */
function getProtectedServicePaths(): string[] {
  const paths = new Set<string>();
  paths.add(
    join(
      process.env.HOME || safeUserInfoHomedir() || homedir(),
      ".vellum",
      "protected",
    ),
  );
  for (const name of SECURITY_DIR_ENV_VARS) {
    const override = process.env[name]?.trim();
    if (override && isAbsolute(override)) {
      paths.add(resolve(override));
    }
  }
  paths.add(getDotEnvPath());
  return [...paths];
}

/**
 * Whether the security-dir deny set can be mirrored faithfully. A relative
 * override resolves against the owning service's cwd, which this process
 * cannot know — the true directory would be absent from the deny set, so
 * the host fallback fails closed to the hard boundary instead.
 */
function securityDirConfigMirrorable(): boolean {
  return SECURITY_DIR_ENV_VARS.every((name) => {
    const override = process.env[name]?.trim();
    return !override || isAbsolute(override);
  });
}

function isWithinDir(path: string, dir: string): boolean {
  const normalized = dir !== "/" && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (normalized === "/") {
    return isAbsolute(path);
  }
  return path === normalized || path.startsWith(normalized + "/");
}

/**
 * Deny a target that lands in (or on) a protected service path. Both the
 * lexical and symlink-resolved target are checked against both the lexical
 * and symlink-resolved protected path, so neither a symlinked target nor a
 * symlinked directory prefix can mask the hit.
 */
function securityDirDenial(target: SandboxTarget): PathResult | null {
  for (const protectedPath of getProtectedServicePaths()) {
    const realProtectedPath = resolveRealPath(protectedPath);
    const hit = [target.resolved, target.realResolved].some(
      (path) =>
        isWithinDir(path, protectedPath) ||
        isWithinDir(path, realProtectedPath),
    );
    if (hit) {
      return {
        ok: false,
        reason: "denied",
        error: "Access to the service security directory is denied",
      };
    }
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

  // Applied unconditionally — even a boundary configured to contain a
  // service security dir must not expose it through the file tools.
  const securityDenied = securityDirDenial(target);
  if (securityDenied) {
    return securityDenied;
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
 * Write-side sandbox policy: permits out-of-workspace targets on
 * non-containerized installs.
 *
 * Identical to {@link sandboxPolicy} for in-bounds targets. A target that
 * escapes the boundary is allowed with host-style validation: the basename
 * denylist still applies to both the logical and symlink-resolved paths, and
 * the service security directories stay denied outright.
 * The permission lane runs before tool execution and classifies
 * out-of-workspace file operations as elevated risk (see the gateway
 * FileRiskClassifier), so an escape reaching this policy has already been
 * threshold-approved or user-approved.
 *
 * In containerized mode the boundary stays hard for writes: the container
 * filesystem is the install tree the assistant runs from, and the
 * host_file_* proxy tools are the escape hatch for the guardian's device.
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
    !getIsContainerized() && securityDirConfigMirrorable(),
  );
}

/**
 * Read-side sandbox policy: the working directory bounds where the assistant
 * *writes*, not what it may look at.
 *
 * Everything the process can open, it may read. A containerized install owns
 * its whole filesystem (the workspace, the install tree it runs from, `/tmp`),
 * and `bash cat` already reads all of it at Low risk, so denying the file
 * tools the same reach only pushes reads through a shell. A bare-metal install
 * reaches the host filesystem, which the permission lane classifies as
 * elevated risk before execution (see the gateway FileRiskClassifier). Either
 * way the boundary is not what protects secrets.
 *
 * The denials are what protect secrets, and they apply to every read: the
 * service security directories (gateway trust material, CES credential keys,
 * the daemon dotenv), the basename denylist, and process environment blocks
 * (see {@link isProcessEnvironPath}), each checked on both the logical and
 * the symlink-resolved path. When that deny set cannot be mirrored faithfully
 * (see {@link securityDirConfigMirrorable}), reads fail closed to the hard
 * boundary rather than escape it unprotected.
 *
 * Write-side policies do not take this allowance.
 */
export function sandboxReadPolicy(
  rawPath: string,
  boundaryDir: string,
  options?: { mustExist?: boolean },
): PathResult {
  return evaluateSandboxPolicy(
    rawPath,
    boundaryDir,
    options,
    securityDirConfigMirrorable(),
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
