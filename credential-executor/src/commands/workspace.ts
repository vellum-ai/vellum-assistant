/**
 * CES workspace staging and output copyback.
 *
 * Secure commands execute inside a CES-private scratch directory, never
 * directly in the assistant-visible workspace. This module handles:
 *
 * 1. **Input staging** — Copies declared workspace inputs into a
 *    CES-private scratch directory and marks them read-only. The command
 *    reads inputs from the scratch directory, never from the workspace
 *    directly.
 *
 * 2. **Output copyback** — After command execution, only declared output
 *    files are copied from the scratch directory back into the workspace.
 *    Each output file is validated:
 *    - It must be declared in the command's output manifest.
 *    - Its path must not escape the scratch directory (path traversal).
 *    - It must not be a symlink pointing outside the scratch directory.
 *    - Its content is scanned for secret leakage before copyback.
 *
 * This staging model ensures that:
 * - Commands cannot write arbitrary files into the workspace.
 * - Commands cannot read undeclared workspace files.
 * - Secret material never leaks into assistant-visible outputs.
 * - The behavior is identical for local and managed CES execution.
 */

import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

import { getCesDataRoot, type CesMode } from "../paths.js";
import { scanOutputFile, type OutputScanResult } from "./output-scan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Declares a file to be staged from the assistant workspace into the
 * CES scratch directory before command execution.
 */
export interface WorkspaceInput {
  /**
   * Relative path within the assistant workspace directory.
   * Must not contain `..` segments or absolute paths.
   */
  workspacePath: string;
}

/**
 * Declares a file that the command is expected to produce in the scratch
 * directory. Only declared outputs are eligible for copyback.
 */
export interface WorkspaceOutput {
  /**
   * Relative path within the scratch directory where the command writes
   * its output. Must not contain `..` segments or absolute paths.
   */
  scratchPath: string;

  /**
   * Relative path within the assistant workspace where the output should
   * be copied. Must not contain `..` segments or absolute paths.
   */
  workspacePath: string;
}

/**
 * Configuration for workspace staging and output copyback.
 */
export interface WorkspaceStageConfig {
  /** Absolute path to the assistant-visible workspace directory. */
  workspaceDir: string;
  /** Files to stage as read-only inputs in the scratch directory. */
  inputs: WorkspaceInput[];
  /** Files to copy back from the scratch directory after execution. */
  outputs: WorkspaceOutput[];
  /**
   * Set of known secret values injected into the command environment.
   * Used for output scanning.
   */
  secrets: ReadonlySet<string>;
}

/**
 * Result of preparing a staged workspace for command execution.
 */
export interface StagedWorkspace {
  /** Absolute path to the CES-private scratch directory. */
  scratchDir: string;
  /** List of input files that were staged (relative to scratch dir). */
  stagedInputs: string[];
}

/**
 * Result of attempting to copy a single output back to the workspace.
 */
export interface OutputCopyResult {
  /** The declared scratch path. */
  scratchPath: string;
  /** The target workspace path. */
  workspacePath: string;
  /** Whether the copy was successful. */
  success: boolean;
  /** Reason for failure (undefined when successful). */
  reason?: string;
  /** Output scan result (undefined when copy was rejected before scanning). */
  scanResult?: OutputScanResult;
}

/**
 * Result of the full output copyback phase.
 */
export interface CopybackResult {
  /** Individual results for each declared output. */
  outputs: OutputCopyResult[];
  /** Whether all declared outputs were copied successfully. */
  allSucceeded: boolean;
}

// ---------------------------------------------------------------------------
// Path validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a relative path does not attempt directory traversal.
 * Returns an error string if invalid, undefined if valid.
 */
export function validateRelativePath(
  relativePath: string,
  label: string,
): string | undefined {
  // Must not be absolute
  if (relativePath.startsWith("/")) {
    return `${label}: "${relativePath}" is an absolute path. Only relative paths are allowed.`;
  }

  // Must not contain .. segments
  const segments = relativePath.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return `${label}: "${relativePath}" contains ".." path traversal. This is not allowed.`;
    }
  }

  // Must not be empty
  if (relativePath.trim().length === 0) {
    return `${label}: path is empty.`;
  }

  return undefined;
}

/**
 * Verify that a resolved path is contained within the expected root
 * directory. When the path exists on disk, symlinks are fully resolved
 * via `realpathSync` so that symlinked segments cannot escape the root.
 * When the path doesn't exist yet, its closest existing ancestor is
 * resolved via `realpathSync` to ensure consistent symlink handling
 * (e.g. `/tmp` → `/private/tmp` on macOS).
 */
export function validateContainedPath(
  resolvedPath: string,
  rootDir: string,
  label: string,
): string | undefined {
  // Resolve symlinks when path exists; fall back to lexical resolve
  let normalizedRoot: string;
  let normalizedPath: string;
  try {
    normalizedRoot = realpathSync(rootDir);
  } catch {
    normalizedRoot = resolve(rootDir);
  }
  try {
    normalizedPath = realpathSync(resolvedPath);
  } catch {
    // Path doesn't exist yet — walk up to the nearest existing ancestor and
    // resolve it via realpathSync so that symlinks in parent dirs (e.g.
    // /tmp → /private/tmp on macOS) are resolved consistently with the root
    // directory. A single dirname call isn't enough for multi-level
    // non-existent paths like "reports/output.json" where "reports/" also
    // doesn't exist.
    let current = resolvedPath;
    let resolved = false;
    while (!resolved) {
      const ancestor = dirname(current);
      const tail = current.slice(ancestor.length);
      try {
        normalizedPath = realpathSync(ancestor) + tail;
        resolved = true;
      } catch {
        if (ancestor === current) {
          // Reached filesystem root without finding an existing ancestor
          normalizedPath = resolve(resolvedPath);
          resolved = true;
        }
        current = ancestor;
      }
    }
  }

  const rootPrefix = normalizedRoot + "/";

  // The path must start with the root directory prefix
  // (or be the root directory itself, though that's unusual for files)
  if (!normalizedPath.startsWith(rootPrefix) && normalizedPath !== normalizedRoot) {
    return `${label}: resolved path "${normalizedPath}" escapes the root directory "${normalizedRoot}".`;
  }
  return undefined;
}

/**
 * Check if a path (or any of its parent components) involves symlinks
 * that resolve outside the given root directory.
 *
 * Uses `realpathSync` to fully resolve all symlink chains (including
 * chained symlinks and symlinked parent directories) and then validates
 * that the fully-resolved path is still within the root.
 */
export function checkSymlinkEscape(
  filePath: string,
  rootDir: string,
  label: string,
): string | undefined {
  try {
    // Fully resolve all symlinks (handles chained symlinks and
    // symlinked parent directories in a single call)
    const resolvedTarget = realpathSync(filePath);
    const resolvedRoot = realpathSync(rootDir);
    const rootPrefix = resolvedRoot + "/";

    if (
      !resolvedTarget.startsWith(rootPrefix) &&
      resolvedTarget !== resolvedRoot
    ) {
      return `${label}: path "${filePath}" resolves to "${resolvedTarget}" which is outside the scratch directory "${resolvedRoot}".`;
    }
  } catch {
    // If we can't resolve the file, it doesn't exist yet or is inaccessible.
    // This will be caught later during the actual copy.
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scratch directory management
// ---------------------------------------------------------------------------

/**
 * Return the base directory for CES scratch workspaces.
 */
export function getScratchBaseDir(mode?: CesMode): string {
  return join(getCesDataRoot(mode), "scratch");
}

/**
 * Create a new scratch directory for a command execution.
 * Returns the absolute path to the new scratch directory.
 */
export function createScratchDir(mode?: CesMode): string {
  const scratchBase = getScratchBaseDir(mode);
  const scratchDir = join(scratchBase, randomUUID());
  mkdirSync(scratchDir, { recursive: true });
  return scratchDir;
}

/**
 * Clean up a scratch directory after command execution.
 */
export function cleanupScratchDir(scratchDir: string): void {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — log but don't fail
  }
}

// ---------------------------------------------------------------------------
// Input staging
// ---------------------------------------------------------------------------

/**
 * Stage workspace inputs into a CES-private scratch directory.
 *
 * Each declared input is:
 * 1. Validated for path traversal.
 * 2. Copied from the workspace to the scratch directory.
 * 3. Made read-only (chmod 0o444).
 *
 * @returns The staged workspace descriptor, or throws on validation failure.
 */
export function stageInputs(
  config: WorkspaceStageConfig,
  mode?: CesMode,
): StagedWorkspace {
  const scratchDir = createScratchDir(mode);
  const stagedInputs: string[] = [];

  try {
    for (const input of config.inputs) {
      // Validate relative path
      const pathError = validateRelativePath(
        input.workspacePath,
        "Workspace input",
      );
      if (pathError) {
        throw new Error(pathError);
      }

      const sourcePath = join(config.workspaceDir, input.workspacePath);
      const destPath = join(scratchDir, input.workspacePath);

      // Validate the resolved source is within the workspace
      const containedError = validateContainedPath(
        sourcePath,
        config.workspaceDir,
        "Workspace input source",
      );
      if (containedError) {
        throw new Error(containedError);
      }

      // Check source exists
      if (!existsSync(sourcePath)) {
        throw new Error(
          `Workspace input "${input.workspacePath}" does not exist in workspace at "${sourcePath}".`,
        );
      }

      // Ensure destination directory exists
      mkdirSync(dirname(destPath), { recursive: true });

      // Copy the file
      copyFileSync(sourcePath, destPath);

      // Make read-only (owner + group + others can read, nobody can write)
      chmodSync(destPath, 0o444);

      stagedInputs.push(input.workspacePath);
    }
  } catch (err) {
    // Clean up scratch dir on failure
    cleanupScratchDir(scratchDir);
    throw err;
  }

  return { scratchDir, stagedInputs };
}

// ---------------------------------------------------------------------------
// Output copyback
// ---------------------------------------------------------------------------

/**
 * Copy declared output files from the scratch directory back to the
 * assistant workspace, after validation and scanning.
 *
 * Each declared output is:
 * 1. Validated for path traversal (both scratch and workspace paths).
 * 2. Checked that it exists in the scratch directory.
 * 3. Checked for symlink escape (must not point outside scratch dir).
 * 4. Scanned for secret leakage and auth-bearing artifacts.
 * 5. Copied to the workspace if all checks pass.
 *
 * @returns A {@link CopybackResult} with individual results per output.
 */
export function copybackOutputs(
  config: WorkspaceStageConfig,
  scratchDir: string,
): CopybackResult {
  const results: OutputCopyResult[] = [];

  for (const output of config.outputs) {
    const result = copybackSingleOutput(
      output,
      scratchDir,
      config.workspaceDir,
      config.secrets,
    );
    results.push(result);
  }

  return {
    outputs: results,
    allSucceeded: results.every((r) => r.success),
  };
}

/**
 * Copy back a single output file with full validation.
 */
function copybackSingleOutput(
  output: WorkspaceOutput,
  scratchDir: string,
  workspaceDir: string,
  secrets: ReadonlySet<string>,
): OutputCopyResult {
  // -- Validate scratch path
  const scratchPathError = validateRelativePath(
    output.scratchPath,
    "Output scratch path",
  );
  if (scratchPathError) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: scratchPathError,
    };
  }

  // -- Validate workspace path
  const workspacePathError = validateRelativePath(
    output.workspacePath,
    "Output workspace path",
  );
  if (workspacePathError) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: workspacePathError,
    };
  }

  const scratchFilePath = join(scratchDir, output.scratchPath);
  const workspaceFilePath = join(workspaceDir, output.workspacePath);

  // -- Validate containment (scratch)
  const scratchContainedError = validateContainedPath(
    scratchFilePath,
    scratchDir,
    "Output scratch file",
  );
  if (scratchContainedError) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: scratchContainedError,
    };
  }

  // -- Validate containment (workspace)
  const workspaceContainedError = validateContainedPath(
    workspaceFilePath,
    workspaceDir,
    "Output workspace file",
  );
  if (workspaceContainedError) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: workspaceContainedError,
    };
  }

  // -- Check file exists in scratch
  if (!existsSync(scratchFilePath)) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: `Output file "${output.scratchPath}" does not exist in scratch directory.`,
    };
  }

  // -- Check symlink escape
  const symlinkError = checkSymlinkEscape(
    scratchFilePath,
    scratchDir,
    "Output file",
  );
  if (symlinkError) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: symlinkError,
    };
  }

  // -- Read and scan the file
  let content: Buffer;
  try {
    // If it's a symlink, resolve it first to read the actual content
    const stat = lstatSync(scratchFilePath);
    if (stat.isSymbolicLink()) {
      const realPath = realpathSync(scratchFilePath);
      content = readFileSync(realPath);
    } else {
      content = readFileSync(scratchFilePath);
    }
  } catch (err) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: `Failed to read output file "${output.scratchPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const scanResult = scanOutputFile(
    basename(output.scratchPath),
    content,
    secrets,
  );

  if (!scanResult.safe) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: `Output file "${output.scratchPath}" failed security scan: ${scanResult.violations.join("; ")}`,
      scanResult,
    };
  }

  // -- Copy to workspace
  try {
    mkdirSync(dirname(workspaceFilePath), { recursive: true });
    copyFileSync(scratchFilePath, workspaceFilePath);
  } catch (err) {
    return {
      scratchPath: output.scratchPath,
      workspacePath: output.workspacePath,
      success: false,
      reason: `Failed to copy output to workspace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    scratchPath: output.scratchPath,
    workspacePath: output.workspacePath,
    success: true,
    scanResult,
  };
}
