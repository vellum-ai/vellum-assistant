/**
 * File risk classifier — path-based risk classification for file tools.
 *
 * Implements RiskClassifier<FileClassifierInput> for all seven file tool types:
 * file_read, file_write, file_edit, host_file_read, host_file_write,
 * host_file_edit, host_file_transfer.
 *
 * Risk escalation paths:
 * - file_read: Low by default, High if targeting the actor token signing key.
 * - file_write / file_edit: Low by default, High if targeting skill source
 *   code, the workspace hooks directory, the user plugins directory, the
 *   workspace tools directory, the workspace routes directory, the workspace
 *   workflows directory, or the monitoring data directory.
 * - host_file_read: Medium (tool registry default; no special escalation).
 * - host_file_write / host_file_edit: Medium by default, High if targeting
 *   skill source code, the workspace hooks directory, the user plugins
 *   directory, the workspace tools directory, the workspace routes
 *   directory, the workspace workflows directory, or the monitoring data
 *   directory.
 * - host_file_transfer: Medium by default, High if the host-side path
 *   targets skill source code, the workspace hooks directory, the user
 *   plugins directory, the workspace tools directory, the workspace
 *   routes directory, the workspace workflows directory, or the monitoring
 *   data directory.
 *
 * The tools and routes directories are escalated for the same reason as
 * plugins: any file written under `<workspace>/tools/` is dynamic-imported
 * and executed as a registered tool by the workspace-tool loader (and its
 * live file watcher), and any file under `<workspace>/routes/` is
 * dynamic-imported and executed as an HTTP route handler. A write to either
 * is a code-injection sink, so it must clear the same High-risk approval gate
 * as hooks and plugins.
 *
 * The workflows directory is escalated for the same reason: any file under
 * `<workspace>/workflows/` is a saved workflow whose source is executed (in the
 * sandbox, and unattended when triggered by a schedule), so it must clear the
 * same High-risk gate.
 *
 * Gateway adaptation: accepts a FileClassificationContext parameter instead
 * of importing assistant platform utilities directly. The assistant is
 * responsible for constructing the context from its config/platform modules
 * before calling the classifier.
 */

// NOTE: homedir() is a legacy fallback for actor-token-signing-key path
// detection and allowlist option directory traversal. In Docker mode the
// gateway's HOME may differ from the assistant's, so the explicit context
// paths (protectedDir, deprecatedDir) are the reliable escalation check.
// homedir() is only used as a best-effort additional check and for allowlist
// option cosmetics (trimming ~/… prefixes).
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  AllowlistOption,
  RiskAssessment,
  RiskClassifier,
} from "./risk-types.js";
import { getTrustRuleCache } from "./trust-rule-cache.js";

// -- Context interface --------------------------------------------------------

/**
 * Context provided by the caller (assistant) that replaces the assistant-
 * specific imports (getProtectedDir, getWorkspaceHooksDir, isSkillSourcePath,
 * getDeprecatedDir, getConfig, etc.).
 */
export interface FileClassificationContext {
  /** Absolute path to the per-instance protected directory. */
  protectedDir: string;
  /** Absolute path to the deprecated directory (legacy signing key location). */
  deprecatedDir: string;
  /** Absolute path to the workspace hooks directory. */
  hooksDir: string;
  /** Absolute path to the user plugins directory. */
  pluginsDir: string;
  /** Absolute path to the workspace tools directory (dynamic-imported tool overrides). */
  toolsDir: string;
  /** Absolute path to the workspace routes directory (dynamic-imported HTTP route handlers). */
  routesDir: string;
  /** Absolute path to the workspace workflows directory (saved workflow scripts). */
  workflowsDir: string;
  /**
   * Absolute path to the monitoring data directory
   * (`<workspace>/data/monitoring`). The plugin source-versions sentinel
   * lives here — a forged sentinel can trick the daemon into importing
   * plugin code from arbitrary paths, so writes to this directory are
   * code-injection risk and must clear the High-risk approval gate.
   */
  monitoringDir: string;
  /**
   * Absolute paths of all skill source root directories (managed, bundled,
   * and any extra dirs from config). The classifier checks whether a file
   * path falls under any of these roots.
   */
  skillSourceDirs: string[];
}

// -- Input type ---------------------------------------------------------------

/** Input to the file risk classifier. */
export interface FileClassifierInput {
  toolName:
    | "file_read"
    | "file_write"
    | "file_edit"
    | "host_file_read"
    | "host_file_write"
    | "host_file_edit"
    | "host_file_transfer";
  filePath: string;
  workingDir: string;
  /**
   * The target path with symlinks resolved, canonicalized by the caller (the
   * daemon, which owns the workspace filesystem). When present, this is used
   * for the security escalation prefix checks instead of a lexical
   * resolve(workingDir, filePath) — so a symlink whose name looks benign but
   * whose real target is a protected directory is still escalated. When absent
   * (e.g. caller could not access the filesystem), classification falls back to
   * lexical resolution.
   */
  resolvedPath?: string;
  /**
   * For `host_file_transfer` with `direction: "to_sandbox"`: the workspace-side
   * destination path (where the copied file lands). `filePath` carries the
   * host-side `source_path`, so without this the workspace write destination —
   * the actual code-injection sink — would go unclassified. Resolved against
   * {@link transferSandboxWorkingDir} with the same `/workspace` remap as
   * sandbox file writes.
   */
  transferSandboxDestPath?: string;
  /** Sandbox working directory used to resolve {@link transferSandboxDestPath}. */
  transferSandboxWorkingDir?: string;
  /**
   * The `to_sandbox` destination with symlinks resolved, canonicalized by the
   * caller. Preferred over a lexical resolve of {@link transferSandboxDestPath}
   * for the code-injection-sink check; falls back to lexical when absent.
   */
  resolvedTransferDestPath?: string;
}

// -- Helpers ------------------------------------------------------------------

/**
 * Normalize a directory path: ensure it ends with `/` for prefix matching.
 */
function normalizeDirPath(dirPath: string): string {
  return dirPath.endsWith("/") ? dirPath : dirPath + "/";
}

// The Docker sandbox mounts the host workspace at /workspace inside the
// container, and the model generates container-scoped paths (e.g.
// "/workspace/tools/evil.ts") even on local/macOS turns. The file tools remap
// these to the boundary (working) directory before writing — see
// `sandboxPolicy` in assistant/src/tools/shared/filesystem/path-policy.ts.
// The classifier MUST apply the same remap before its containment checks,
// otherwise a "/workspace/tools/…" write resolves to the literal
// "/workspace/…" path (which never matches the real tools/routes/hooks dirs)
// and falls through to the Low default — silently bypassing escalation.
const CONTAINER_WORKSPACE_PREFIX = "/workspace/";
const CONTAINER_WORKSPACE_EXACT = "/workspace";

/**
 * Resolve a sandbox file path the same way `sandboxPolicy` does: remap a
 * container-scoped `/workspace/...` path to `workingDir`, then resolve.
 * Symlink resolution (realpath) is intentionally omitted — the classifier
 * only needs the logical target for prefix containment, and the file tools
 * apply realpath bounds-checking at execution time.
 */
function resolveSandboxPath(rawPath: string, workingDir: string): string {
  let effectivePath = rawPath;
  // Skip remapping if the path already starts with workingDir to avoid
  // double-nesting (mirrors sandboxPolicy).
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
 * Check whether a resolved absolute path targets the actor token signing key.
 * Covers the per-instance protected dir, the legacy global path, the
 * deprecated dir, and a relative "deprecated/actor-token-signing-key"
 * resolved against workingDir.
 */
function isActorTokenSigningKeyPath(
  resolvedPath: string,
  workingDir: string,
  context: FileClassificationContext,
): boolean {
  const signingKeyPaths = Array.from(
    new Set([
      join(homedir(), ".vellum", "protected", "actor-token-signing-key"),
      join(context.protectedDir, "actor-token-signing-key"),
      join(context.deprecatedDir, "actor-token-signing-key"),
      resolve(workingDir, "deprecated", "actor-token-signing-key"),
    ]),
  );
  return signingKeyPaths.includes(resolvedPath);
}

/**
 * Check whether a resolved absolute path falls inside the workspace hooks
 * directory (or IS the hooks directory itself).
 */
function isHooksPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedHooksDir = normalizeDirPath(context.hooksDir);
  const hooksDirNoTrailingSlash = normalizedHooksDir.slice(0, -1);
  return (
    resolvedPath === hooksDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedHooksDir)
  );
}

/**
 * Check whether a resolved absolute path falls inside the user plugins
 * directory (or IS the plugins directory itself). Mirrors {@link isHooksPath}
 * because the user plugins loader has the same threat model: any file under
 * `<pluginsDir>/<name>/` may be dynamic-imported at next daemon startup, so a
 * write here must be treated as code-injection risk.
 */
function isPluginsPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedPluginsDir = normalizeDirPath(context.pluginsDir);
  const pluginsDirNoTrailingSlash = normalizedPluginsDir.slice(0, -1);
  return (
    resolvedPath === pluginsDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedPluginsDir)
  );
}

/**
 * Check whether a resolved absolute path falls inside the workspace tools
 * directory (or IS the tools directory itself). Mirrors {@link isPluginsPath}:
 * the workspace-tool loader dynamic-imports any `<name>.{ts,js}` written here
 * and registers it as an executable tool (its file watcher does so live,
 * without a restart), so a write here is code-injection risk.
 */
function isToolsPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedToolsDir = normalizeDirPath(context.toolsDir);
  const toolsDirNoTrailingSlash = normalizedToolsDir.slice(0, -1);
  return (
    resolvedPath === toolsDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedToolsDir)
  );
}

/**
 * Check whether a resolved absolute path falls inside the workspace routes
 * directory (or IS the routes directory itself). Mirrors {@link isPluginsPath}:
 * the user-route dispatcher dynamic-imports any handler module written here
 * and executes its exported HTTP-method functions on the next matching
 * request, so a write here is code-injection risk.
 */
function isRoutesPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedRoutesDir = normalizeDirPath(context.routesDir);
  const routesDirNoTrailingSlash = normalizedRoutesDir.slice(0, -1);
  return (
    resolvedPath === routesDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedRoutesDir)
  );
}

/**
 * Check whether a resolved absolute path falls inside the workspace workflows
 * directory (or IS the workflows directory itself). Mirrors {@link isToolsPath}:
 * a file under `<workspace>/workflows/` is a saved workflow whose source is
 * executed (unattended when triggered by a schedule), so a write here is
 * code-injection risk.
 */
function isWorkflowsPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedWorkflowsDir = normalizeDirPath(context.workflowsDir);
  const workflowsDirNoTrailingSlash = normalizedWorkflowsDir.slice(0, -1);
  return (
    resolvedPath === workflowsDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedWorkflowsDir)
  );
}

/**
 * Check whether a resolved absolute path falls inside the monitoring data
 * directory (or IS the directory itself). The plugin source-versions
 * sentinel lives under this directory; a forged sentinel can redirect the
 * daemon's plugin loader to arbitrary paths, so writes here are treated as
 * code-injection risk.
 */
function isMonitoringPath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  const normalizedMonitoringDir = normalizeDirPath(context.monitoringDir);
  const monitoringDirNoTrailingSlash = normalizedMonitoringDir.slice(0, -1);
  return (
    resolvedPath === monitoringDirNoTrailingSlash ||
    resolvedPath.startsWith(normalizedMonitoringDir)
  );
}

/**
 * Check whether a resolved absolute path falls under any skill source
 * directory.
 */
function isSkillSourcePath(
  resolvedPath: string,
  context: FileClassificationContext,
): boolean {
  for (const dir of context.skillSourceDirs) {
    const normalizedDir = normalizeDirPath(dir);
    if (resolvedPath.startsWith(normalizedDir)) {
      return true;
    }
  }
  return false;
}

// -- Allowlist option helpers -------------------------------------------------

const FILE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  file_read: "file reads",
  file_write: "file writes",
  file_edit: "file edits",
  host_file_read: "host file reads",
  host_file_write: "host file writes",
  host_file_edit: "host file edits",
  host_file_transfer: "host file transfers",
};

function friendlyBasename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Build allowlist options for a file tool invocation. Options go from most
 * specific (exact file) to broadest (all operations of this tool type).
 */
function buildFileAllowlistOptions(
  toolName: string,
  filePath: string,
): AllowlistOption[] {
  const toolLabel = FILE_TOOL_DISPLAY_NAMES[toolName] ?? toolName;
  const options: AllowlistOption[] = [];

  // Exact file path
  options.push({
    label: filePath,
    description: "This file only",
    pattern: `${toolName}:${filePath}`,
  });

  // Ancestor directory wildcards — walk up from immediate parent, stop at home dir or /
  const home = homedir();
  let dir = dirname(filePath);
  const maxLevels = 3;
  let levels = 0;
  while (dir && dir !== "/" && dir !== "." && levels < maxLevels) {
    const dirName = friendlyBasename(dir);
    options.push({
      label: `${dir}/**`,
      description: `Anything in ${dirName}/`,
      pattern: `${toolName}:${dir}/**`,
    });
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    levels++;
  }

  // All operations of this tool type
  options.push({
    label: `${toolName}:*`,
    description: `All ${toolLabel}`,
    pattern: `${toolName}:*`,
  });

  return options;
}

/**
 * Classify a resolved (absolute) path against the code-injection sink
 * directories: skill source, hooks, plugins, tools, routes, and workflows. A
 * write to any of these plants code the daemon later executes, so it must clear
 * the High-risk approval gate. Returns a High assessment when the path lands in
 * a sink, or `null` when it doesn't.
 *
 * `verb` distinguishes the user-facing reason: "Writes" for write/edit tools,
 * "Transfers" for host_file_transfer.
 */
function classifyCodeInjectionSink(
  resolvedPath: string,
  context: FileClassificationContext,
  verb: "Writes" | "Transfers",
  allowlistOptions: AllowlistOption[],
): RiskAssessment | null {
  const high = (target: string): RiskAssessment => ({
    riskLevel: "high",
    reason: `${verb} to ${target}`,
    scopeOptions: [],
    matchType: "registry",
    allowlistOptions,
  });
  if (isSkillSourcePath(resolvedPath, context))
    return high("skill source code");
  if (isHooksPath(resolvedPath, context)) return high("hooks directory");
  if (isPluginsPath(resolvedPath, context)) return high("plugins directory");
  if (isToolsPath(resolvedPath, context)) return high("tools directory");
  if (isRoutesPath(resolvedPath, context)) return high("routes directory");
  if (isWorkflowsPath(resolvedPath, context))
    return high("workflows directory");
  if (isMonitoringPath(resolvedPath, context))
    return high("monitoring directory");
  return null;
}

/**
 * Run {@link classifyCodeInjectionSink} against both the lexical and the
 * symlink-resolved path, escalating if EITHER lands in a sink. A symlink can
 * mask a protected target two ways — a benign name pointing into a protected
 * dir (caught by the real path), or a path lexically inside a protected dir
 * pointing elsewhere, where the loader still executes the file through the
 * protected location (caught by the lexical path). When the two paths are
 * equal the check runs once.
 */
function classifyCodeInjectionSinkEither(
  lexicalPath: string,
  realPath: string,
  context: FileClassificationContext,
  verb: "Writes" | "Transfers",
  allowlistOptions: AllowlistOption[],
): RiskAssessment | null {
  const lexicalSink = classifyCodeInjectionSink(
    lexicalPath,
    context,
    verb,
    allowlistOptions,
  );
  if (lexicalSink) return lexicalSink;
  if (realPath === lexicalPath) return null;
  return classifyCodeInjectionSink(realPath, context, verb, allowlistOptions);
}

// -- Classifier ---------------------------------------------------------------

/**
 * File risk classifier implementation.
 *
 * Classifies all seven file tool types by risk level, with escalation paths
 * for the code-injection sinks (skill source, hooks, plugins, tools, routes,
 * and workflows) and the actor token signing key.
 *
 * Unlike the assistant version, this classifier accepts a
 * FileClassificationContext parameter on classify() instead of importing
 * assistant-specific platform utilities.
 */
export class FileRiskClassifier implements RiskClassifier<
  FileClassifierInput,
  [FileClassificationContext]
> {
  async classify(
    input: FileClassifierInput,
    context: FileClassificationContext,
  ): Promise<RiskAssessment> {
    const {
      toolName,
      filePath,
      workingDir,
      resolvedPath,
      transferSandboxDestPath,
      transferSandboxWorkingDir,
      resolvedTransferDestPath,
    } = input;
    const allowlistOptions = filePath
      ? buildFileAllowlistOptions(toolName, filePath)
      : [];

    // Run normal classification first (including all security escalations),
    // then check for user overrides at the end.
    let assessment: RiskAssessment;

    switch (toolName) {
      case "file_read": {
        if (filePath) {
          // Check BOTH the lexical path and the symlink-resolved path. A
          // symlink can mask a protected target two ways: a benign-looking
          // name that points into a protected dir (caught by the real path),
          // or a path lexically inside a protected dir that points elsewhere
          // (caught by the lexical path — the loader still reads it through the
          // protected location). Escalate if either matches.
          const lexicalPath = resolveSandboxPath(filePath, workingDir);
          const realPath = resolvedPath ?? lexicalPath;
          if (
            isActorTokenSigningKeyPath(lexicalPath, workingDir, context) ||
            isActorTokenSigningKeyPath(realPath, workingDir, context)
          ) {
            assessment = {
              riskLevel: "high",
              reason: "Reads actor token signing key",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
            break;
          }
        }
        assessment = {
          riskLevel: "low",
          reason: "File read (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
        break;
      }

      case "file_write":
      case "file_edit": {
        if (filePath) {
          const lexicalPath = resolveSandboxPath(filePath, workingDir);
          const realPath = resolvedPath ?? lexicalPath;
          const sink = classifyCodeInjectionSinkEither(
            lexicalPath,
            realPath,
            context,
            "Writes",
            allowlistOptions,
          );
          if (sink) {
            assessment = sink;
            break;
          }
        }
        assessment = {
          riskLevel: "low",
          reason: `File ${toolName === "file_write" ? "write" : "edit"} (default)`,
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
        break;
      }

      case "host_file_read": {
        // host_file_read has no special escalation paths — the tool registry
        // declares it as Medium risk, and classifyRiskFromRegistry falls through
        // to getTool() which returns that default.
        assessment = {
          riskLevel: "medium",
          reason: "Host file read (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
        break;
      }

      case "host_file_write":
      case "host_file_edit":
      case "host_file_transfer": {
        // "Writes" for write/edit (both mutate files), "Transfers" for transfer.
        const actionVerb =
          toolName === "host_file_transfer" ? "Transfers" : "Writes";

        // host_file_transfer to_sandbox: the workspace-side destination is the
        // file actually written into the sandbox, so it — not the host-side
        // source in `filePath` — is the code-injection sink. Check it first,
        // resolving with the same /workspace remap as sandbox file writes.
        if (transferSandboxDestPath) {
          const lexicalDest = resolveSandboxPath(
            transferSandboxDestPath,
            transferSandboxWorkingDir ?? process.cwd(),
          );
          const realDest = resolvedTransferDestPath ?? lexicalDest;
          const destSink = classifyCodeInjectionSinkEither(
            lexicalDest,
            realDest,
            context,
            "Transfers",
            allowlistOptions,
          );
          if (destSink) {
            assessment = destSink;
            break;
          }
        }

        if (filePath) {
          // Host file tools resolve paths without workingDir — resolve(filePath)
          // treats the path as absolute or relative to cwd. Check both the
          // lexical path and the symlink-resolved path from the caller.
          const lexicalPath = resolve(filePath);
          const realPath = resolvedPath ?? lexicalPath;
          const sink = classifyCodeInjectionSinkEither(
            lexicalPath,
            realPath,
            context,
            actionVerb,
            allowlistOptions,
          );
          if (sink) {
            assessment = sink;
            break;
          }
        }
        // Fall through to tool registry default (Medium).
        const defaultLabel =
          toolName === "host_file_write"
            ? "write"
            : toolName === "host_file_edit"
              ? "edit"
              : "transfer";
        assessment = {
          riskLevel: "medium",
          reason: `Host file ${defaultLabel} (default)`,
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
        break;
      }
    }

    // User override is applied after normal classification. This means a user-defined
    // rule CAN lower a security-escalated risk (e.g., actor-token-signing-key read).
    // This is intentional — user overrides are authoritative for users who explicitly
    // created them.
    try {
      const ruleCache = getTrustRuleCache();
      const override = ruleCache.findToolOverride(toolName, filePath);
      if (
        override &&
        (override.userModified || override.origin === "user_defined")
      ) {
        return {
          riskLevel: override.risk,
          reason: override.description,
          scopeOptions: [],
          matchType: "user_rule",
          allowlistOptions,
        };
      }
    } catch {
      // Cache not initialized — no override
    }

    return assessment!;
  }
}

/** Singleton classifier instance. */
export const fileRiskClassifier = new FileRiskClassifier();
