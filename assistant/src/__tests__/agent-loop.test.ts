import { describe, test, expect } from 'bun:test';
import { AgentLoop } from '../agent/loop.js';
import type { AgentEvent, CheckpointInfo, CheckpointDecision } from '../agent/loop.js';
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

  // 13. Parallel tool execution — multiple tool_use blocks in a single response
  test('executes multiple tools in parallel', async () => {
    const { provider, calls } = createMockProvider([
      // Provider returns 3 tool_use blocks in a single response
      {
        content: [
          { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: '/a.txt' } },
          { type: 'tool_use' as const, id: 't2', name: 'read_file', input: { path: '/b.txt' } },
          { type: 'tool_use' as const, id: 't3', name: 'read_file', input: { path: '/c.txt' } },
        ],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use' as const,
      },
      textResponse('Got all three files.'),
    ]);

    const executionLog: { path: string; start: number; end: number }[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>) => {
      const start = Date.now();
      // Simulate async work — all tools should overlap in time
      await new Promise(resolve => setTimeout(resolve, 50));
      const end = Date.now();
      executionLog.push({ path: (input as { path: string }).path, start, end });
      return { content: `contents of ${(input as { path: string }).path}`, isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    const history = await loop.run([userMessage], collectEvents(events));

    // All 3 tools should have been called
    expect(executionLog).toHaveLength(3);

    // Verify parallel execution: all tools should start before any finishes
    // (with 50ms delay each, sequential would take 150ms+, parallel ~50ms)
    const allStarts = executionLog.map(e => e.start);
    const allEnds = executionLog.map(e => e.end);
    const firstEnd = Math.min(...allEnds);
    const lastStart = Math.max(...allStarts);
    // In parallel execution, the last tool starts before the first tool ends
    expect(lastStart).toBeLessThanOrEqual(firstEnd);

    // Provider should have been called twice (tool batch + final text)
    expect(calls).toHaveLength(2);

    // Second call should contain 3 tool_result blocks in order
    const secondCallMessages = calls[1].messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlocks = lastMsg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResultBlocks).toHaveLength(3);
    expect(toolResultBlocks[0].tool_use_id).toBe('t1');
    expect(toolResultBlocks[1].tool_use_id).toBe('t2');
    expect(toolResultBlocks[2].tool_use_id).toBe('t3');

    // All tool_use events should be emitted before any tool_result events
    let lastToolUseIdx = -1;
    let firstToolResultIdx = events.length;
    events.forEach((e, i) => {
      if (e.type === 'tool_use') lastToolUseIdx = i;
      if (e.type === 'tool_result' && i < firstToolResultIdx) firstToolResultIdx = i;
    });
    expect(lastToolUseIdx).toBeLessThan(firstToolResultIdx);

    // Final history: user, assistant(3 tool_use), user(3 tool_result), assistant(text)
    expect(history).toHaveLength(4);
  });

  // 14. Abort before parallel tool execution synthesizes cancelled results
  test('synthesizes cancelled results when aborted before tool execution', async () => {
    const controller = new AbortController();

    const { provider } = createMockProvider([
      {
        content: [
          { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: '/a.txt' } },
          { type: 'tool_use' as const, id: 't2', name: 'read_file', input: { path: '/b.txt' } },
        ],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use' as const,
      },
    ]);

    // Abort during the provider call so the signal is already aborted
    // before tool execution begins
    const originalSendMessage = provider.sendMessage.bind(provider);
    provider.sendMessage = async (...args: Parameters<typeof provider.sendMessage>) => {
      const result = await originalSendMessage(...args);
      controller.abort();
      return result;
    };

    const toolCalls: string[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>) => {
      toolCalls.push((input as { path: string }).path);
      return { content: 'data', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    const history = await loop.run([userMessage], collectEvents(events), controller.signal);

    // No tools should have been executed
    expect(toolCalls).toHaveLength(0);

    // History should contain cancelled tool_result blocks
    const lastMsg = history[history.length - 1];
    expect(lastMsg.role).toBe('user');
    const toolResultBlocks = lastMsg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResultBlocks).toHaveLength(2);
    expect(toolResultBlocks[0].tool_use_id).toBe('t1');
    expect(toolResultBlocks[0].content).toBe('Cancelled by user');
    expect(toolResultBlocks[0].is_error).toBe(true);
    expect(toolResultBlocks[1].tool_use_id).toBe('t2');
    expect(toolResultBlocks[1].content).toBe('Cancelled by user');
    expect(toolResultBlocks[1].is_error).toBe(true);
  });

  // 15. Parallel tool_result events are emitted in deterministic tool_use order
  test('emits tool_result events in tool_use order regardless of completion timing', async () => {
    const { provider } = createMockProvider([
      {
        content: [
          { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: '/slow.txt' } },
          { type: 'tool_use' as const, id: 't2', name: 'read_file', input: { path: '/fast.txt' } },
          { type: 'tool_use' as const, id: 't3', name: 'read_file', input: { path: '/medium.txt' } },
        ],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use' as const,
      },
      textResponse('Done'),
    ]);

    // Tools complete in different order than they were called: t2 first, t3 second, t1 last
    const toolExecutor = async (_name: string, input: Record<string, unknown>) => {
      const path = (input as { path: string }).path;
      const delays: Record<string, number> = { '/slow.txt': 80, '/fast.txt': 10, '/medium.txt': 40 };
      await new Promise(resolve => setTimeout(resolve, delays[path] ?? 10));
      return { content: `contents of ${path}`, isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    await loop.run([userMessage], collectEvents(events));

    // Collect tool_result events in order
    const toolResultEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(toolResultEvents).toHaveLength(3);

    // Results must be in tool_use order (t1, t2, t3), NOT completion order (t2, t3, t1)
    expect(toolResultEvents[0].toolUseId).toBe('t1');
    expect(toolResultEvents[1].toolUseId).toBe('t2');
    expect(toolResultEvents[2].toolUseId).toBe('t3');
  });

  // ---------------------------------------------------------------------------
  // Checkpoint callback tests
  // ---------------------------------------------------------------------------

  // 16. Checkpoint callback is called after tool results with correct info
  test('checkpoint callback is called after tool results with correct info', async () => {
    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/test.txt' }),
      textResponse('Done'),
    ]);

    const toolExecutor = async () => ({ content: 'file data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return 'continue';
    };

    await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual({
      turnIndex: 0,
      toolCount: 1,
      hasToolUse: true,
    });
  });

  // 17. Returning 'continue' lets the loop proceed normally
  test('checkpoint returning continue lets the loop proceed normally', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      textResponse('All done'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const onCheckpoint = (): CheckpointDecision => 'continue';

    const history = await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    // All 3 provider calls should happen (2 tool turns + final text)
    expect(calls).toHaveLength(3);
    // Full history: user, assistant(t1), user(result1), assistant(t2), user(result2), assistant(text)
    expect(history).toHaveLength(6);
    expect(history[5].content).toEqual([{ type: 'text', text: 'All done' }]);
  });

  // 18. Returning 'yield' causes the loop to stop after that turn
  test('checkpoint returning yield causes the loop to stop', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      textResponse('Should not reach'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const onCheckpoint = (): CheckpointDecision => 'yield';

    const history = await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    // Only 1 provider call should happen — loop yields after first tool turn
    expect(calls).toHaveLength(1);
    // History: user, assistant(t1), user(result1)
    expect(history).toHaveLength(3);
    expect(history[1].role).toBe('assistant');
    expect(history[2].role).toBe('user');
  });

  // 19. Without a checkpoint callback, behavior is unchanged
  test('without checkpoint callback behavior is unchanged', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      textResponse('Done'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const history = await loop.run([userMessage], () => {});

    // Normal behavior: 2 provider calls, full history
    expect(calls).toHaveLength(2);
    expect(history).toHaveLength(4);
    expect(history[3].content).toEqual([{ type: 'text', text: 'Done' }]);
  });

  // 20. turnIndex increments correctly across turns
  test('turnIndex increments correctly across multiple turns', async () => {
    const { provider } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      toolUseResponse('t3', 'read_file', { path: '/c.txt' }),
      textResponse('Done'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return 'continue';
    };

    await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0].turnIndex).toBe(0);
    expect(checkpoints[1].turnIndex).toBe(1);
    expect(checkpoints[2].turnIndex).toBe(2);
  });

  // 21. Checkpoint is NOT called when there's no tool use
  test('checkpoint is not called when assistant responds with text only', async () => {
    const { provider } = createMockProvider([textResponse('Just a text response')]);
    const loop = new AgentLoop(provider, 'system', {}, dummyTools);

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return 'continue';
    };

    const history = await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    // Checkpoint should never be called for a text-only response
    expect(checkpoints).toHaveLength(0);
    // Normal response
    expect(history).toHaveLength(2);
    expect(history[1].content).toEqual([{ type: 'text', text: 'Just a text response' }]);
  });

  // 22. Checkpoint reports correct toolCount for parallel tool execution
  test('checkpoint reports correct toolCount for parallel tools', async () => {
    const { provider } = createMockProvider([
      {
        content: [
          { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: '/a.txt' } },
          { type: 'tool_use' as const, id: 't2', name: 'read_file', input: { path: '/b.txt' } },
          { type: 'tool_use' as const, id: 't3', name: 'read_file', input: { path: '/c.txt' } },
        ],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use' as const,
      },
      textResponse('Got all three'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const checkpoints: CheckpointInfo[] = [];
    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      checkpoints.push(checkpoint);
      return 'continue';
    };

    await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].toolCount).toBe(3);
    expect(checkpoints[0].hasToolUse).toBe(true);
  });

  // 23. Yield on second turn — first turn proceeds, second stops
  test('yield on second turn lets first turn proceed and stops on second', async () => {
    const { provider, calls } = createMockProvider([
      toolUseResponse('t1', 'read_file', { path: '/a.txt' }),
      toolUseResponse('t2', 'read_file', { path: '/b.txt' }),
      textResponse('Should not reach'),
    ]);

    const toolExecutor = async () => ({ content: 'data', isError: false });
    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);

    const onCheckpoint = (checkpoint: CheckpointInfo): CheckpointDecision => {
      // Yield on the second turn (turnIndex 1)
      return checkpoint.turnIndex === 1 ? 'yield' : 'continue';
    };

    const history = await loop.run([userMessage], () => {}, undefined, undefined, onCheckpoint);

    // 2 provider calls: first tool turn + second tool turn (yield after second)
    expect(calls).toHaveLength(2);
    // History: user, assistant(t1), user(result1), assistant(t2), user(result2)
    expect(history).toHaveLength(5);
  });
});
