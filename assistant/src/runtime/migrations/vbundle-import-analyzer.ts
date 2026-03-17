/**
 * Analyzes a validated .vbundle archive to produce a dry-run import report.
 *
 * Given a valid .vbundle archive (already validated), this module inspects
 * its manifest and contents to determine what would happen if the bundle
 * were imported. It compares the bundle's files against the current
 * assistant state on disk and reports:
 * - Which files would be written or overwritten
 * - Size changes for each file
 * - Whether existing data would be replaced
 * - Any potential conflicts
 *
 * This is a read-only analysis — no files are written or modified.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ManifestType } from "./vbundle-validator.js";

/** Only these prompt filenames are accepted during import. */
const ALLOWED_PROMPT_FILENAMES = new Set([
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "UPDATES.md",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportAction = "create" | "overwrite" | "unchanged" | "skip";

export interface ImportFileReport {
  /** Archive path (e.g. "data/db/assistant.db") */
  path: string;
  /** What would happen to this file on import */
  action: ImportAction;
  /** Size of the file in the bundle (bytes) */
  bundle_size: number;
  /** Size of the existing file on disk, or null if it does not exist */
  current_size: number | null;
  /** SHA-256 of the file in the bundle */
  bundle_sha256: string;
  /** SHA-256 of the existing file on disk, or null if it does not exist */
  current_sha256: string | null;
}

export interface ImportConflict {
  code: string;
  message: string;
  path?: string;
}

export interface ImportDryRunReport {
  /** Whether the import can proceed (bundle is valid and no blocking conflicts) */
  can_import: boolean;
  /** Summary of what would happen */
  summary: {
    total_files: number;
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    files_to_skip: number;
  };
  /** Per-file analysis of what would change */
  files: ImportFileReport[];
  /** Any conflicts or warnings that might block or complicate import */
  conflicts: ImportConflict[];
  /** The manifest from the bundle */
  manifest: ManifestType;
}

// ---------------------------------------------------------------------------
// Path mapping
// ---------------------------------------------------------------------------

/**
 * Maps archive paths to their corresponding locations on disk.
 * This is the canonical mapping used during actual import (PR-5) —
 * dry-run uses the same mapping for consistency.
 */
export interface PathResolver {
  resolve(archivePath: string): string | null;
}

export class DefaultPathResolver implements PathResolver {
  constructor(
    private protectedDir?: string,
    private workspaceDir?: string,
  ) {}

  resolve(archivePath: string): string | null {
    // New format: workspace/ prefix — maps directly into the workspace dir
    if (archivePath.startsWith("workspace/") && this.workspaceDir) {
      const relPath = archivePath.slice("workspace/".length);
      if (!relPath) return null;
      const resolved = resolve(this.workspaceDir, relPath);
      const wsRoot = resolve(this.workspaceDir);
      // Path traversal containment
      if (resolved !== wsRoot && !resolved.startsWith(wsRoot + "/")) {
        return null;
      }
      return resolved;
    }

    // Backward compat: old bundle formats with specific archive paths
    if (archivePath === "data/db/assistant.db" && this.workspaceDir) {
      return join(this.workspaceDir, "data", "db", "assistant.db");
    }
    if (archivePath === "config/settings.json" && this.workspaceDir) {
      return join(this.workspaceDir, "config.json");
    }
    if (archivePath === "trust/trust.json" && this.protectedDir) {
      return join(this.protectedDir, "trust.json");
    }
    if (archivePath.startsWith("skills/") && this.workspaceDir) {
      const resolved = resolve(
        this.workspaceDir,
        "skills",
        archivePath.slice("skills/".length),
      );
      const skillsRoot = resolve(this.workspaceDir, "skills");
      if (resolved !== skillsRoot && !resolved.startsWith(skillsRoot + "/")) {
        return null;
      }
      return resolved;
    }
    if (archivePath.startsWith("prompts/") && this.workspaceDir) {
      // Old bundles stored prompts as prompts/IDENTITY.md etc — these map
      // to the workspace root (e.g. workspace/IDENTITY.md).
      // Only accepted prompt filenames resolve — unknown entries are
      // skipped so they cannot trigger workspace clearing.
      const filename = archivePath.slice("prompts/".length);
      if (!ALLOWED_PROMPT_FILENAMES.has(filename)) {
        return null;
      }
      const resolved = resolve(this.workspaceDir, filename);
      const wsRoot = resolve(this.workspaceDir);
      if (resolved !== wsRoot && !resolved.startsWith(wsRoot + "/")) {
        return null;
      }
      return resolved;
    }
    if (archivePath.startsWith("hooks/") && this.workspaceDir) {
      const resolved = resolve(
        this.workspaceDir,
        "hooks",
        archivePath.slice("hooks/".length),
      );
      const hooksRoot = resolve(this.workspaceDir, "hooks");
      if (resolved !== hooksRoot && !resolved.startsWith(hooksRoot + "/")) {
        return null;
      }
      return resolved;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Core analyzer
// ---------------------------------------------------------------------------

export interface AnalyzeImportOptions {
  /** The parsed and validated manifest from the bundle */
  manifest: ManifestType;
  /** Resolves archive paths to disk paths for comparison */
  pathResolver: PathResolver;
}

/**
 * Analyze what importing a .vbundle archive would do without modifying
 * any state. Compares bundle contents against current files on disk.
 */
export function analyzeImport(
  options: AnalyzeImportOptions,
): ImportDryRunReport {
  const { manifest, pathResolver } = options;
  const files: ImportFileReport[] = [];
  const conflicts: ImportConflict[] = [];

  for (const fileEntry of manifest.files) {
    const diskPath = pathResolver.resolve(fileEntry.path);

    if (!diskPath) {
      // Unknown archive path — would have nowhere to write
      conflicts.push({
        code: "UNKNOWN_ARCHIVE_PATH",
        message: `Archive path "${fileEntry.path}" has no known disk target — it would be skipped during import`,
        path: fileEntry.path,
      });
      files.push({
        path: fileEntry.path,
        action: "skip",
        bundle_size: fileEntry.size,
        bundle_sha256: fileEntry.sha256,
        current_size: null,
        current_sha256: null,
      });
      continue;
    }

    let currentSize: number | null = null;
    let currentSha256: string | null = null;
    let action: ImportAction;

    if (existsSync(diskPath)) {
      try {
        const stat = statSync(diskPath);
        currentSize = stat.size;
        const diskData = new Uint8Array(readFileSync(diskPath));
        currentSha256 = sha256Hex(diskData);
      } catch {
        // If we cannot read the file, treat it as a conflict
        conflicts.push({
          code: "UNREADABLE_EXISTING_FILE",
          message: `Cannot read existing file at disk path for "${fileEntry.path}" — import would overwrite it`,
          path: fileEntry.path,
        });
        action = "overwrite";
        files.push({
          path: fileEntry.path,
          action,
          bundle_size: fileEntry.size,
          bundle_sha256: fileEntry.sha256,
          current_size: currentSize,
          current_sha256: currentSha256,
        });
        continue;
      }

      if (currentSha256 === fileEntry.sha256) {
        action = "unchanged";
      } else {
        action = "overwrite";
      }
    } else {
      action = "create";
    }

    files.push({
      path: fileEntry.path,
      action,
      bundle_size: fileEntry.size,
      bundle_sha256: fileEntry.sha256,
      current_size: currentSize,
      current_sha256: currentSha256,
    });
  }

  const summary = {
    total_files: files.length,
    files_to_create: files.filter((f) => f.action === "create").length,
    files_to_overwrite: files.filter((f) => f.action === "overwrite").length,
    files_unchanged: files.filter((f) => f.action === "unchanged").length,
    files_to_skip: files.filter((f) => f.action === "skip").length,
  };

  return {
    can_import: conflicts.length === 0,
    summary,
    files,
    conflicts,
    manifest,
  };
}
