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
 *   code or the workspace hooks directory.
 * - host_file_read: Medium (tool registry default; no special escalation).
 * - host_file_write / host_file_edit: Medium by default, High if targeting
 *   skill source code or the workspace hooks directory.
 * - host_file_transfer: Medium by default, High if the host-side path
 *   targets skill source code or the workspace hooks directory.
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
}

// -- Helpers ------------------------------------------------------------------

/**
 * Normalize a directory path: ensure it ends with `/` for prefix matching.
 */
function normalizeDirPath(dirPath: string): string {
  return dirPath.endsWith("/") ? dirPath : dirPath + "/";
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

// -- Classifier ---------------------------------------------------------------

/**
 * File risk classifier implementation.
 *
 * Classifies all six file tool types by risk level, with escalation paths
 * for skill source code, workspace hooks, and the actor token signing key.
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
    const { toolName, filePath, workingDir } = input;
    const allowlistOptions = filePath
      ? buildFileAllowlistOptions(toolName, filePath)
      : [];

    // Run normal classification first (including all security escalations),
    // then check for user overrides at the end.
    let assessment: RiskAssessment;

    switch (toolName) {
      case "file_read": {
        if (filePath) {
          const resolvedPath = resolve(workingDir, filePath);
          if (isActorTokenSigningKeyPath(resolvedPath, workingDir, context)) {
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
          const resolvedPath = resolve(workingDir, filePath);
          if (isSkillSourcePath(resolvedPath, context)) {
            assessment = {
              riskLevel: "high",
              reason: "Writes to skill source code",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
            break;
          }
          if (isHooksPath(resolvedPath, context)) {
            assessment = {
              riskLevel: "high",
              reason: "Writes to hooks directory",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
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
        if (filePath) {
          // Host file tools resolve paths without workingDir — resolve(filePath)
          // treats the path as absolute or relative to cwd.
          const resolvedPath = resolve(filePath);
          if (isSkillSourcePath(resolvedPath, context)) {
            assessment = {
              riskLevel: "high",
              reason: `${actionVerb} to skill source code`,
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
            break;
          }
          if (isHooksPath(resolvedPath, context)) {
            assessment = {
              riskLevel: "high",
              reason: `${actionVerb} to hooks directory`,
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
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
