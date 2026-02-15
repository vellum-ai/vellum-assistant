import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Message, ToolDefinition } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — must be before importing the provider
// ---------------------------------------------------------------------------

let lastStreamParams: Record<string, unknown> | null = null;
let _lastStreamOptions: Record<string, unknown> | null = null;

const fakeResponse = {
  content: [{ type: 'text', text: 'Hello' }],
  model: 'claude-sonnet-4-5-20250929',
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 30,
  },
  stop_reason: 'end_turn',
};

class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'APIError';
  }
}

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    static APIError = FakeAPIError;
    constructor() {}
    messages = {
      stream: (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        lastStreamParams = JSON.parse(JSON.stringify(params));
        _lastStreamOptions = options ?? null;
        const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
        return {
          on(event: string, cb: (...args: unknown[]) => void) {
            (handlers[event] ??= []).push(cb);
            return this;
          },
          async finalMessage() {
            // Fire text events
            for (const cb of handlers['text'] ?? []) cb('Hello');
            return fakeResponse;
          },
        };
      },
    };
  },
}));

// Import after mocking
import { AnthropicProvider } from '../providers/anthropic/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolUseMsg(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
  };
}

const sampleTools: ToolDefinition[] = [
  { name: 'file_read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'file_write', description: 'Write a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'bash', description: 'Run shell commands', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
];

// ---------------------------------------------------------------------------
// Tests — Cache-Control Characterization
// ---------------------------------------------------------------------------

describe('AnthropicProvider — Cache-Control Characterization', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    provider = new AnthropicProvider('sk-ant-test', 'claude-sonnet-4-5-20250929');
  });

  // -----------------------------------------------------------------------
  // System prompt cache control
  // -----------------------------------------------------------------------
  test('system prompt has cache_control ephemeral', async () => {
    await provider.sendMessage([userMsg('Hi')], undefined, 'You are helpful.');

    const system = lastStreamParams!.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('no system param when system prompt is omitted', async () => {
    await provider.sendMessage([userMsg('Hi')]);

    expect(lastStreamParams!.system).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Tool cache control
  // -----------------------------------------------------------------------
  test('only last tool definition includes cache_control', async () => {
    await provider.sendMessage([userMsg('Hi')], sampleTools);

    const tools = lastStreamParams!.tools as Array<{ name: string; cache_control?: { type: string } }>;
    expect(tools).toHaveLength(3);

    // First two tools: no cache_control
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();

    // Last tool: cache_control ephemeral
    expect(tools[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('single tool gets cache_control', async () => {
    await provider.sendMessage([userMsg('Hi')], [sampleTools[0]]);

    const tools = lastStreamParams!.tools as Array<{ name: string; cache_control?: { type: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('no tools param when tools are omitted', async () => {
    await provider.sendMessage([userMsg('Hi')]);

    expect(lastStreamParams!.tools).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // User turn cache breakpoints — last two user turns
  // -----------------------------------------------------------------------
  test('last user turn gets cache_control on trailing content block', async () => {
    await provider.sendMessage([userMsg('Hello')]);

    const messages = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    }>;
    const lastUser = messages[messages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content[lastUser.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('last two user turns get cache_control, earlier turns do not', async () => {
    const messages: Message[] = [
      userMsg('Turn 1'),             // user turn 0 — no cache
      assistantMsg('Response 1'),
      userMsg('Turn 2'),             // user turn 1 — cache (second-to-last)
      assistantMsg('Response 2'),
      userMsg('Turn 3'),             // user turn 2 — cache (last)
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    }>;

    // Find user messages in order
    const userMessages = sent.filter(m => m.role === 'user');
    expect(userMessages).toHaveLength(3);

    // First user turn: no cache_control
    const firstUserLastBlock = userMessages[0].content[userMessages[0].content.length - 1];
    expect(firstUserLastBlock.cache_control).toBeUndefined();

    // Second user turn: cache_control ephemeral
    const secondUserLastBlock = userMessages[1].content[userMessages[1].content.length - 1];
    expect(secondUserLastBlock.cache_control).toEqual({ type: 'ephemeral' });

    // Third user turn: cache_control ephemeral
    const thirdUserLastBlock = userMessages[2].content[userMessages[2].content.length - 1];
    expect(thirdUserLastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('single user turn gets cache_control (only one user = last one)', async () => {
    await provider.sendMessage([userMsg('Only turn')]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    }>;
    const userMessages = sent.filter(m => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content[userMessages[0].content.length - 1].cache_control)
      .toEqual({ type: 'ephemeral' });
  });

  // -----------------------------------------------------------------------
  // User turn with tool_result — cache breakpoint on trailing block
  // -----------------------------------------------------------------------
  test('user turn containing tool_result gets cache_control on last block', async () => {
    const messages: Message[] = [
      userMsg('Read file'),
      toolUseMsg('tu_1', 'file_read'),
      toolResultMsg('tu_1', 'file contents here'),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; cache_control?: { type: string } }>;
    }>;
    const userMsgs = sent.filter(m => m.role === 'user');
    // Both user turns (first user msg + tool_result msg) should get cache
    for (const u of userMsgs) {
      const last = u.content[u.content.length - 1];
      expect(last.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  // -----------------------------------------------------------------------
  // Negative: assistant messages never get cache_control
  // -----------------------------------------------------------------------
  test('assistant messages do not get cache_control', async () => {
    const messages: Message[] = [
      userMsg('Hi'),
      assistantMsg('Hello!'),
      userMsg('How are you?'),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    }>;
    const assistantMsgs = sent.filter(m => m.role === 'assistant');
    for (const a of assistantMsgs) {
      if (Array.isArray(a.content)) {
        for (const block of a.content) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Multi-block user message: cache lands on LAST block
  // -----------------------------------------------------------------------
  test('multi-block user message caches only the last block', async () => {
    const multiBlockUser: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
      ],
    };
    await provider.sendMessage([multiBlockUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    }>;
    const user = sent[0];
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  // -----------------------------------------------------------------------
  // Usage: cache tokens are aggregated into inputTokens
  // -----------------------------------------------------------------------
  test('usage aggregates cache tokens into inputTokens', async () => {
    const result = await provider.sendMessage([userMsg('Hi')]);

    expect(result.usage.inputTokens).toBe(100 + 50 + 30); // input + creation + read
    expect(result.usage.cacheCreationInputTokens).toBe(50);
    expect(result.usage.cacheReadInputTokens).toBe(30);
  });
});
