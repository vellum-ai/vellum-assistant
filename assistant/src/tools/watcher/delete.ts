import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getWatcher, deleteWatcher } from '../../watcher/watcher-store.js';

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
