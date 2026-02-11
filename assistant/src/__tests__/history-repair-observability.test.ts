import { describe, expect, test } from 'bun:test';
import { repairHistory } from '../daemon/history-repair.js';
import type { Message } from '../providers/types.js';

describe('history-repair observability', () => {
  test('stats are all zero for valid history (no logs should be emitted)', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const { stats } = repairHistory(messages);

    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test('stats are non-zero only when repairs are applied', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
          { type: 'tool_result', tool_use_id: 'tu_bad', content: 'stale' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan', content: 'orphan' },
        ],
      },
    ];

    const { stats } = repairHistory(messages);

    // assistantToolResultsMigrated: 1 (tu_bad migrated from assistant message)
    expect(stats.assistantToolResultsMigrated).toBe(1);
    // missingToolResultsInserted: 1 (tu_1 had no matching result in next user msg)
    // but actually the orphan tu_orphan is downgraded, and tu_1 is injected
    expect(stats.missingToolResultsInserted).toBe(1);
    // orphanToolResultsDowngraded: 1 (tu_orphan doesn't match tu_1)
    expect(stats.orphanToolResultsDowngraded).toBe(1);

    // All counters > 0 → log would be emitted
    const shouldLog =
      stats.assistantToolResultsMigrated > 0 ||
      stats.missingToolResultsInserted > 0 ||
      stats.orphanToolResultsDowngraded > 0;
    expect(shouldLog).toBe(true);
  });
});
