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
// Helpers (mirrors agent-loop.test.ts patterns)
// ---------------------------------------------------------------------------

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

/** Build a provider response containing N parallel tool_use blocks. */
function parallelToolUseResponse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ProviderResponse {
  return {
    content: tools.map((t) => ({
      type: 'tool_use' as const,
      id: t.id,
      name: t.name,
      input: t.input,
    })),
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use' as const,
  };
}

const dummyTools: ToolDefinition[] = [
  { name: 'delay_tool', description: 'Delays', input_schema: { type: 'object', properties: {} } },
];

const userMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Run benchmarks' }],
};

function collectEvents(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

// ---------------------------------------------------------------------------
// Benchmark Tests
// ---------------------------------------------------------------------------

describe('Parallel tool execution benchmarks', () => {
  // 1. 5 tools at 50ms each should complete in ~50ms (parallel), not ~250ms (sequential)
  test('5 tools at 50ms each complete in parallel (~50ms, not ~250ms)', async () => {
    const toolCount = 5;
    const delayMs = 50;

    const toolUseBlocks = Array.from({ length: toolCount }, (_, i) => ({
      id: `t${i}`,
      name: 'delay_tool',
      input: { index: i },
    }));

    const { provider } = createMockProvider([
      parallelToolUseResponse(toolUseBlocks),
      textResponse('All done.'),
    ]);

    const toolExecutor = async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { content: 'ok', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const start = Date.now();
    await loop.run([userMessage], () => {});
    const elapsed = Date.now() - start;

    // Parallel: ~50ms + overhead. Sequential would be ~250ms.
    // Allow up to 200ms for CI/scheduling overhead.
    expect(elapsed).toBeLessThan(200);
  });

  // 2. 10 tools at 50ms each should still complete quickly in parallel
  test('10 tools at 50ms each still complete in parallel (< 200ms)', async () => {
    const toolCount = 10;
    const delayMs = 50;

    const toolUseBlocks = Array.from({ length: toolCount }, (_, i) => ({
      id: `t${i}`,
      name: 'delay_tool',
      input: { index: i },
    }));

    const { provider } = createMockProvider([
      parallelToolUseResponse(toolUseBlocks),
      textResponse('All done.'),
    ]);

    const executionLog: { index: number; start: number; end: number }[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      const end = Date.now();
      executionLog.push({ index: input.index as number, start, end });
      return { content: 'ok', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const start = Date.now();
    await loop.run([userMessage], () => {});
    const elapsed = Date.now() - start;

    // All 10 tools should have executed
    expect(executionLog).toHaveLength(toolCount);

    // Parallel: ~50ms + overhead. Sequential would be ~500ms.
    // Allow up to 300ms for CI/scheduling overhead with 10 concurrent timers.
    expect(elapsed).toBeLessThan(300);

    // Verify overlap: all tools should start before any finishes
    const allStarts = executionLog.map((e) => e.start);
    const allEnds = executionLog.map((e) => e.end);
    const lastStart = Math.max(...allStarts);
    const firstEnd = Math.min(...allEnds);
    expect(lastStart).toBeLessThanOrEqual(firstEnd);
  });

  // 3. Mixed latencies: 1 slow (2s) + 4 fast (10ms) = ~2s total
  test('mixed latencies: 1 slow + 4 fast tools complete in slow-tool time', async () => {
    const toolUseBlocks = [
      { id: 'slow', name: 'delay_tool', input: { delayMs: 2000 } },
      { id: 'fast1', name: 'delay_tool', input: { delayMs: 10 } },
      { id: 'fast2', name: 'delay_tool', input: { delayMs: 10 } },
      { id: 'fast3', name: 'delay_tool', input: { delayMs: 10 } },
      { id: 'fast4', name: 'delay_tool', input: { delayMs: 10 } },
    ];

    const { provider } = createMockProvider([
      parallelToolUseResponse(toolUseBlocks),
      textResponse('Mixed done.'),
    ]);

    const completionOrder: string[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>) => {
      const delay = input.delayMs as number;
      await new Promise((r) => setTimeout(r, delay));
      completionOrder.push(
        toolUseBlocks.find((t) => t.input.delayMs === delay && !completionOrder.includes(t.id))?.id
          ?? `unknown-${delay}`,
      );
      return { content: 'ok', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const events: AgentEvent[] = [];
    const start = Date.now();
    await loop.run([userMessage], collectEvents(events));
    const elapsed = Date.now() - start;

    // Total time should be dominated by the slow tool (~2s), not additive (~2.04s)
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2500);

    // tool_result events should be emitted in tool_use order (slow first),
    // even though fast tools finish earlier
    const toolResultEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(toolResultEvents).toHaveLength(5);
    expect(toolResultEvents[0].toolUseId).toBe('slow');
    expect(toolResultEvents[1].toolUseId).toBe('fast1');
  }, 10000);

  // 4. Abort during parallel execution cancels within 200ms
  test('abort during parallel execution cancels within 200ms', async () => {
    const toolCount = 5;

    const toolUseBlocks = Array.from({ length: toolCount }, (_, i) => ({
      id: `t${i}`,
      name: 'delay_tool',
      input: { index: i },
    }));

    const { provider } = createMockProvider([
      parallelToolUseResponse(toolUseBlocks),
      textResponse('Should not reach.'),
    ]);

    const controller = new AbortController();

    const toolExecutor = async () => {
      // Each tool takes 10 seconds — abort should fire during execution
      setTimeout(() => controller.abort(), 50);
      await new Promise((r) => setTimeout(r, 10_000));
      return { content: 'should not return', isError: false };
    };

    const loop = new AgentLoop(provider, 'system', {}, dummyTools, toolExecutor);
    const start = Date.now();
    const history = await loop.run([userMessage], () => {}, controller.signal);
    const elapsed = Date.now() - start;

    // Should exit quickly after the 50ms abort, not wait 10s
    expect(elapsed).toBeLessThan(200);

    // History should have: user msg, assistant (tool_use), user (cancelled tool_results)
    expect(history).toHaveLength(3);

    const lastMsg = history[history.length - 1];
    expect(lastMsg.role).toBe('user');

    const toolResultBlocks = lastMsg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResultBlocks).toHaveLength(toolCount);

    // All results should be cancelled
    for (const block of toolResultBlocks) {
      expect(block.content).toBe('Cancelled by user');
      expect(block.is_error).toBe(true);
    }
  });
});
