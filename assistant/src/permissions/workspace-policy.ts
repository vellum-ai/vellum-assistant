import { realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";

/**
 * Resolve a path to its canonical form. When the target itself doesn't
 * exist (e.g. a new file being written), walk up to the nearest existing
 * ancestor and append the remaining segments so that symlinks in parent
 * directories (like macOS `/var` -> `/private/var`) are still resolved.
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
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
    return `${canonicalize(parent)}/${name}`;
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
  if (!filePath || !workspaceRoot) return false;

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
const NETWORK_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_select_option",
  "browser_hover",
  "browser_screenshot",
  "browser_close",
  "browser_attach",
  "browser_detach",
  "network_request",
]);

/** Host-level tools — operate outside the sandbox, never workspace-scoped. */
const HOST_TOOLS = new Set([
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_bash",
  "computer_use_run_applescript",
]);

/**
 * Check whether a tool name is a host-level tool that requires the
 * `hostAccess` permission to execute.
 */
export function isHostTool(toolName: string): boolean {
  return HOST_TOOLS.has(toolName);
}

/** Safe local-only tools that are always workspace-scoped. */
const ALWAYS_SCOPED_TOOLS = new Set([
  "skill_load",
  "recall",
  "ui_update",
  "ui_dismiss",
]);

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
  if (ALWAYS_SCOPED_TOOLS.has(toolName)) return true;
  if (NETWORK_TOOLS.has(toolName)) return false;
  if (HOST_TOOLS.has(toolName)) return false;

  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const rawPath =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : "";
    // Resolve relative paths against workspaceRoot (not process.cwd())
    const filePath =
      rawPath !== "" && !rawPath.startsWith("/")
        ? resolve(workspaceRoot, rawPath)
        : rawPath;
    return (
      filePath !== "" && isPathWithinWorkspaceRoot(filePath, workspaceRoot)
    );
  }

  // Bash is generally workspace-scoped when sandbox isolation is active —
  // the caller handles network mode checks separately.
  if (toolName === "bash") return true;

  // Unknown tool — conservative default.
  return false;
}
