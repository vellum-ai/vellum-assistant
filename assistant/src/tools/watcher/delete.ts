import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getWatcher, deleteWatcher } from '../../watcher/watcher-store.js';
import { getWatcherProvider } from '../../watcher/provider-registry.js';

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

  // Evict any in-process provider state (e.g. Linear issue-state cache) now
  // that the watcher's DB row is gone, so its UUID doesn't leak memory.
  const provider = getWatcherProvider(watcher.providerId);
  provider?.cleanup?.(watcherId);

  return {
    content: `Watcher deleted: "${watcher.name}"`,
    isError: false,
  };
}
