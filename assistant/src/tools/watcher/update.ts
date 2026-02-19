import type { ToolContext, ToolExecutionResult } from '../types.js';
import { updateWatcher } from '../../watcher/watcher-store.js';

export async function executeWatcherUpdate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const watcherId = input.watcher_id as string;
  if (!watcherId || typeof watcherId !== 'string') {
    return { content: 'Error: watcher_id is required', isError: true };
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.action_prompt !== undefined) updates.actionPrompt = input.action_prompt;
  if (input.poll_interval_ms !== undefined) {
    if ((input.poll_interval_ms as number) < 15000) {
      return { content: 'Error: poll_interval_ms must be at least 15000 (15 seconds)', isError: true };
    }
    updates.pollIntervalMs = input.poll_interval_ms;
  }
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.config !== undefined) updates.configJson = JSON.stringify(input.config);

  if (Object.keys(updates).length === 0) {
    return { content: 'Error: No updates provided. Specify at least one field to update.', isError: true };
  }

  try {
    const watcher = updateWatcher(watcherId, updates as {
      name?: string;
      actionPrompt?: string;
      pollIntervalMs?: number;
      enabled?: boolean;
      configJson?: string | null;
    });

    if (!watcher) {
      return { content: `Error: Watcher not found: ${watcherId}`, isError: true };
    }

    return {
      content: [
        'Watcher updated successfully.',
        `  Name: ${watcher.name}`,
        `  Enabled: ${watcher.enabled}`,
        `  Status: ${watcher.status}`,
        `  Poll interval: ${Math.round(watcher.pollIntervalMs / 1000)}s`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating watcher: ${msg}`, isError: true };
  }
}
