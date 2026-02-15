import { describe, test, expect } from 'bun:test';
import type { Message } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Fixture messages
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function userMsgWithToolResult(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
  };
}

// ---------------------------------------------------------------------------
// Placeholder helpers — will be replaced by real implementations in PR 5
// ---------------------------------------------------------------------------

const WORKSPACE_TAG = '<workspace_top_level>';

/**
 * Prepend a workspace context block to a user message.
 * Placeholder implementation matching the target API.
 */
function injectWorkspaceTopLevelContext(message: Message, contextText: string): Message {
  return {
    ...message,
    content: [
      { type: 'text', text: contextText },
      ...message.content,
    ],
  };
}

/**
 * Strip workspace context blocks from message history.
 * Placeholder implementation matching the target API.
 */
function stripWorkspaceTopLevelContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith(WORKSPACE_TAG);
    });
    if (nextContent.length === message.content.length) return message;
    if (nextContent.length === 0) return null;
    return { ...message, content: nextContent };
  }).filter((m): m is NonNullable<typeof m> => m !== null);
}

// ---------------------------------------------------------------------------
// Tests — capture target runtime behavior
// ---------------------------------------------------------------------------

const sampleContext = `${WORKSPACE_TAG}\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace_top_level>`;

describe('Workspace top-level context — injection', () => {
  test('prepends workspace block to user message content', () => {
    const original = userMsg('Hello');
    const injected = injectWorkspaceTopLevelContext(original, sampleContext);

    expect(injected.content).toHaveLength(2);
    expect(injected.content[0]).toEqual({ type: 'text', text: sampleContext });
    expect(injected.content[1]).toEqual({ type: 'text', text: 'Hello' });
  });

  test('preserves multi-block user content after prepend', () => {
    const original: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    };
    const injected = injectWorkspaceTopLevelContext(original, sampleContext);

    expect(injected.content).toHaveLength(3);
    expect(injected.content[0].type).toBe('text');
    expect((injected.content[0] as { text: string }).text).toBe(sampleContext);
    expect((injected.content[1] as { text: string }).text).toBe('First');
    expect((injected.content[2] as { text: string }).text).toBe('Second');
  });

  test('does not mutate original message', () => {
    const original = userMsg('Hello');
    const originalContentLength = original.content.length;
    injectWorkspaceTopLevelContext(original, sampleContext);

    expect(original.content).toHaveLength(originalContentLength);
  });
});

describe('Workspace top-level context — stripping', () => {
  test('strips injected workspace block from user messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: sampleContext },
          { type: 'text', text: 'Hello' },
        ],
      },
      assistantMsg('Hi there'),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);

    expect(stripped).toHaveLength(2);
    expect(stripped[0].content).toHaveLength(1);
    expect((stripped[0].content[0] as { text: string }).text).toBe('Hello');
  });

  test('does not strip non-workspace text blocks', () => {
    const messages: Message[] = [
      userMsg('Regular message'),
      assistantMsg('Response'),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toEqual(messages);
  });

  test('removes user message entirely when only workspace block remains', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: sampleContext }] },
      assistantMsg('Response'),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].role).toBe('assistant');
  });

  test('does not strip from assistant messages', () => {
    const messages: Message[] = [
      assistantMsg(sampleContext),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect((stripped[0].content[0] as { text: string }).text).toBe(sampleContext);
  });

  test('preserves tool_result blocks during stripping', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: sampleContext },
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'result', is_error: false },
        ],
      },
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content).toHaveLength(1);
    expect(stripped[0].content[0].type).toBe('tool_result');
  });

  test('no empty-message artifacts after stripping', () => {
    const messages: Message[] = [
      userMsg('Before'),
      { role: 'user', content: [{ type: 'text', text: sampleContext }] },
      assistantMsg('After'),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    // Middle user message should be removed entirely
    expect(stripped).toHaveLength(2);
    expect(stripped[0].role).toBe('user');
    expect(stripped[1].role).toBe('assistant');
  });
});
