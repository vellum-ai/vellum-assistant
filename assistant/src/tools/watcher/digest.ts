import type { ToolContext, ToolExecutionResult } from '../types.js';
import { listWatchers, listWatcherEvents } from '../../watcher/watcher-store.js';

export async function executeWatcherDigest(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const watcherId = input.watcher_id as string | undefined;
  const hours = (input.hours as number) ?? 24;
  const limit = (input.limit as number) ?? 50;

  const since = Date.now() - hours * 60 * 60 * 1000;

  const events = listWatcherEvents({ watcherId, limit, since });

  if (events.length === 0) {
    const period = hours === 24 ? 'today' : `the last ${hours} hours`;
    return { content: `No watcher events detected ${period}.`, isError: false };
  }

  // Group events by watcher
  const watcherMap = new Map<string, typeof events>();
  for (const event of events) {
    const existing = watcherMap.get(event.watcherId) ?? [];
    existing.push(event);
    watcherMap.set(event.watcherId, existing);
  }

  // Get watcher names
  const allWatchers = listWatchers();
  const nameMap = new Map(allWatchers.map((w) => [w.id, w.name]));

  const lines = [`Watcher activity (last ${hours}h, ${events.length} events):`];

  for (const [wId, wEvents] of watcherMap) {
    const name = nameMap.get(wId) ?? wId;
    lines.push('', `${name} (${wEvents.length} events):`);

    for (const event of wEvents) {
      const time = new Date(event.createdAt).toLocaleString();
      const disposition = event.disposition !== 'pending' ? ` [${event.disposition}]` : '';
      lines.push(`  - ${event.summary}${disposition} (${time})`);
      if (event.llmAction) {
        lines.push(`    Action: ${event.llmAction}`);
      }
    }
  }

  return { content: lines.join('\n'), isError: false };
}
