import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getLogger } from '../util/logger.js';

const log = getLogger('cc-commands');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CCCommandEntry {
  /** Command name: basename without .md extension. */
  name: string;
  /** First non-empty line after frontmatter, stripped of heading markers. */
  summary: string;
  /** Absolute path to the .md file. */
  filePath: string;
  /** Directory containing the `.claude/commands/` or `.claude/skills/` folder. */
  source: string;
  /** Whether this entry was discovered from a `commands/` or `skills/` directory. */
  artifactType: 'command' | 'skill';
}

export interface CCCommandRegistry {
  /** Commands keyed by lowercase name. */
  entries: Map<string, CCCommandEntry>;
  /** Timestamp (ms) when discovery was performed. */
  discoveredAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const COMMAND_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_SUMMARY_LENGTH = 100;

/**
 * Maximum bytes to read from each command file during discovery.
 * 1 KiB is enough for frontmatter (typically < 200 B) plus several content
 * lines, which is all we need to extract a one-line summary.
 */
const SUMMARY_READ_BYTES = 1024;

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, CCCommandRegistry>();

/** Clear all cached registries. */
export function invalidateCCCommandCache(): void {
  cache.clear();
  log.debug('CC command cache invalidated');
}

// ─── Partial I/O ─────────────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` from the beginning of a file.
 * Uses low-level `openSync`/`readSync` so we never pull the entire file into
 * memory — important when command templates are large but we only need the
 * first few lines for summary extraction.
 */
function readFileHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

// ─── Summary extraction ──────────────────────────────────────────────────────

/**
 * Extract a one-line summary from the beginning of a markdown file.
 * Skips YAML frontmatter if present, then returns the first non-empty line
 * with leading `#` heading markers stripped. Truncates to 100 chars.
 */
function extractSummary(content: string): string {
  // Strip frontmatter if present
  let body = content;
  const fmMatch = content.match(FRONTMATTER_REGEX);
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
  }

  // Find first non-empty line
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Strip leading # heading markers
    const stripped = trimmed.replace(/^#+\s*/, '');
    if (!stripped) continue;

    // Truncate if needed
    if (stripped.length > MAX_SUMMARY_LENGTH) {
      return stripped.slice(0, MAX_SUMMARY_LENGTH);
    }
    return stripped;
  }

  return '';
}

// ─── Artifact scanning ───────────────────────────────────────────────────────

/**
 * Scan a single `.claude/commands/` or `.claude/skills/` directory and add
 * discovered entries to `entries`. Entries that already exist in the map are
 * skipped (child-level / higher-precedence entries win).
 */
function scanArtifactDir(
  dir: string,
  artifactType: 'command' | 'skill',
  source: string,
  entries: Map<string, CCCommandEntry>,
): void {
  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith('.md')) continue;

      const nameWithoutExt = basename(file.name, '.md');

      // Validate command name
      if (!COMMAND_NAME_REGEX.test(nameWithoutExt) || nameWithoutExt.includes('..')) {
        log.warn({ fileName: file.name, dir }, 'Skipping invalid CC artifact filename');
        continue;
      }

      const key = nameWithoutExt.toLowerCase();

      // Skip if already discovered from a closer ancestor or higher-precedence source
      if (entries.has(key)) continue;

      const filePath = join(dir, file.name);

      let summary = '';
      try {
        const head = readFileHead(filePath, SUMMARY_READ_BYTES);
        summary = extractSummary(head);
      } catch (err) {
        log.warn({ err, filePath }, 'Failed to read CC artifact file for summary extraction');
      }

      entries.set(key, {
        name: nameWithoutExt,
        summary,
        filePath,
        source,
        artifactType,
      });
    }
  } catch (err) {
    log.warn({ err, dir }, 'Failed to read CC artifact directory');
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover `.claude/commands/*.md` and `.claude/skills/*.md` files by walking
 * up from `cwd`.
 *
 * Precedence rules:
 * - Child directories win over parent directories (unchanged).
 * - Within the same directory level, commands take precedence over skills.
 *
 * Results are cached per cwd with a 30-second TTL.
 */
export function discoverCCCommands(cwd: string, ttlMs: number = DEFAULT_CACHE_TTL_MS): CCCommandRegistry {
  const resolvedCwd = resolve(cwd);

  // Check cache
  const cached = cache.get(resolvedCwd);
  if (cached && (Date.now() - cached.discoveredAt) < ttlMs) {
    log.debug({ cwd: resolvedCwd }, 'CC command cache hit');
    return cached;
  }

  log.debug({ cwd: resolvedCwd }, 'CC command cache miss, discovering commands');

  const entries = new Map<string, CCCommandEntry>();
  let current = resolvedCwd;

  // Walk up the directory tree; collect entries from each level.
  // Since child directories should win on name collisions, we only add entries
  // that haven't been seen yet (first occurrence = nearest ancestor).
  // At each level, commands are scanned before skills so commands take
  // precedence over skills with the same name at the same level.
  while (true) {
    const claudeDir = join(current, '.claude');

    scanArtifactDir(join(claudeDir, 'commands'), 'command', current, entries);
    scanArtifactDir(join(claudeDir, 'skills'), 'skill', current, entries);

    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  log.debug({ cwd: resolvedCwd, count: entries.size }, 'CC command discovery complete');

  const registry: CCCommandRegistry = {
    entries,
    discoveredAt: Date.now(),
  };

  cache.set(resolvedCwd, registry);
  return registry;
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Look up a single CC command by name (case-insensitive).
 */
export function getCCCommand(cwd: string, name: string): CCCommandEntry | undefined {
  const registry = discoverCCCommands(cwd);
  return registry.entries.get(name.toLowerCase());
}

// ─── Template loading ────────────────────────────────────────────────────────

/**
 * Load the full markdown content of a CC command file.
 * This is deferred to execution time to avoid reading full files during discovery.
 */
export function loadCCCommandTemplate(entry: CCCommandEntry): string {
  return readFileSync(entry.filePath, 'utf-8');
}
