import { realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { resolveTrailingLinkTarget } from "../util/fs-symlinks.js";

/**
 * Resolve a path to its canonical form. A trailing (possibly dangling)
 * symlink chain is followed first so a link whose destination does not
 * exist yet still canonicalizes to that destination — a write through the
 * link creates it. When the target itself doesn't exist (e.g. a new file
 * being written), walk up to the nearest existing ancestor and append the
 * remaining segments so that symlinks in parent directories (like macOS
 * `/var` -> `/private/var`) are still resolved.
 */
function canonicalize(p: string): string {
  const abs = resolveTrailingLinkTarget(resolve(p));
  return canonicalizeExisting(abs);
}

function canonicalizeExisting(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    // Walk upward until we find an existing ancestor.
    const name = basename(abs);
    const parent = dirname(abs);
    if (parent === abs) {
      // Reached filesystem root — nothing left to resolve.
      return normalize(abs);
    }
    return `${canonicalizeExisting(parent)}/${name}`;
  }
}

/**
 * Resolve a file path to its canonical form (resolving symlinks and
 * normalizing segments like `.` and `..`), then check whether it falls
 * within the given workspace root.
 */
export function isPathWithinWorkspaceRoot(
  filePath: string,
  workspaceRoot: string,
): boolean {
  if (!filePath || !workspaceRoot) {
    return false;
  }

  const canonicalPath = canonicalize(filePath);
  const canonicalRoot = canonicalize(workspaceRoot);

  // Ensure the root ends with a separator so `/workspace-extra` doesn't
  // match `/workspace`.
  const rootPrefix = canonicalRoot.endsWith("/")
    ? canonicalRoot
    : `${canonicalRoot}/`;

  return (
    canonicalPath === canonicalRoot || canonicalPath.startsWith(rootPrefix)
  );
}

// ── Tool-name sets for invocation classification ──────────────────────

/** File-path tools whose workspace-scoped-ness depends on the file_path input. */
const PATH_SCOPED_TOOLS = new Set(["file_read", "file_write", "file_edit"]);

/** Network-accessing tools — never workspace-scoped. */
const NETWORK_TOOLS = new Set(["web_search", "web_fetch", "network_request"]);

/** Host-level tools — operate outside the sandbox, never workspace-scoped. */
const HOST_TOOLS = new Set([
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
  "host_bash",
  "computer_use_run_applescript",
]);

/** Safe local-only tools that are always workspace-scoped. */
const ALWAYS_SCOPED_TOOLS = new Set([
  "skill_load",
  "recall",
  "ui_update",
  "ui_dismiss",
]);

// The Docker sandbox mounts the workspace at /workspace, and the model emits
// container-scoped paths (e.g. "/workspace/tools/evil.ts") even on local
// turns. The execution-time path policy and the gateway classifier both
// apply this remap, so every workspace-containment decision here must too.
const CONTAINER_WORKSPACE_PREFIX = "/workspace/";
const CONTAINER_WORKSPACE_EXACT = "/workspace";

/**
 * Resolve a sandbox file path to its lexical base the same way the
 * execution-time `sandboxPolicy` and the gateway classifier do: remap a
 * container-scoped `/workspace/...` path onto `workingDir`, then resolve
 * (relative paths resolve against `workingDir`, not process.cwd()).
 */
export function resolveSandboxBase(
  rawPath: string,
  workingDir: string,
): string {
  let effectivePath = rawPath;
  if (!rawPath.startsWith(workingDir + "/") && rawPath !== workingDir) {
    if (rawPath.startsWith(CONTAINER_WORKSPACE_PREFIX)) {
      effectivePath = rawPath.slice(CONTAINER_WORKSPACE_PREFIX.length);
    } else if (rawPath === CONTAINER_WORKSPACE_EXACT) {
      effectivePath = ".";
    }
  }
  return resolve(workingDir, effectivePath);
}

/**
 * Extract a path-scoped tool's target path from its input. `path` takes
 * priority over `file_path` — the file tools execute `input.path` and the
 * risk classifier reads the fields in the same order, so containment
 * decisions must be derived from the field that actually executes (an input
 * carrying both fields is not runtime-stripped). Returns `""` when the
 * input carries no usable path.
 */
function resolvePathScopedTarget(
  toolInput: Record<string, unknown>,
  workspaceRoot: string,
): string {
  const rawPath =
    typeof toolInput.path === "string"
      ? toolInput.path
      : typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : "";
  if (rawPath === "") {
    return "";
  }
  return resolveSandboxBase(rawPath, workspaceRoot);
}

/**
 * Whether a sandbox file-tool invocation targets a path outside the
 * workspace root. Always false in containerized mode — the execution-time
 * boundary is hard there, so an escaping path never executes. Non-path
 * tools are never classified by this predicate.
 */
export function isOutOfWorkspaceFileInvocation(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  if (getIsContainerized()) {
    return false;
  }
  if (!PATH_SCOPED_TOOLS.has(toolName)) {
    return false;
  }
  const filePath = resolvePathScopedTarget(toolInput, workspaceRoot);
  return filePath !== "" && !isPathWithinWorkspaceRoot(filePath, workspaceRoot);
}

/**
 * Determine whether a tool invocation only affects resources within the
 * workspace root. This is a conservative classification — unknown tools
 * default to NOT workspace-scoped.
 */
export function isWorkspaceScopedInvocation(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  if (ALWAYS_SCOPED_TOOLS.has(toolName)) {
    return true;
  }
  if (NETWORK_TOOLS.has(toolName)) {
    return false;
  }
  if (HOST_TOOLS.has(toolName)) {
    return false;
  }

  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const filePath = resolvePathScopedTarget(toolInput, workspaceRoot);
    return (
      filePath !== "" && isPathWithinWorkspaceRoot(filePath, workspaceRoot)
    );
  }

  // Bash workspace scope depends on the environment: containerized bash has the
  // entire filesystem as workspace, so it's always workspace-scoped. Non-containerized
  // bash is NOT workspace-scoped here — path resolution for allowlisted commands is
  // handled upstream in the checker's hasSandboxAutoApprove computation, which validates
  // all path arguments against the workspace root for non-containerized environments.
  if (toolName === "bash") {
    return getIsContainerized();
  }

  // Unknown tool — conservative default.
  return false;
}
