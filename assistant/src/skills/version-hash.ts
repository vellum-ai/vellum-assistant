import { readdirSync, readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Directories/files to exclude from skill hashing — these are transient
 * runtime artifacts that do not affect the skill's behavior.
 */
const EXCLUDED_NAMES = new Set([
  '.vellum-skill-run',
  'node_modules',
  '.git',
  '__pycache__',
  '.DS_Store',
]);

/**
 * Collect all files under `dir` in sorted order, excluding transient entries.
 * Uses an `ancestors` set of real directory paths currently on the recursion
 * stack to detect symlink cycles without suppressing legitimate duplicate
 * symlink targets reached via different paths.
 */
function collectFiles(dir: string, base: string, ancestors: Set<string> = new Set()): string[] {
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

// ---------------------------------------------------------------------------
// In-memory TTL cache for computed hashes — avoids redundant filesystem I/O
// when the same skill directory is hashed multiple times within a short window.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  hash: string;
  expiresAt: number;
}

const hashCache = new Map<string, CacheEntry>();

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
 *
 * Results are cached in memory for 60 seconds to avoid redundant disk reads.
 */
export function computeSkillVersionHash(skillDir: string): string {
  const now = Date.now();
  const cached = hashCache.get(skillDir);
  if (cached && now < cached.expiresAt) {
    return cached.hash;
  }

  const files = collectFiles(skillDir, skillDir);
  const hash = createHash('sha256');

  for (const relPath of files) {
    const normalized = relPath.replaceAll('\\', '/');
    const content = readFileSync(join(skillDir, relPath));
    hash.update(normalized);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\n');
  }

  const result = `v1:${hash.digest('hex')}`;
  hashCache.set(skillDir, { hash: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

/**
 * Invalidate the cached hash for a specific skill directory, or clear the
 * entire cache if no directory is specified.
 */
export function invalidateSkillVersionHashCache(skillDir?: string): void {
  if (skillDir) {
    hashCache.delete(skillDir);
  } else {
    hashCache.clear();
  }
}
