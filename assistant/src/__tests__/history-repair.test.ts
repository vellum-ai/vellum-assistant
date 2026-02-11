import { describe, expect, test } from 'bun:test';
import { repairHistory } from '../daemon/history-repair.js';
import type { Message } from '../providers/types.js';

describe('repairHistory', () => {
  test('no-op for valid histories', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/a' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the file.' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test('strips tool_result blocks from assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure' },
          { type: 'tool_result', tool_use_id: 'tu_x', content: 'stale' },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[1].content).toEqual([{ type: 'text', text: 'Sure' }]);
    expect(stats.assistantToolResultsMigrated).toBe(1);
  });

  test('inserts missing tool_result when user message lacks it', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Run tool' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool_use', id: 'tu_2', name: 'read', input: { path: '/b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
          // tu_2 is missing
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);

    // The user message should now have both tool_results
    const userMsg = repaired[2];
    expect(userMsg.role).toBe('user');
    const trBlocks = userMsg.content.filter((b) => b.type === 'tool_result');
    expect(trBlocks).toHaveLength(2);

    const synth = trBlocks.find(
      (b) => b.type === 'tool_result' && b.tool_use_id === 'tu_2',
    );
    expect(synth).toBeDefined();
    expect(synth!.type === 'tool_result' && synth!.is_error).toBe(true);
  });

  test('injects synthetic user message when assistant tool_use has no following user message', () => {
    // assistant with tool_use followed by another assistant (no user in between)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Oops' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);
    expect(repaired).toHaveLength(4);
    expect(repaired[2].role).toBe('user');
    expect(repaired[2].content[0].type).toBe('tool_result');
  });

  test('injects synthetic user message for trailing assistant with tool_use', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.missingToolResultsInserted).toBe(1);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].role).toBe('user');
  });

  test('downgrades orphan tool_result blocks to text', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
          {
            type: 'tool_result',
            tool_use_id: 'tu_unknown',
            content: 'stale result',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(1);

    const userContent = repaired[2].content;
    expect(userContent).toHaveLength(2);
    expect(userContent[0].type).toBe('tool_result');
    expect(userContent[1].type).toBe('text');
    expect(
      userContent[1].type === 'text' && userContent[1].text,
    ).toContain('orphaned tool_result');
  });

  test('downgrades tool_result in user message when no preceding tool_use', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_result', tool_use_id: 'tu_gone', content: 'wat' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.orphanToolResultsDowngraded).toBe(1);
    expect(repaired[0].content[1].type).toBe('text');
  });

  test('preserves non-tool content unchanged', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'World' },
        ],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(repaired).toEqual(messages);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });

  test('idempotency: running twice produces same output', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool_result', tool_use_id: 'tu_x', content: 'bad' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_orphan', content: 'stale' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    ];

    const first = repairHistory(messages);
    const second = repairHistory(first.messages);

    expect(second.messages).toEqual(first.messages);
    expect(second.stats.assistantToolResultsMigrated).toBe(0);
    expect(second.stats.missingToolResultsInserted).toBe(0);
    expect(second.stats.orphanToolResultsDowngraded).toBe(0);
  });

  test('handles multiple tool_use blocks with all results missing', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Run' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'bash', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'read', input: {} },
          { type: 'tool_use', id: 'tu_c', name: 'write', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'next message' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    // The text-only user message should have 3 synthetic tool_results injected
    expect(stats.missingToolResultsInserted).toBe(3);

    const userMsg = repaired[2];
    const trBlocks = userMsg.content.filter((b) => b.type === 'tool_result');
    expect(trBlocks).toHaveLength(3);
    // Original text content preserved
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'next message' });
  });

  test('migrates tool_result from assistant message to user message preserving content', () => {
    // Legacy corruption: assistant has both tool_use and its own tool_result
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here are the files.' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.assistantToolResultsMigrated).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(0);

    // assistant message should have tool_use only
    expect(repaired[1].content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
    ]);

    // injected user message should carry the original result, not a synthetic error
    expect(repaired[2].role).toBe('user');
    expect(repaired[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2' },
    ]);

    // original second assistant message follows
    expect(repaired[3].content).toEqual([
      { type: 'text', text: 'Here are the files.' },
    ]);
  });

  test('migrates tool_result from assistant to following user message filling gap', () => {
    // assistant has tool_use(tu_1) + tool_result(tu_1), user message has no tool_result
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'success data' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'thanks' }],
      },
    ];

    const { messages: repaired, stats } = repairHistory(messages);

    expect(stats.assistantToolResultsMigrated).toBe(1);
    expect(stats.missingToolResultsInserted).toBe(0);

    // user message should now have both original text and the migrated tool_result
    const userMsg = repaired[2];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'thanks' });
    expect(userMsg.content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'success data',
    });
  });

  test('handles empty message array', () => {
    const { messages, stats } = repairHistory([]);
    expect(messages).toEqual([]);
    expect(stats.assistantToolResultsMigrated).toBe(0);
    expect(stats.missingToolResultsInserted).toBe(0);
    expect(stats.orphanToolResultsDowngraded).toBe(0);
  });
});
