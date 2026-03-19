/**
 * Workspace migration 009: Rename UUID-based app directories and files to
 * human-readable slugified names.
 *
 * Inline slugify + dedup logic (not imported from app-store) so the migration
 * remains stable even if runtime code changes in the future.
 *
 * Idempotent: safe to re-run after interruption at any point. Handles
 * partially-renamed states (crash between JSON write and file rename).
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceMigration } from "./types.js";

// ---------------------------------------------------------------------------
// Self-contained slug generation (do NOT import from app-store)
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > 60) {
    slug = slug.slice(0, 60).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `app-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

function generateUniqueDirName(name: string, usedNames: Set<string>): string {
  const base = slugify(name);
  if (!usedNames.has(base)) return base;
  let counter = 2;
  while (usedNames.has(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

/** Defense-in-depth: reject dirNames that could cause path traversal. */
function isValidDirName(dirName: string): boolean {
  return (
    !!dirName &&
    !dirName.includes("/") &&
    !dirName.includes("\\") &&
    !dirName.includes("..") &&
    dirName === dirName.trim()
  );
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const appDirRenameMigration: WorkspaceMigration = {
  id: "009-app-dir-rename",
  description:
    "Rename UUID-based app directories and files to human-readable slugified names",

  run(workspaceDir: string): void {
    const appsDir = join(workspaceDir, "data", "apps");
    if (!existsSync(appsDir)) return;

    // Read all JSON files (sorted for deterministic ordering)
    const jsonFiles = readdirSync(appsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    if (jsonFiles.length === 0) return;

    const usedNames = new Set<string>();

    for (const jsonFile of jsonFiles) {
      const jsonPath = join(appsDir, jsonFile);
      let raw: string;
      try {
        raw = readFileSync(jsonPath, "utf-8");
      } catch {
        continue; // skip unreadable files
      }

      let parsed: {
        id?: string;
        name?: string;
        dirName?: string;
      };
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // skip malformed JSON
      }

      const appId = parsed.id;
      const appName = parsed.name ?? "untitled";
      if (!appId) continue;

      // Check if already migrated: has dirName AND filesystem matches
      if (parsed.dirName && isValidDirName(parsed.dirName)) {
        const expectedJsonFile = `${parsed.dirName}.json`;
        if (
          jsonFile === expectedJsonFile &&
          existsSync(join(appsDir, parsed.dirName))
        ) {
          // Already fully migrated -- just track the name
          usedNames.add(parsed.dirName);
          continue;
        }

        // Partially renamed: JSON has dirName but files may still be at old paths.
        // Use the dirName from JSON but rename from wherever the files actually are.
        const dirName = parsed.dirName;
        usedNames.add(dirName);
        renameAppFiles(appsDir, jsonFile, appId, dirName, parsed, raw);
        continue;
      }

      // No dirName yet -- generate one
      const dirName = generateUniqueDirName(appName, usedNames);
      if (!isValidDirName(dirName)) continue; // safety check
      usedNames.add(dirName);
      renameAppFiles(appsDir, jsonFile, appId, dirName, parsed, raw);
    }

    // Best-effort git commit
    try {
      const gitDir = join(appsDir, ".git");
      if (existsSync(gitDir)) {
        execSync(
          "git add -A && git commit -m 'Migration 009: rename app dirs to slugified names' --allow-empty",
          {
            cwd: appsDir,
            stdio: "ignore",
            timeout: 10_000,
          },
        );
      }
    } catch {
      // Git failure is non-fatal -- log nothing since we don't have
      // the logger available in migrations. The next commitAppChange()
      // call will pick up the renamed files naturally.
    }
  },
};

/**
 * Rename app files from their current location to dirName-based paths.
 * Each step checks existence to handle partial completion.
 */
function renameAppFiles(
  appsDir: string,
  currentJsonFile: string,
  appId: string,
  dirName: string,
  parsed: Record<string, unknown>,
  _rawJson: string,
): void {
  const targetJsonFile = `${dirName}.json`;
  const targetPreviewFile = `${dirName}.preview`;

  // 1. Rename the app directory: {appId}/ -> {dirName}/
  const oldDir = join(appsDir, appId);
  const newDir = join(appsDir, dirName);
  if (existsSync(oldDir) && !existsSync(newDir) && oldDir !== newDir) {
    renameSync(oldDir, newDir);
  } else if (!existsSync(newDir)) {
    // Directory doesn't exist at either location -- create it
    mkdirSync(newDir, { recursive: true });
  }

  // 2. Rename the preview file: {appId}.preview -> {dirName}.preview
  const oldPreview = join(appsDir, `${appId}.preview`);
  const newPreview = join(appsDir, targetPreviewFile);
  if (
    existsSync(oldPreview) &&
    !existsSync(newPreview) &&
    oldPreview !== newPreview
  ) {
    renameSync(oldPreview, newPreview);
  }

  // 3. Rename the JSON file: {currentFilename} -> {dirName}.json
  //    Also update the dirName field in the JSON content.
  const currentJsonPath = join(appsDir, currentJsonFile);
  const targetJsonPath = join(appsDir, targetJsonFile);

  // Update the JSON with dirName field
  const updatedParsed = { ...parsed, dirName };
  const updatedJson = JSON.stringify(updatedParsed, null, 2);

  if (currentJsonFile !== targetJsonFile) {
    // Write to new location, then remove old
    writeFileSync(targetJsonPath, updatedJson, "utf-8");
    if (existsSync(currentJsonPath) && currentJsonPath !== targetJsonPath) {
      try {
        unlinkSync(currentJsonPath);
      } catch {
        // Old file cleanup is best-effort
      }
    }
  } else {
    // Just update the content in place
    writeFileSync(targetJsonPath, updatedJson, "utf-8");
  }
}
