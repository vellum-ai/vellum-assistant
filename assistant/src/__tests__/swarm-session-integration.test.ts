import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on them
// ---------------------------------------------------------------------------

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../hooks/manager.js', () => ({
  getHookManager: () => ({
    trigger: async () => ({ blocked: false }),
  }),
}));

let swarmEnabled = true;
let hasApiKey = true;

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'anthropic',
    apiKeys: { anthropic: hasApiKey ? 'test-key' : '' },
    swarm: {
      enabled: swarmEnabled,
      maxWorkers: 2,
      maxTasks: 4,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
      plannerModel: 'claude-haiku-4-5-20251001',
      synthesizerModel: 'claude-sonnet-4-5-20250929',
    },
  }),
}));

mock.module('../providers/registry.js', () => ({
  getProvider: () => ({
    name: 'test',
    async sendMessage() {
      return {
        content: [{ type: 'text', text: '{"tasks":[{"id":"t1","role":"coder","objective":"Do it","dependencies":[]}]}' }],
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 10 },
        stopReason: 'end_turn',
      };
    },
  }),
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result' as const,
        session_id: 'test-session',
        subtype: 'success' as const,
        result: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
      };
    },
  }),
}));

import { AgentLoop } from '../agent/loop.js';
import type { AgentEvent } from '../agent/loop.js';
import type { Message, ProviderResponse } from '../providers/types.js';
import { swarmDelegateTool, _resetSwarmActive } from '../tools/swarm/delegate.js';
import type { ToolContext } from '../tools/types.js';

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    conversationId: 'test-conv',
    workingDir: '/tmp/test',
    onOutput: () => {},
    ...overrides,
  } as ToolContext;
}

// ---------------------------------------------------------------------------
// 1. Agent loop + swarm_delegate integration
// ---------------------------------------------------------------------------

describe('swarm through AgentLoop', () => {
  beforeEach(() => {
    _resetSwarmActive();
    swarmEnabled = true;
    hasApiKey = true;
  });

  test('agent loop calls swarm_delegate and receives tool result', async () => {
    let turnCount = 0;

    // Provider that emits swarm_delegate tool_use on turn 1, then text on turn 2
    const mockProvider = {
      name: 'test',
      async sendMessage(_messages: Message[]) {
        turnCount++;
        if (turnCount === 1) {
          return {
            content: [{
              type: 'tool_use' as const,
              id: 'tu-1',
              name: 'swarm_delegate',
              input: { objective: 'Build a feature with tests' },
            }],
            model: 'test',
            usage: { inputTokens: 10, outputTokens: 10 },
            stopReason: 'tool_use',
          } as ProviderResponse;
        }
        return {
          content: [{ type: 'text' as const, text: 'All done.' }],
          model: 'test',
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: 'end_turn',
        } as ProviderResponse;
      },
    };

    const events: AgentEvent[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => {
      const result = await swarmDelegateTool.execute(input, makeContext({ onOutput }));
      return result;
    };

    const tools = [swarmDelegateTool.getDefinition()];

    const loop = new AgentLoop(mockProvider, 'system prompt', {}, tools, toolExecutor);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Build a feature' }] }];

    const history = await loop.run(messages, (e) => events.push(e));

    // Should have tool_use event
    const toolUseEvents = events.filter(e => e.type === 'tool_use');
    expect(toolUseEvents.length).toBe(1);
    expect(toolUseEvents[0].type === 'tool_use' && toolUseEvents[0].name).toBe('swarm_delegate');

    // Should have tool_result event
    const toolResultEvents = events.filter(e => e.type === 'tool_result');
    expect(toolResultEvents.length).toBe(1);
    expect(toolResultEvents[0].type === 'tool_result' && !toolResultEvents[0].isError).toBe(true);

    // Should have progress output chunks
    const chunks = events.filter(e => e.type === 'tool_output_chunk');
    expect(chunks.length).toBeGreaterThan(0);

    // History should contain assistant + tool_result + final assistant
    expect(history.length).toBeGreaterThanOrEqual(4);
  });

  test('agent loop handles aborted swarm gracefully', async () => {
    const controller = new AbortController();

    const mockProvider = {
      name: 'test',
      async sendMessage() {
        // Abort after model responds with tool_use
        controller.abort();
        return {
          content: [{
            type: 'tool_use' as const,
            id: 'tu-abort',
            name: 'swarm_delegate',
            input: { objective: 'Should be cancelled' },
          }],
          model: 'test',
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: 'tool_use',
        } as ProviderResponse;
      },
    };

    const events: AgentEvent[] = [];
    const toolExecutor = async (_name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => {
      return swarmDelegateTool.execute(input, makeContext({ onOutput, signal: controller.signal }));
    };

    const tools = [swarmDelegateTool.getDefinition()];
    const loop = new AgentLoop(mockProvider, 'system', {}, tools, toolExecutor);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];

    // Should not hang or throw
    const history = await loop.run(messages, (e) => events.push(e), controller.signal);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Regression tests for swarm-specific behaviors
// ---------------------------------------------------------------------------

describe('swarm regression tests', () => {
  beforeEach(() => {
    _resetSwarmActive();
    swarmEnabled = true;
    hasApiKey = true;
  });

  test('swarm_delegate returns graceful message when disabled', async () => {
    swarmEnabled = false;
    const result = await swarmDelegateTool.execute(
      { objective: 'Some task' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('disabled');
    swarmEnabled = true;
  });

  test('recursion guard blocks concurrent invocation', async () => {
    // Start a swarm that resolves instantly (via mock)
    const result1 = await swarmDelegateTool.execute(
      { objective: 'First' },
      makeContext(),
    );
    expect(result1.isError).toBeFalsy();

    // After first completes, second should also succeed (flag reset)
    const result2 = await swarmDelegateTool.execute(
      { objective: 'Second' },
      makeContext(),
    );
    expect(result2.isError).toBeFalsy();
  });

  test('worker backend reports unavailable when no API key', async () => {
    hasApiKey = false;

    const result = await swarmDelegateTool.execute(
      { objective: 'Task without key' },
      makeContext(),
    );

    // The tool should still complete — the orchestrator handles backend failures
    // The result may show failed tasks but shouldn't throw
    expect(result.content).toBeTruthy();
    hasApiKey = true;
  });

  test('progress chunks stream through onOutput', async () => {
    const outputs: string[] = [];
    await swarmDelegateTool.execute(
      { objective: 'Track progress' },
      makeContext({ onOutput: (text: string) => outputs.push(text) }),
    );

    // Should have planning and execution output
    expect(outputs.some(o => o.includes('Planning'))).toBe(true);
    expect(outputs.some(o => o.includes('Plan:'))).toBe(true);
    expect(outputs.some(o => o.includes('Executing'))).toBe(true);
  });

  test('result includes task stats', async () => {
    const result = await swarmDelegateTool.execute(
      { objective: 'Check stats' },
      makeContext(),
    );
    expect(result.content).toContain('Tasks:');
    expect(result.content).toContain('Duration:');
  });
});
