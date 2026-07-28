import { realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { resolveTrailingLinkTarget } from "../util/fs-symlinks.js";
import {
  getMonitoringDataDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
  getWorkspaceSkillsDir,
  getWorkspaceSystemPromptDir,
  getWorkspaceToolsDir,
  getWorkspaceWorkflowsDir,
} from "../util/platform.js";

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
 * Canonicalize a path's directory chain while keeping the final segment as
 * addressed: symlinks among the ancestors (macOS `/var` → `/private/var`, a
 * linked parent directory) resolve, a trailing symlink does not. This is
 * the *name* the daemon acts on — the prompt renderer and the code loaders
 * open control-plane paths by name and follow links while reading, so when
 * the final segment is itself a symlink, a write addressed at it changes
 * what they read even though the bytes land at the link's destination.
 */
function canonicalizeAddressedName(p: string): string {
  const abs = resolve(p);
  return `${canonicalizeExisting(dirname(abs))}/${basename(abs)}`;
}

/**
 * Whether a canonical path is a canonical directory or falls under it. The
 * trailing separator keeps `/workspace-extra` from matching `/workspace`.
 * Both arguments must already be canonicalized — comparing a canonical path
 * against a lexical directory would re-open the symlink dodge.
 */
function isAtOrUnderCanonicalDir(
  canonicalPath: string,
  canonicalDir: string,
): boolean {
  const prefix = canonicalDir.endsWith("/") ? canonicalDir : `${canonicalDir}/`;
  return canonicalPath === canonicalDir || canonicalPath.startsWith(prefix);
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
  return isAtOrUnderCanonicalDir(
    canonicalize(filePath),
    canonicalize(workspaceRoot),
  );
}

// ── Tool-name sets for invocation classification ──────────────────────

/** File-path tools whose workspace-scoped-ness depends on the file_path input. */
const PATH_SCOPED_TOOLS = new Set(["file_read", "file_write", "file_edit"]);

/** Sandbox file tools that write. Reads never plant code. */
const WORKSPACE_WRITE_TOOLS = new Set(["file_write", "file_edit"]);

/** Whether a tool is a sandbox file tool that writes. */
export function isWorkspaceWriteTool(toolName: string): boolean {
  return WORKSPACE_WRITE_TOOLS.has(toolName);
}

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
 * The workspace directories the daemon imports and executes — hooks,
 * plugins, skills, tools, routes, workflows — plus the monitoring data
 * directory, whose source-versions sentinel steers which plugin code the
 * daemon imports. A write to any of them is code that runs later with the
 * daemon's own reach. The list mirrors the file risk classifier's
 * code-injection sinks.
 */
function executableSinkDirs(): string[] {
  return [
    getWorkspaceHooksDir(),
    getWorkspacePluginsDir(),
    getWorkspaceSkillsDir(),
    getWorkspaceToolsDir(),
    getWorkspaceRoutesDir(),
    getWorkspaceWorkflowsDir(),
    getMonitoringDataDir(),
  ];
}

/**
 * Workspace-root files and directories the prompt renderer reads into the
 * system prompt at render time (`prompts/templates/system-sections.ts`
 * `workspacePath` entries — a drift-guard test walks the real section list
 * against this predicate). A write to any of them rewrites the assistant's
 * standing instructions, per-user context, or per-channel context.
 */
const PROMPT_SURFACE_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "VOICE.md",
  "BOOTSTRAP.md",
  // Read by the heartbeat service as its checklist — instructions executed
  // unattended (`runtime/routes/heartbeat-routes.ts`).
  "HEARTBEAT.md",
  // The scratchpad the heartbeat checklist reads its to-dos from, injected
  // into every full-mode guardian turn by the `now-md` injector
  // (`plugins/defaults/workspace/injectors.ts`). Injector-fed rather than a
  // system section, so the drift guard cannot see it — this entry is the
  // coverage.
  "NOW.md",
];
const PROMPT_SURFACE_DIRS = ["users", "channels"];

// `memory/**` is deliberately data-plane, not control-plane: memory pages
// inject into guardian sessions as past-record rather than standing
// instructions, consolidation owns and rewrites those files, and the gated
// write path is `remember()` (provenance-checked in the indexer). If direct
// file writes to memory pages ever become a delegation surface, they join
// this list.

/**
 * Whether a sandbox file-tool invocation writes a workspace control-plane
 * target: an executable sink directory (code the daemon executes) or a
 * prompt surface (instructions it obeys). The two categories are one
 * delegation a layer apart — approving the write approves everything the
 * planted code or rewritten instructions cause later.
 *
 * Unlike {@link isOutOfWorkspaceFileInvocation} this holds in containerized
 * mode too: the workspace boundary is what contains an escaping *path*, and
 * these paths do not escape — the daemon acts on them from inside.
 *
 * Two views of the write are checked against every baseline, because a
 * symlink at either end dodges a single view:
 *
 * - The canonical destination ({@link canonicalize}): a benign-looking name
 *   whose trailing link points at a control-plane path is a write to that
 *   path, and a lexical check does not see it.
 * - The addressed name ({@link canonicalizeAddressedName}): a control-plane
 *   name that is itself a symlink to a benign path still changes what the
 *   daemon reads under that name — the renderer and the loaders follow the
 *   link — while the destination alone canonicalizes past the surface.
 *
 * The baselines are canonicalized too: a prompt surface may itself be a
 * symlink (SOUL.md → personas/current.md), and the renderer reads through
 * it — so a write to the link's destination must match as well.
 */
export function isControlPlaneWorkspaceWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot: string,
): boolean {
  if (!isWorkspaceWriteTool(toolName)) {
    return false;
  }
  const filePath = resolvePathScopedTarget(toolInput, workspaceRoot);
  if (filePath === "") {
    return false;
  }
  const target = canonicalize(filePath);
  const addressed = canonicalizeAddressedName(filePath);
  const root = canonicalize(workspaceRoot);
  const writesUnder = (dir: string): boolean => {
    const canonicalDir = canonicalize(dir);
    return (
      isAtOrUnderCanonicalDir(target, canonicalDir) ||
      isAtOrUnderCanonicalDir(addressed, canonicalDir)
    );
  };
  return (
    executableSinkDirs().some(writesUnder) ||
    PROMPT_SURFACE_FILES.some((file) => {
      const canonicalFile = canonicalize(`${root}/${file}`);
      return target === canonicalFile || addressed === canonicalFile;
    }) ||
    PROMPT_SURFACE_DIRS.some((dir) => writesUnder(`${root}/${dir}`)) ||
    // The system-section override layer: a `<section-id>.md` under
    // `prompts/system/` replaces the bundled section of the same id — or,
    // stripped to nothing, silences it — including the security-policy
    // sections (credential handling, external content, the non-guardian
    // boundary). A brand-new id adds a workspace-only section, so the whole
    // directory is a prompt surface. The baseline is the getter the renderer
    // itself resolves, like {@link executableSinkDirs}.
    writesUnder(getWorkspaceSystemPromptDir())
  );
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
