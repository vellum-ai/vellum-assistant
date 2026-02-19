import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getWatcher, deleteWatcher } from '../../watcher/watcher-store.js';

class WatcherDeleteTool implements Tool {
  name = 'watcher_delete';
  description = 'Delete a watcher and all its event history';
  category = 'watcher';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          watcher_id: {
            type: 'string',
            description: 'The ID of the watcher to delete',
          },
        },
        required: ['watcher_id'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeWatcherDelete(input, _context);
  }
}

export async function executeWatcherDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const watcherId = input.watcher_id as string;
  if (!watcherId || typeof watcherId !== 'string') {
    return { content: 'Error: watcher_id is required', isError: true };
  }

  const watcher = getWatcher(watcherId);
  if (!watcher) {
    return { content: `Error: Watcher not found: ${watcherId}`, isError: true };
  }

  const deleted = deleteWatcher(watcherId);
  if (!deleted) {
    return { content: `Error: Failed to delete watcher: ${watcherId}`, isError: true };
  }

  return {
    content: `Watcher deleted: "${watcher.name}"`,
    isError: false,
  };
}

registerTool(new WatcherDeleteTool());
