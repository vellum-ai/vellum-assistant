import { getLogger } from '../util/logger.js';

const log = getLogger('tool-sanitizer');

/**
 * Canonical map of recognized tool keys to human-readable descriptions.
 * This is the single source of truth — any tool name not in this map is
 * considered invalid and will be dropped by sanitizeToolList().
 */
export const CANONICAL_TOOLS: Record<string, string> = {
  bash: 'Execute shell commands',
  host_bash: 'Execute shell commands on host',
  file_read: 'Read files',
  file_write: 'Write files',
  file_edit: 'Edit files',
  host_file_read: 'Read host files',
  host_file_write: 'Write host files',
  host_file_edit: 'Edit host files',
  web_fetch: 'Fetch web URLs',
  web_search: 'Search the web',
  browser_navigate: 'Navigate browser',
  network_request: 'Make network requests',
  skill_load: 'Load skills',
};

/** All valid tool keys, sorted alphabetically. */
export const CANONICAL_TOOL_KEYS: string[] = Object.keys(CANONICAL_TOOLS).sort();

/**
 * Validate, deduplicate, and sort a list of tool names against the canonical set.
 * Unknown tool names are dropped and logged at warn level for drift visibility.
 * The returned array is deterministic: sorted alphabetically with no duplicates.
 */
export function sanitizeToolList(tools: string[]): string[] {
  const seen = new Set<string>();
  const rejected: string[] = [];

  for (const tool of tools) {
    if (CANONICAL_TOOLS[tool]) {
      seen.add(tool);
    } else {
      rejected.push(tool);
    }
  }

  if (rejected.length > 0) {
    log.warn({ rejected }, 'Unknown tool names dropped during sanitization');
  }

  return [...seen].sort();
}

/** Look up the human-readable description for a canonical tool key. */
export function getToolDescription(tool: string): string {
  return CANONICAL_TOOLS[tool] ?? tool;
}
