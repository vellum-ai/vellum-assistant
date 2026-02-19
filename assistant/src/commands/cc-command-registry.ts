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
  /** Directory containing the `.claude/commands/` folder. */
  source: string;
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

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover `.claude/commands/*.md` files by walking up from `cwd`.
 * Nearest directory wins on name collisions (child overrides parent).
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

  // Walk up the directory tree; collect commands from each level.
  // Since child directories should win on name collisions, we only add entries
  // that haven't been seen yet (first occurrence = nearest ancestor).
  while (true) {
    const commandsDir = join(current, '.claude', 'commands');

    if (existsSync(commandsDir)) {
      try {
        const files = readdirSync(commandsDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.md')) continue;

          const nameWithoutExt = basename(file.name, '.md');

          // Validate command name
          if (!COMMAND_NAME_REGEX.test(nameWithoutExt) || nameWithoutExt.includes('..')) {
            log.warn({ fileName: file.name, dir: commandsDir }, 'Skipping invalid CC command filename');
            continue;
          }

          const key = nameWithoutExt.toLowerCase();

          // Child directories win — skip if already discovered from a closer ancestor
          if (entries.has(key)) continue;

          const filePath = join(commandsDir, file.name);

          let summary = '';
          try {
            const head = readFileHead(filePath, SUMMARY_READ_BYTES);
            summary = extractSummary(head);
          } catch (err) {
            log.warn({ err, filePath }, 'Failed to read CC command file for summary extraction');
          }

          entries.set(key, {
            name: nameWithoutExt,
            summary,
            filePath,
            source: current,
          });
        }
      } catch (err) {
        log.warn({ err, commandsDir }, 'Failed to read CC commands directory');
      }
    }

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
