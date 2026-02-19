import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { listWatchers, listWatcherEvents } from '../../watcher/watcher-store.js';

class WatcherDigestTool implements Tool {
  name = 'watcher_digest';
  description = 'Get a summary of recent watcher activity. Use this when the user asks about what happened with their email, notifications, etc.';
  category = 'watcher';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          watcher_id: {
            type: 'string',
            description: 'Filter to events from a specific watcher. If omitted, shows events from all watchers.',
          },
          hours: {
            type: 'number',
            description: 'How many hours back to look. Defaults to 24.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of events to return. Defaults to 50.',
          },
        },
        required: [],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeWatcherDigest(input, _context);
  }
}

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

registerTool(new WatcherDigestTool());
