import type { Tool } from './types.js';
import type { ToolDefinition } from '../providers/types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('tool-registry');

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (tools.has(tool.name)) {
    log.warn({ name: tool.name }, 'Tool already registered, overwriting');
  }
  tools.set(tool.name, tool);
  log.info({ name: tool.name, category: tool.category }, 'Tool registered');
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(tools.values());
}

export function getAllToolDefinitions(): ToolDefinition[] {
  return getAllTools().map((t) => t.getDefinition());
}

export async function initializeTools(): Promise<void> {
  // Import tool modules to trigger registration side effects
  await import('./terminal/shell.js');
  await import('./filesystem/read.js');
  await import('./filesystem/write.js');
  await import('./filesystem/edit.js');
  log.info({ count: tools.size }, 'Tools initialized');
}
