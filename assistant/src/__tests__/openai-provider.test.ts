import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Message, ToolDefinition, ProviderEvent, ContentBlock } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  model: string;
}

let fakeChunks: FakeChunk[] = [];
let lastCreateParams: Record<string, unknown> | null = null;
let lastCreateOptions: Record<string, unknown> | null = null;
let shouldThrow: Error | null = null;

// Simulate OpenAI.APIError
class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'APIError';
  }
}

mock.module('openai', () => ({
  default: class MockOpenAI {
    static APIError = FakeAPIError;
    constructor(_opts: Record<string, unknown>) {}
    chat = {
      completions: {
        create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
          lastCreateParams = params;
          lastCreateOptions = options ?? null;
          if (shouldThrow) throw shouldThrow;

          return {
            [Symbol.asyncIterator]: async function* () {
              for (const chunk of fakeChunks) {
                yield chunk;
              }
            },
          };
        },
      },
    };
  },
}));

// Import after mocking
import { OpenAIProvider } from '../providers/openai/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textChunk(content: string, finish: string | null = null): FakeChunk {
  return {
    choices: [{ delta: { content }, finish_reason: finish }],
    usage: null,
    model: 'gpt-5.2',
  };
}

function toolCallChunks(calls: Array<{ id: string; name: string; args: string }>): FakeChunk[] {
  const chunks: FakeChunk[] = [];
  for (let i = 0; i < calls.length; i++) {
    // First chunk: id + name
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            id: calls[i].id,
            type: 'function',
            function: { name: calls[i].name },
          }],
        },
        finish_reason: null,
      }],
      usage: null,
      model: 'gpt-5.2',
    });
    // Second chunk: arguments
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            function: { arguments: calls[i].args },
          }],
        },
        finish_reason: null,
      }],
      usage: null,
      model: 'gpt-5.2',
    });
  }
  return chunks;
}

function usageChunk(prompt: number, completion: number): FakeChunk {
  return {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    model: 'gpt-5.2',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider('sk-test-key', 'gpt-5.2');
    fakeChunks = [];
    lastCreateParams = null;
    lastCreateOptions = null;
    shouldThrow = null;
  });

  // -----------------------------------------------------------------------
  // Basic text response
  // -----------------------------------------------------------------------
  test('returns text response from streaming chunks', async () => {
    fakeChunks = [
      textChunk('Hello'),
      textChunk(', world!'),
      usageChunk(10, 5),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello, world!' });
    expect(result.model).toBe('gpt-5.2');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe('stop');
  });

  // -----------------------------------------------------------------------
  // Streaming events
  // -----------------------------------------------------------------------
  test('fires text_delta events during streaming', async () => {
    fakeChunks = [
      textChunk('Hello'),
      textChunk(', world!'),
      usageChunk(10, 5),
    ];

    const events: ProviderEvent[] = [];
    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      undefined,
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello' });
    expect(events[1]).toEqual({ type: 'text_delta', text: ', world!' });
  });

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------
  test('places system prompt as first message', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      undefined,
      'You are a helpful assistant.',
    );

    const messages = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  // -----------------------------------------------------------------------
  // Tool definitions
  // -----------------------------------------------------------------------
  test('converts tool definitions to OpenAI function format', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    const tools: ToolDefinition[] = [{
      name: 'file_read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }];

    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Read /tmp/test' }] }],
      tools,
    );

    const sentTools = lastCreateParams!.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toEqual({
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    });
  });

  // -----------------------------------------------------------------------
  // Tool call response
  // -----------------------------------------------------------------------
  test('parses tool calls from streaming chunks', async () => {
    fakeChunks = [
      ...toolCallChunks([
        { id: 'call_abc', name: 'file_read', args: '{"path":"/tmp/test"}' },
      ]),
      usageChunk(10, 15),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Read /tmp/test' }] }],
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_abc',
      name: 'file_read',
      input: { path: '/tmp/test' },
    });
    expect(result.stopReason).toBe('stop');
  });

  // -----------------------------------------------------------------------
  // Mixed text + tool calls
  // -----------------------------------------------------------------------
  test('handles text + tool calls in same response', async () => {
    fakeChunks = [
      textChunk('I will read that file.'),
      ...toolCallChunks([
        { id: 'call_1', name: 'file_read', args: '{"path":"/a"}' },
      ]),
      usageChunk(10, 20),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Read /a' }] }],
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'I will read that file.' });
    expect(result.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'file_read',
      input: { path: '/a' },
    });
  });

  // -----------------------------------------------------------------------
  // Multiple tool calls
  // -----------------------------------------------------------------------
  test('handles multiple parallel tool calls', async () => {
    fakeChunks = [
      ...toolCallChunks([
        { id: 'call_1', name: 'file_read', args: '{"path":"/a"}' },
        { id: 'call_2', name: 'file_read', args: '{"path":"/b"}' },
      ]),
      usageChunk(10, 30),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Read /a and /b' }] }],
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: 'tool_use', id: 'call_1', name: 'file_read', input: { path: '/a' },
    });
    expect(result.content[1]).toEqual({
      type: 'tool_use', id: 'call_2', name: 'file_read', input: { path: '/b' },
    });
  });

  // -----------------------------------------------------------------------
  // Tool result messages
  // -----------------------------------------------------------------------
  test('converts tool_result blocks to tool-role messages', async () => {
    fakeChunks = [textChunk('The file contains...'), usageChunk(20, 10)];

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read /tmp/test' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_abc', name: 'file_read', input: { path: '/tmp/test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_abc', content: 'file content here', is_error: false },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    // user → assistant → tool → (no extra user since no text blocks)
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: 'user', content: 'Read /tmp/test' });
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_abc',
        type: 'function',
        function: { name: 'file_read', arguments: '{"path":"/tmp/test"}' },
      }],
    });
    expect(sent[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: 'file content here',
    });
  });

  // -----------------------------------------------------------------------
  // Mixed tool_result + text in user message
  // -----------------------------------------------------------------------
  test('splits user message with tool_result + text into separate messages', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(20, 5)];

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'test', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result' },
          { type: 'text', text: '[System: progress reminder]' },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(4);
    // tool result first, then text as user message
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result' });
    expect(sent[3]).toEqual({ role: 'user', content: '[System: progress reminder]' });
  });

  // -----------------------------------------------------------------------
  // Image content
  // -----------------------------------------------------------------------
  test('converts image blocks to image_url parts', async () => {
    fakeChunks = [textChunk('A cat'), usageChunk(100, 5)];

    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ],
    }];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    const userMsg = sent[0] as { role: string; content: Array<Record<string, unknown>> };
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(userMsg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    });
  });

  // -----------------------------------------------------------------------
  // max_tokens config
  // -----------------------------------------------------------------------
  test('passes max_tokens as max_completion_tokens', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      undefined,
      undefined,
      { config: { max_tokens: 32000 } },
    );

    expect(lastCreateParams!.max_completion_tokens).toBe(32000);
  });

  // -----------------------------------------------------------------------
  // Thinking blocks are skipped
  // -----------------------------------------------------------------------
  test('skips thinking blocks in user messages', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'thinking', thinking: 'hmm...', signature: 'sig' } as ContentBlock,
        { type: 'text', text: 'Hello' },
      ],
    }];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  // -----------------------------------------------------------------------
  // Signal passthrough
  // -----------------------------------------------------------------------
  test('passes abort signal to API call', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];
    const controller = new AbortController();

    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      undefined,
      undefined,
      { signal: controller.signal },
    );

    expect(lastCreateOptions!.signal).toBe(controller.signal);
  });

  // -----------------------------------------------------------------------
  // API error handling
  // -----------------------------------------------------------------------
  test('wraps API errors in ProviderError', async () => {
    shouldThrow = new FakeAPIError(429, 'Rate limit exceeded');

    try {
      await provider.sendMessage(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      );
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect((error as Error).message).toContain('OpenAI API error (429)');
      expect((error as Error).message).toContain('Rate limit exceeded');
    }
  });

  // -----------------------------------------------------------------------
  // Generic error handling
  // -----------------------------------------------------------------------
  test('wraps generic errors in ProviderError', async () => {
    shouldThrow = new Error('Network failure');

    try {
      await provider.sendMessage(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      );
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain('OpenAI request failed');
      expect((error as Error).message).toContain('Network failure');
    }
  });

  // -----------------------------------------------------------------------
  // Malformed tool call JSON
  // -----------------------------------------------------------------------
  test('handles malformed tool call arguments gracefully', async () => {
    fakeChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_bad',
              type: 'function' as const,
              function: { name: 'test', arguments: 'not valid json{' },
            }],
          },
          finish_reason: null,
        }],
        usage: null,
        model: 'gpt-5.2',
      },
      usageChunk(10, 5),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_bad',
      name: 'test',
      input: { _raw: 'not valid json{' },
    });
  });

  // -----------------------------------------------------------------------
  // stream_options and model
  // -----------------------------------------------------------------------
  test('sends stream_options and correct model', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    );

    expect(lastCreateParams!.stream).toBe(true);
    expect(lastCreateParams!.stream_options).toEqual({ include_usage: true });
    expect(lastCreateParams!.model).toBe('gpt-5.2');
  });

  // -----------------------------------------------------------------------
  // Empty content response
  // -----------------------------------------------------------------------
  test('handles response with no text content', async () => {
    fakeChunks = [
      ...toolCallChunks([{ id: 'call_1', name: 'test', args: '{}' }]),
      usageChunk(10, 5),
    ];

    const result = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    );

    // Only tool_use, no text block
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('tool_use');
  });

  // -----------------------------------------------------------------------
  // Assistant message with text preserves content
  // -----------------------------------------------------------------------
  test('preserves assistant text + tool_use in message conversion', async () => {
    fakeChunks = [textChunk('OK'), usageChunk(10, 2)];

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'call_1', name: 'test', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
        ],
      },
    ];

    await provider.sendMessage(messages);

    const sent = lastCreateParams!.messages as Array<Record<string, unknown>>;
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'test', arguments: '{"x":1}' },
      }],
    });
  });
});
