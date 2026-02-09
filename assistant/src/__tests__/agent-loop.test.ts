import { describe, test, expect } from 'bun:test';
import { AgentLoop } from '../agent/loop.js';
import type { AgentEvent } from '../agent/loop.js';
import type {
  Provider,
  Message,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
  ContentBlock,
} from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A mock provider that returns pre-configured responses in sequence. */
function createMockProvider(
  responses: ProviderResponse[],
): { provider: Provider; calls: { messages: Message[]; tools?: ToolDefinition[]; systemPrompt?: string }[] } {
  const calls: { messages: Message[]; tools?: ToolDefinition[]; systemPrompt?: string }[] = [];
  let callIndex = 0;

  const provider: Provider = {
    name: 'mock',
    async sendMessage(
      messages: Message[],
      tools?: ToolDefinition[],
      systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls.push({ messages: [...messages], tools, systemPrompt });
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;

      // Emit streaming events if the response has text blocks
      if (options?.onEvent) {
        for (const block of response.content) {
          if (block.type === 'text') {
            options.onEvent({ type: 'text_delta', text: block.text });
          }
        }
      }

      return response;
    },
  };

  return { provider, calls };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: 'text', text }],
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn',
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ProviderResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
  };
}

const dummyTools: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
];

const userMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
};

function collectEvents(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  // 1. Basic text response
  test('returns history with assistant message for simple text response', async () => {
    const { provider } = createMockProvider([textResponse('Hi there!')]);
    const loop = new AgentLoop(provider, 'system prompt');

    const events: AgentEvent[] = [];
    const history = await loop.run([userMessage], collectEvents(events));

    // History should contain original user message + assistant response
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(userMessage);
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  // 2. Tool execution — provider returns tool_use, verify tool executor is called
  test('executes tool and passes result back to provider', async () => {
    const toolCallId = 'tool-1';
    const { provider, calls } = createMockProvider([
      toolUseResponse(toolCallId, 'read_file', { path: '/tmp/test.txt' }),
      textResponse('File contents received.'),
    ]);

    const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
    const toolExecutor = async (name: string, input: Record<string, unknown>) => {
      toolCalls.push({ name, input });
      return { content: 'file data here', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    const history = await loop.run([userMessage], collectEvents(events));

    // Tool executor was called with correct args
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('read_file');
    expect(toolCalls[0].input).toEqual({ path: '/tmp/test.txt' });

    // Provider was called twice (initial + after tool result)
    expect(calls).toHaveLength(2);

    // Second call should include the tool result as a user message
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(lastMsg.role).toBe('user');

    const toolResultBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.tool_use_id).toBe(toolCallId);
    expect(toolResultBlock!.content).toBe('file data here');
    expect(toolResultBlock!.is_error).toBe(false);

    // Final history: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(history).toHaveLength(4);
    expect(history[3].role).toBe('assistant');
    expect(history[3].content).toEqual([{ type: 'text', text: 'File contents received.' }]);
  });

  // 3. Multi-turn tool loop
  test('supports multi-turn tool execution', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      textResponse('Done reading both files.'),
    ]);

    const toolExecutor = async (name: string, input: Record<string, unknown>) => {
      return { content: `contents of ${(input as { path: string }).path}`, isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const history = await loop.run([userMessage], () => {});

    // Provider called 3 times (two tool rounds + final text)
    expect(calls).toHaveLength(3);

    // History: user, assistant(t1), user(result1), assistant(t2), user(result2), assistant(text)
    expect(history).toHaveLength(6);
    expect(history[5].content).toEqual([{ type: 'text', text: 'Done reading both files.' }]);
  });

  // 4. Loop stops when provider returns tool_use but no executor is configured
  test('stops when tool_use returned but no tool executor configured', async () => {
    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
    ]);

    // No tool executor provided
    const loop = new AgentLoop(provider, 'system', {}, dummyTools);
    const history = await loop.run([userMessage], () => {});

    // Should stop after first response (no executor to handle tool use)
    expect(history).toHaveLength(2);
    expect(history[1].role).toBe('assistant');
  });

  // 5. Error handling — provider throws, verify error event and loop stops
  test('emits error event and stops when provider throws', async () => {
    const error = new Error('API rate limit exceeded');
    const provider: Provider = {
      name: 'mock',
      async sendMessage(): Promise<ProviderResponse> {
        throw error;
      },
    };

    const loop = new AgentLoop(provider, 'system');
    const events: AgentEvent[] = [];
    const history = await loop.run([userMessage], collectEvents(events));

    // Only the original message remains (no assistant message added on error)
    expect(history).toHaveLength(1);

    // Error event was emitted
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { type: 'error'; error: Error }).error.message).toBe('API rate limit exceeded');
  });

  // 6. Abort signal — verify the loop respects AbortSignal
  test('stops when abort signal is triggered before provider call', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const { provider } = createMockProvider([textResponse('Should not reach')]);
    const loop = new AgentLoop(provider, 'system');
    const history = await loop.run([userMessage], () => {}, controller.signal);

    // Loop should exit immediately, returning only original messages
    expect(history).toHaveLength(1);
  });

  test('stops when abort signal is triggered between turns', async () => {
    const controller = new AbortController();
    let turnCount = 0;

    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      textResponse('Should not reach'),
    ]);

    const toolExecutor = async () => {
      turnCount++;
      if (turnCount === 1) {
        // Abort after the first tool turn completes
        controller.abort();
      }
      return { content: 'data', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const history = await loop.run([userMessage], () => {}, controller.signal);

    // After the first tool turn, abort fires. The while loop checks signal at the
    // top and breaks. History: user, assistant(t1), user(result1)
    // The second provider call may or may not happen depending on when the abort
    // check triggers, but the loop should eventually stop.
    // At minimum, verify it doesn't run all 3 provider calls.
    expect(history.length).toBeLessThanOrEqual(4);

    // Verify the loop didn't reach the final text response
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    const hasToolUse = lastAssistant!.content.some(b => b.type === 'tool_use');
    // The last assistant message should be a tool_use, not the final text
    expect(hasToolUse).toBe(true);
  });

  // 7. Events — verify text_delta and other events are emitted
  test('emits text_delta events during streaming', async () => {
    const { provider } = createMockProvider([textResponse('Hello world')]);
    const loop = new AgentLoop(provider, 'system');

    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: 'text_delta'; text: string }).text).toBe('Hello world');
  });

  test('emits usage events', async () => {
    const { provider } = createMockProvider([textResponse('Hi')]);
    const loop = new AgentLoop(provider, 'system');

    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 5,
      model: 'mock-model',
    });
  });

  test('emits message_complete events', async () => {
    const { provider } = createMockProvider([textResponse('Done')]);
    const loop = new AgentLoop(provider, 'system');

    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    const completeEvents = events.filter((e) => e.type === 'message_complete');
    expect(completeEvents).toHaveLength(1);
    expect((completeEvents[0] as { type: 'message_complete'; message: Message }).message.role).toBe('assistant');
  });

  test('emits tool_use and tool_result events during tool execution', async () => {
    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/test.txt' }),
      textResponse('Done'),
    ]);

    const toolExecutor = async () => ({ content: 'file data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    const toolUseEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolUseEvents).toHaveLength(1);
    expect(toolUseEvents[0]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'read_file',
      input: { path: '/test.txt' },
    });

    const toolResultEvents = events.filter((e) => e.type === 'tool_result');
    expect(toolResultEvents).toHaveLength(1);
    expect((toolResultEvents[0] as Extract<AgentEvent, { type: 'tool_result' }>).toolUseId).toBe('t1');
    expect((toolResultEvents[0] as Extract<AgentEvent, { type: 'tool_result' }>).content).toBe('file data');
    expect((toolResultEvents[0] as Extract<AgentEvent, { type: 'tool_result' }>).isError).toBe(false);
  });

  // 8. Progress reminder injection every 5 tool-use turns
  test('injects progress reminder after every 5 tool-use turns', async () => {
    // Create 6 tool responses followed by a text response
    const responses: ProviderResponse[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push(toolUseResponse(`t${i}`, 'read_file', { path: `/file${i}.txt` }));
    }
    responses.push(textResponse('Finally done'));

    const { provider, calls } = createMockProvider(responses);
    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    await loop.run([userMessage], () => {});

    // After the 5th tool-use turn, the user message should contain a progress reminder
    // calls[5] is the 6th provider call; its messages[-1] should have the reminder
    const fifthTurnResultMsg = calls[5].messages[calls[5].messages.length - 1];
    const reminderBlock = fifthTurnResultMsg.content.find(
      (b): b is Extract<ContentBlock, { type: 'text' }> =>
        b.type === 'text' && b.text.includes('making meaningful progress'),
    );
    expect(reminderBlock).toBeDefined();
  });

  // 9. Tool executor error results are forwarded correctly
  test('forwards tool error results to provider', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/nonexistent.txt' }),
      textResponse('File not found, sorry.'),
    ]);

    const toolExecutor = async () => ({ content: 'ENOENT: file not found', isError: true });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    await loop.run([userMessage], () => {});

    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = lastMsg.content.find(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.is_error).toBe(true);
    expect(toolResultBlock!.content).toBe('ENOENT: file not found');
  });

  // 10. Tool output chunks are forwarded via onEvent
  test('emits tool_output_chunk events during tool execution', async () => {
    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/test.txt' }),
      textResponse('Done'),
    ]);

    const toolExecutor = async (
      _name: string,
      _input: Record<string, unknown>,
      onOutput?: (chunk: string) => void,
    ) => {
      onOutput?.('chunk1');
      onOutput?.('chunk2');
      return { content: 'full output', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    const chunkEvents = events.filter((e) => e.type === 'tool_output_chunk');
    expect(chunkEvents).toHaveLength(2);
    expect((chunkEvents[0] as Extract<AgentEvent, { type: 'tool_output_chunk' }>).chunk).toBe('chunk1');
    expect((chunkEvents[1] as Extract<AgentEvent, { type: 'tool_output_chunk' }>).chunk).toBe('chunk2');
  });

  // 11. System prompt and tools are passed to provider
  test('passes system prompt and tools to provider', async () => {
    const { provider, calls } = createMockProvider([textResponse('Hi')]);
    const loop = new AgentLoop(provider, 'My system prompt', {}, dummyTools);

    await loop.run([userMessage], () => {});

    expect(calls[0].systemPrompt).toBe('My system prompt');
    expect(calls[0].tools).toEqual(dummyTools);
  });

  // 12. No tools configured — tools are not passed to provider
  test('does not pass tools to provider when none are configured', async () => {
    const { provider, calls } = createMockProvider([textResponse('Hi')]);
    const loop = new AgentLoop(provider, 'system');

    await loop.run([userMessage], () => {});

    expect(calls[0].tools).toBeUndefined();
  });
});
