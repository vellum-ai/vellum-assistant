/**
 * File risk classifier — path-based risk classification for file tools.
 *
 * Implements RiskClassifier<FileClassifierInput> for all six file tool types:
 * file_read, file_write, file_edit, host_file_read, host_file_write, host_file_edit.
 *
 * Risk escalation paths:
 * - file_read: Low by default, High if targeting the actor token signing key.
 * - file_write / file_edit: Low by default, High if targeting skill source
 *   code or the workspace hooks directory.
 * - host_file_read: Medium (tool registry default; no special escalation).
 * - host_file_write / host_file_edit: Medium by default, High if targeting
 *   skill source code or the workspace hooks directory.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getConfig } from "../config/loader.js";
import {
  isSkillSourcePath,
  normalizeDirPath,
  normalizeFilePath,
} from "../skills/path-classifier.js";
import {
  getDeprecatedDir,
  getProtectedDir,
  getWorkspaceHooksDir,
} from "../util/platform.js";
import type { RiskAssessment, RiskClassifier } from "./risk-types.js";
import type { AllowlistOption } from "./types.js";

// ── Input type ───────────────────────────────────────────────────────────────

/** Input to the file risk classifier. */
export interface FileClassifierInput {
  toolName:
    | "file_read"
    | "file_write"
    | "file_edit"
    | "host_file_read"
    | "host_file_write"
    | "host_file_edit";
  filePath: string;
  workingDir: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether a resolved absolute path targets the actor token signing key.
 * Covers both the per-instance protected dir, the legacy global path, and
 * a relative "deprecated/actor-token-signing-key" resolved against workingDir.
 */
function isActorTokenSigningKeyPath(
  resolvedPath: string,
  workingDir: string,
): boolean {
  const signingKeyPaths = Array.from(
    new Set([
      join(homedir(), ".vellum", "protected", "actor-token-signing-key"),
      join(getProtectedDir(), "actor-token-signing-key"),
      join(getDeprecatedDir(), "actor-token-signing-key"),
      resolve(workingDir, "deprecated", "actor-token-signing-key"),
    ]),
  );
  return signingKeyPaths.includes(resolvedPath);
}

/**
 * Check whether a resolved absolute path falls inside the workspace hooks
 * directory (or IS the hooks directory itself).
 */
function isHooksPath(resolvedPath: string): boolean {
  const normalizedHooksDir = normalizeDirPath(getWorkspaceHooksDir());
  const normalizedPath = normalizeFilePath(resolvedPath);
  const hooksDirNoTrailingSlash = normalizedHooksDir.slice(0, -1);
  return (
    normalizedPath === hooksDirNoTrailingSlash ||
    normalizedPath.startsWith(normalizedHooksDir)
  );
}

// ── Allowlist option helpers ──────────────────────────────────────────────────

const FILE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  file_read: "file reads",
  file_write: "file writes",
  file_edit: "file edits",
  host_file_read: "host file reads",
  host_file_write: "host file writes",
  host_file_edit: "host file edits",
};

function friendlyBasename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Build allowlist options for a file tool invocation, mirroring the logic
 * in checker.ts `fileAllowlistStrategy()`. Options go from most specific
 * (exact file) to broadest (all operations of this tool type).
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

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * File risk classifier implementation.
 *
 * Replicates the exact risk classification logic from classifyRiskFromRegistry()
 * in checker.ts for all six file tool types.
 */
export class FileRiskClassifier implements RiskClassifier<FileClassifierInput> {
  async classify(input: FileClassifierInput): Promise<RiskAssessment> {
    const { toolName, filePath, workingDir } = input;
    const allowlistOptions = filePath
      ? buildFileAllowlistOptions(toolName, filePath)
      : [];

    switch (toolName) {
      case "file_read": {
        if (filePath) {
          const resolvedPath = resolve(workingDir, filePath);
          if (isActorTokenSigningKeyPath(resolvedPath, workingDir)) {
            return {
              riskLevel: "high",
              reason: "Reads actor token signing key",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
          }
        }
        return {
          riskLevel: "low",
          reason: "File read (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
      }

      case "file_write":
      case "file_edit": {
        if (filePath) {
          const resolvedPath = resolve(workingDir, filePath);
          if (
            isSkillSourcePath(resolvedPath, getConfig().skills.load.extraDirs)
          ) {
            return {
              riskLevel: "high",
              reason: "Writes to skill source code",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
          }
          if (isHooksPath(resolvedPath)) {
            return {
              riskLevel: "high",
              reason: "Writes to hooks directory",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
          }
        }
        return {
          riskLevel: "low",
          reason: `File ${toolName === "file_write" ? "write" : "edit"} (default)`,
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
      }

      case "host_file_read": {
        // host_file_read has no special escalation paths — the tool registry
        // declares it as Medium risk, and classifyRiskFromRegistry falls through
        // to getTool() which returns that default.
        return {
          riskLevel: "medium",
          reason: "Host file read (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
      }

      case "host_file_write":
      case "host_file_edit": {
        if (filePath) {
          // Host file tools resolve paths without workingDir — resolve(filePath)
          // treats the path as absolute or relative to cwd.
          const resolvedPath = resolve(filePath);
          if (
            isSkillSourcePath(resolvedPath, getConfig().skills.load.extraDirs)
          ) {
            return {
              riskLevel: "high",
              reason: "Writes to skill source code",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
          }
          if (isHooksPath(resolvedPath)) {
            return {
              riskLevel: "high",
              reason: "Writes to hooks directory",
              scopeOptions: [],
              matchType: "registry",
              allowlistOptions,
            };
          }
        }
        // Fall through to tool registry default (Medium).
        return {
          riskLevel: "medium",
          reason: `Host file ${toolName === "host_file_write" ? "write" : "edit"} (default)`,
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions,
        };
      }
    }
  }
}

/** Singleton classifier instance. */
export const fileRiskClassifier = new FileRiskClassifier();
