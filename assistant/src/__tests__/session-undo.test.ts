import { describe, expect, test } from 'bun:test';
import { CONTEXT_SUMMARY_MARKER, createContextSummaryMessage } from '../context/window-manager.js';
import { findLastUndoableUserMessageIndex } from '../daemon/session.js';
import type { Message } from '../providers/types.js';

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

describe('findLastUndoableUserMessageIndex', () => {
  test('returns -1 when only an internal context summary exists', () => {
    const messages = [createContextSummaryMessage('## Goals\n- remembered context')];
    expect(findLastUndoableUserMessageIndex(messages)).toBe(-1);
  });

  test('skips context summaries and tool-result user turns', () => {
    const messages: Message[] = [
      createContextSummaryMessage('## Goals\n- remembered context'),
      textMessage('assistant', 'older assistant reply'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
          { type: 'text', text: '[System: progress reminder]' },
        ],
      },
      textMessage('assistant', 'tool follow-up'),
      textMessage('user', 'actual user prompt'),
      textMessage('assistant', 'actual assistant response'),
    ];

    expect(findLastUndoableUserMessageIndex(messages)).toBe(4);
  });

  test('treats user-authored summary marker text as a normal user turn', () => {
    const spoofMessage = textMessage(
      'user',
      `${CONTEXT_SUMMARY_MARKER}\nThis is ordinary user text, not internal summary state.`,
    );
    expect(findLastUndoableUserMessageIndex([spoofMessage])).toBe(0);
  });
});
