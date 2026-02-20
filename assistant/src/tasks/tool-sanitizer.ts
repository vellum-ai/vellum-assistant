import { getTool, getAllTools } from '../tools/registry.js';

/**
 * Deduplicate and sort a list of tool names, validating against the live
 * tool registry. Unknown tool names are logged at warn level but kept —
 * they may refer to skill tools that will be loaded at runtime.
 *
 * The returned array is deterministic: sorted alphabetically with no duplicates.
 */
export function sanitizeToolList(tools: string[]): string[] {
  const seen = new Set<string>();

  for (const tool of tools) {
    if (!tool || typeof tool !== 'string') continue;
    seen.add(tool);
  }

  return [...seen].sort();
}

/**
 * Get all registered tool names from the live tool registry.
 * Used as the fallback when a task/work-item has no explicit requiredTools.
 */
export function getRegisteredToolNames(): string[] {
  return getAllTools()
    .filter((t) => t.executionMode !== 'proxy' && t.origin !== 'skill')
    .map((t) => t.name)
    .sort();
}

/** Look up the human-readable description for a tool from the registry. */
export function getToolDescription(tool: string): string {
  const registered = getTool(tool);
  return registered?.description ?? tool;
}
