import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

/**
 * Directories/files to exclude from skill hashing — these are transient
 * runtime artifacts that do not affect the skill's behavior.
 */
const EXCLUDED_NAMES = new Set([
  ".vellum-skill-run",
  "node_modules",
  ".git",
  "__pycache__",
  ".DS_Store",
]);

/**
 * Collect all files under `dir` in sorted order, excluding transient entries.
 * Uses an `ancestors` set of real directory paths currently on the recursion
 * stack to detect symlink cycles without suppressing legitimate duplicate
 * symlink targets reached via different paths.
 */
function collectFiles(
  dir: string,
  base: string,
  ancestors: Set<string> = new Set(),
): string[] {
  const entries: string[] = [];

  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return entries;
  }
  if (ancestors.has(realDir)) return entries;
  ancestors.add(realDir);

  let items: string[];
  try {
    items = readdirSync(dir).sort();
  } catch {
    ancestors.delete(realDir);
    return entries;
  }

  for (const name of items) {
    if (EXCLUDED_NAMES.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = realpathSync(full);
      } catch {
        continue;
      }
      let resolvedStat;
      try {
        resolvedStat = statSync(resolved);
      } catch {
        continue;
      }
      if (resolvedStat.isDirectory()) {
        entries.push(...collectFiles(full, base, ancestors));
      } else if (resolvedStat.isFile()) {
        entries.push(relative(base, full));
      }
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(...collectFiles(full, base, ancestors));
    } else if (stat.isFile()) {
      entries.push(relative(base, full));
    }
  }

  ancestors.delete(realDir);
  return entries;
}

/**
 * Top-level provenance/usage metadata excluded from the version hash. These
 * files carry no skill behavior, and the `lastUsedAt` usage stamp rewrites
 * `install-meta.json` on load — including it here would trip version-change
 * detection on the first stamped load each day. Mirrors the content-hash
 * exclusion in `install-meta.ts`.
 */
const VERSION_HASH_EXCLUDED_FILES = new Set([
  "install-meta.json",
  "version.json",
]);

/**
 * Compute a deterministic version hash for a skill directory.
 *
 * The hash is computed from:
 * - Sorted relative file paths (normalized to forward slashes)
 * - File content lengths
 * - File content bytes
 *
 * The result is a canonical string in the format `v1:<hex-sha256>`.
 * File traversal order does not affect the result.
 */
export function computeSkillVersionHash(skillDir: string): string {
  const files = collectFiles(skillDir, skillDir);
  const hash = createHash("sha256");

  for (const relPath of files) {
    const normalized = relPath.replaceAll("\\", "/");
    // Skip top-level provenance/usage metadata so author tags and lastUsedAt
    // usage stamps never change the content-version hash.
    if (
      !normalized.includes("/") &&
      VERSION_HASH_EXCLUDED_FILES.has(normalized)
    ) {
      continue;
    }
    const content = readFileSync(join(skillDir, relPath));
    hash.update(normalized);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
    hash.update("\n");
  }

  return `v1:${hash.digest("hex")}`;
}
