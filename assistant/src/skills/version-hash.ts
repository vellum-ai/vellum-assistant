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
 */
function collectFiles(dir: string, base: string): string[] {
  const entries: string[] = [];

  let items: string[];
  try {
    items = readdirSync(dir).sort();
  } catch {
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
        // Skip directory symlinks that resolve into the skill dir to avoid loops
        let realBase: string;
        try {
          realBase = realpathSync(base);
        } catch {
          continue;
        }
        const relToBase = relative(realBase, resolved);
        if (!relToBase.startsWith('..') && !relToBase.startsWith('/')) continue;
        entries.push(...collectFiles(full, base));
      } else if (resolvedStat.isFile()) {
        entries.push(relative(base, full));
      }
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(...collectFiles(full, base));
    } else if (stat.isFile()) {
      entries.push(relative(base, full));
    }
  }

  return entries;
}

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

  return `v1:${hash.digest('hex')}`;
}
