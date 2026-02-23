import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'session-process-bridge-test-'));

// ── Platform + logger mocks ─────────────────────────────────────────

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: { anthropic: 'test-key' },
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    memory: { enabled: false },
    calls: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
  }),
}));

// ── Mock the call bridge ─────────────────────────────────────────────

import type { CallBridgeResult } from '../calls/call-bridge.js';

const mockTryRouteCallMessage = mock(
  (_convId: string, _text: string, _msgId?: string): Promise<CallBridgeResult> =>
    Promise.resolve({ handled: false, reason: 'no_active_call' }),
);

mock.module('../calls/call-bridge.js', () => ({
  tryRouteCallMessage: (...args: [string, string, string?]) => mockTryRouteCallMessage(...args),
}));

// ── Mock slash resolution ────────────────────────────────────────────

mock.module('./session-slash.js', () => ({
  resolveSlash: (content: string) => ({ kind: 'passthrough' as const, content }),
}));

// ── Import after mocks ──────────────────────────────────────────────

import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { ProcessSessionContext } from '../daemon/session-process.js';
import { processMessage, drainQueue } from '../daemon/session-process.js';
import { MessageQueue } from '../daemon/session-queue-manager.js';

// ── Session mock factory ─────────────────────────────────────────────

function createMockSession(overrides?: Partial<ProcessSessionContext>): ProcessSessionContext {
  return {
    conversationId: 'test-conv',
    messages: [],
    processing: false,
    abortController: null,
    currentRequestId: undefined,
    queue: new MessageQueue(),
    traceEmitter: {
      emit: () => {},
    } as unknown as ProcessSessionContext['traceEmitter'],
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    persistUserMessage: mock((_content: string, _attachments: unknown[], _requestId?: string) => 'mock-msg-id'),
    runAgentLoop: mock(async () => {}),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('session-process bridge consumption', () => {
  beforeEach(() => {
    mockTryRouteCallMessage.mockReset();
  });

  // ── Direct processMessage path ───────────────────────────────

  test('processMessage emits assistant_text_delta + message_complete when bridge consumes with userFacingText', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: true,
      userFacingText: 'Instruction relayed to active call.',
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession();

    await processMessage(session, 'ask about pricing', [], onEvent);

    // Should have emitted text delta then message_complete
    const textDelta = events.find((e) => e.type === 'assistant_text_delta');
    expect(textDelta).toBeDefined();
    expect((textDelta as { text: string }).text).toBe('Instruction relayed to active call.');

    const complete = events.find((e) => e.type === 'message_complete');
    expect(complete).toBeDefined();

    // Should NOT have called runAgentLoop
    expect(session.runAgentLoop).not.toHaveBeenCalled();
  });

  test('processMessage emits failure text when bridge consumes with failure userFacingText', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: true,
      reason: 'instruction_relay_failed',
      userFacingText: 'Failed to relay instruction to the active call.',
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession();

    await processMessage(session, 'change the topic', [], onEvent);

    const textDelta = events.find((e) => e.type === 'assistant_text_delta');
    expect(textDelta).toBeDefined();
    expect((textDelta as { text: string }).text).toBe('Failed to relay instruction to the active call.');

    const complete = events.find((e) => e.type === 'message_complete');
    expect(complete).toBeDefined();

    // Only one message_complete
    const completeCount = events.filter((e) => e.type === 'message_complete').length;
    expect(completeCount).toBe(1);

    expect(session.runAgentLoop).not.toHaveBeenCalled();
  });

  test('processMessage skips text delta when bridge consumes without userFacingText', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: true,
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession();

    await processMessage(session, 'hello', [], onEvent);

    const textDelta = events.find((e) => e.type === 'assistant_text_delta');
    expect(textDelta).toBeUndefined();

    const complete = events.find((e) => e.type === 'message_complete');
    expect(complete).toBeDefined();

    expect(session.runAgentLoop).not.toHaveBeenCalled();
  });

  test('processMessage falls through to agent loop when bridge does not consume', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: false,
      reason: 'no_active_call',
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession();

    await processMessage(session, 'normal message', [], onEvent);

    expect(session.runAgentLoop).toHaveBeenCalled();
  });

  // ── Queued routeOrProcess path ───────────────────────────────

  test('drainQueue emits assistant_text_delta + message_complete for bridge-consumed queued message', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: true,
      userFacingText: 'Instruction relayed to active call.',
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession({ processing: true });

    // Enqueue a message
    session.queue.push({
      content: 'ask about pricing',
      attachments: [],
      requestId: 'req-1',
      onEvent,
    });

    drainQueue(session);

    // Wait for async routeOrProcess
    await new Promise((r) => setTimeout(r, 50));

    const textDelta = events.find((e) => e.type === 'assistant_text_delta');
    expect(textDelta).toBeDefined();
    expect((textDelta as { text: string }).text).toBe('Instruction relayed to active call.');

    // message_complete (from dequeue + bridge consumption — only one expected for this request)
    const completeEvents = events.filter((e) => e.type === 'message_complete');
    expect(completeEvents.length).toBe(1);

    expect(session.runAgentLoop).not.toHaveBeenCalled();
  });

  test('drainQueue emits failure text for bridge-consumed queued message with relay failure', async () => {
    mockTryRouteCallMessage.mockResolvedValue({
      handled: true,
      reason: 'instruction_relay_failed',
      userFacingText: 'Failed to relay instruction to the active call.',
    });

    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);
    const session = createMockSession({ processing: true });

    session.queue.push({
      content: 'change the topic',
      attachments: [],
      requestId: 'req-2',
      onEvent,
    });

    drainQueue(session);
    await new Promise((r) => setTimeout(r, 50));

    const textDelta = events.find((e) => e.type === 'assistant_text_delta');
    expect(textDelta).toBeDefined();
    expect((textDelta as { text: string }).text).toBe('Failed to relay instruction to the active call.');

    expect(session.runAgentLoop).not.toHaveBeenCalled();
  });
});
