import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';

const testDir = mkdtempSync(join(tmpdir(), 'run-orchestrator-test-'));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
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
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    secretDetection: { enabled: false },
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { createConversation } from '../memory/conversation-store.js';
import { createRun, getRun, setRunConfirmation } from '../memory/runs-store.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';
import type { VoiceRunEventSink } from '../runtime/run-orchestrator.js';
import type { ChannelCapabilities } from '../daemon/session-runtime-assembly.js';

initializeDb();

function makeSessionWithConfirmation(message: ServerMessage): Session {
  let clientHandler: (msg: ServerMessage) => void = () => {};
  return {
    isProcessing: () => false,
    // Return undefined so createRun stores messageId as null and avoids
    // a foreign-key dependency on the conversation-store message table.
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    updateClient: (handler: (msg: ServerMessage) => void) => {
      clientHandler = handler;
    },
    runAgentLoop: async () => {
      clientHandler(message);
      return await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

/**
 * Build a session whose runAgentLoop emits the given message via the onEvent
 * callback and then resolves (simulating a completed agent loop).
 */
function makeSessionWithEvent(message: ServerMessage): Session {
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    updateClient: () => {},
    runAgentLoop: async (_content: string, _messageId: string, onEvent: (msg: ServerMessage) => void) => {
      onEvent(message);
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

describe('run failure detection', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('session_error event marks the run as failed', async () => {
    const conversation = createConversation('session error test');
    const session = makeSessionWithEvent({
      type: 'session_error',
      sessionId: conversation.id,
      code: 'PROVIDER_NETWORK',
      userMessage: 'Unable to reach the AI provider.',
      retryable: true,
    });

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const { run } = await orchestrator.startRun(conversation.id, 'Hello');

    // The agent loop fires asynchronously; give it a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('Unable to reach the AI provider.');
  });

  test('generic error event still marks the run as failed', async () => {
    const conversation = createConversation('generic error test');
    const session = makeSessionWithEvent({
      type: 'error',
      message: 'Something went wrong',
    });

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const { run } = await orchestrator.startRun(conversation.id, 'Hello');

    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('Something went wrong');
  });
});

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('run approval state executionTarget', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('stores pending confirmation executionTarget when provided', () => {
    const conversation = createConversation('run test');
    const run = createRun(conversation.id);

    setRunConfirmation(run.id, {
      toolName: 'host_file_read',
      toolUseId: 'req-1',
      input: { path: '/etc/hosts' },
      riskLevel: 'medium',
      executionTarget: 'host',
      allowlistOptions: [{ label: '/etc/hosts', pattern: 'host_file_read:/etc/hosts' }],
      scopeOptions: [{ label: 'everywhere', scope: 'everywhere' }],
    });

    const stored = getRun(run.id);
    expect(stored?.status).toBe('needs_confirmation');
    expect(stored?.pendingConfirmation?.executionTarget).toBe('host');
  });

  test('parses pending confirmations without executionTarget for legacy rows', () => {
    const conversation = createConversation('legacy run test');
    const run = createRun(conversation.id);

    setRunConfirmation(run.id, {
      toolName: 'bash',
      toolUseId: 'req-legacy',
      input: { command: 'ls' },
      riskLevel: 'medium',
      allowlistOptions: [{ label: 'ls', pattern: 'ls' }],
      scopeOptions: [{ label: '/tmp', scope: '/tmp' }],
    });

    const stored = getRun(run.id);
    expect(stored?.status).toBe('needs_confirmation');
    expect(stored?.pendingConfirmation?.executionTarget).toBeUndefined();
  });

  test('run orchestrator persists executionTarget from confirmation_request', async () => {
    const conversation = createConversation('orchestrator run test');
    const session = makeSessionWithConfirmation({
      type: 'confirmation_request',
      requestId: 'req-2',
      toolName: 'host_bash',
      input: { command: 'pwd' },
      riskLevel: 'medium',
      executionTarget: 'host',
      allowlistOptions: [{ label: 'pwd', description: 'This exact command', pattern: 'pwd' }],
      scopeOptions: [{ label: 'everywhere', scope: 'everywhere' }],
    });

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const { run } = await orchestrator.startRun(conversation.id, 'Run host command');
    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('needs_confirmation');
    expect(stored?.pendingConfirmation?.executionTarget).toBe('host');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Channel capability resolution via sourceChannel (WS-D)
// ═══════════════════════════════════════════════════════════════════════════

describe('startRun channel capability resolution', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('resolves channel capabilities from provided sourceChannel', async () => {
    const conversation = createConversation('telegram channel test');
    let capturedCapabilities: ChannelCapabilities | null = null;

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {},
      setChannelCapabilities: (caps: ChannelCapabilities | null) => {
        if (caps) capturedCapabilities = caps;
      },
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello from Telegram', undefined, {
      sourceChannel: 'telegram',
    });

    // Wait for the async agent loop to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedCapabilities).not.toBeNull();
    expect(capturedCapabilities!.channel).toBe('telegram');
    expect(capturedCapabilities!.dashboardCapable).toBe(false);
  });

  test('defaults to macos (from http-api fallback) when no sourceChannel is provided', async () => {
    const conversation = createConversation('http-api default test');
    let capturedCapabilities: ChannelCapabilities | null = null;

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {},
      setChannelCapabilities: (caps: ChannelCapabilities | null) => {
        if (caps) capturedCapabilities = caps;
      },
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello from HTTP');

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedCapabilities).not.toBeNull();
    expect(capturedCapabilities!.channel).toBe('macos');
  });

  test('defaults to macos (from http-api fallback) when options are provided without sourceChannel', async () => {
    const conversation = createConversation('options no channel test');
    let capturedCapabilities: ChannelCapabilities | null = null;

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {},
      setChannelCapabilities: (caps: ChannelCapabilities | null) => {
        if (caps) capturedCapabilities = caps;
      },
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello with options', undefined, {
      forceStrictSideEffects: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedCapabilities).not.toBeNull();
    expect(capturedCapabilities!.channel).toBe('macos');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// strictSideEffects re-derivation prevents stale flag across runs
// ═══════════════════════════════════════════════════════════════════════════

describe('strictSideEffects re-derivation across runs', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('forceStrictSideEffects=true does not persist to subsequent run without override', async () => {
    const conversation = createConversation('stale strict test');

    // Shared session simulating a cached session reused across runs
    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    // First run: force strict mode on
    await orchestrator.startRun(conversation.id, 'non-guardian message', undefined, {
      forceStrictSideEffects: true,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect((session as unknown as { memoryPolicy: { strictSideEffects: boolean } }).memoryPolicy.strictSideEffects).toBe(true);

    // Second run: no override — should reset to derived default (false)
    await orchestrator.startRun(conversation.id, 'guardian message');
    await new Promise((r) => setTimeout(r, 50));

    expect((session as unknown as { memoryPolicy: { strictSideEffects: boolean } }).memoryPolicy.strictSideEffects).toBe(false);
  });

  test('private thread re-derives strictSideEffects=true when no override', async () => {
    const conversation = createConversation('private thread strict test');

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: { scopeId: 'private-scope', includeDefaultFallback: true, strictSideEffects: true },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      // Simulate private thread → default is true
      deriveDefaultStrictSideEffects: () => true,
    });

    // Run with explicit false override
    await orchestrator.startRun(conversation.id, 'override to false', undefined, {
      forceStrictSideEffects: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect((session as unknown as { memoryPolicy: { strictSideEffects: boolean } }).memoryPolicy.strictSideEffects).toBe(false);

    // Run without override — should re-derive to true (private thread)
    await orchestrator.startRun(conversation.id, 'no override');
    await new Promise((r) => setTimeout(r, 50));

    expect((session as unknown as { memoryPolicy: { strictSideEffects: boolean } }).memoryPolicy.strictSideEffects).toBe(true);
  });

  test('explicit forceStrictSideEffects=false sets strict to false', async () => {
    const conversation = createConversation('explicit false test');

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: true },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => true,
    });

    await orchestrator.startRun(conversation.id, 'force off', undefined, {
      forceStrictSideEffects: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect((session as unknown as { memoryPolicy: { strictSideEffects: boolean } }).memoryPolicy.strictSideEffects).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VoiceRunEventSink forwarding
// ═══════════════════════════════════════════════════════════════════════════

describe('eventSink forwarding', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('eventSink receives assistant_text_delta events', async () => {
    const conversation = createConversation('event sink delta test');
    const deltaMsg: ServerMessage = {
      type: 'assistant_text_delta',
      text: 'Hello from agent',
      sessionId: conversation.id,
    };
    const session = makeSessionWithEvent(deltaMsg);

    const receivedDeltas: string[] = [];
    const sink: VoiceRunEventSink = {
      onTextDelta: (text) => receivedDeltas.push(text),
      onMessageComplete: () => {},
      onError: () => {},
      onToolUse: () => {},
    };

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello', undefined, {
      eventSink: sink,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedDeltas).toEqual(['Hello from agent']);
  });

  test('eventSink receives error events', async () => {
    const conversation = createConversation('event sink error test');
    const errMsg: ServerMessage = {
      type: 'error',
      message: 'Something broke',
    };
    const session = makeSessionWithEvent(errMsg);

    const receivedErrors: string[] = [];
    const sink: VoiceRunEventSink = {
      onTextDelta: () => {},
      onMessageComplete: () => {},
      onError: (msg) => receivedErrors.push(msg),
      onToolUse: () => {},
    };

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello', undefined, {
      eventSink: sink,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedErrors).toEqual(['Something broke']);
  });

  test('eventSink receives tool_use_start events', async () => {
    const conversation = createConversation('event sink tool test');
    const toolMsg: ServerMessage = {
      type: 'tool_use_start',
      toolName: 'web_search',
      input: { query: 'test' },
      sessionId: conversation.id,
    };
    const session = makeSessionWithEvent(toolMsg);

    const receivedTools: Array<{ name: string; input: Record<string, unknown> }> = [];
    const sink: VoiceRunEventSink = {
      onTextDelta: () => {},
      onMessageComplete: () => {},
      onError: () => {},
      onToolUse: (name, input) => receivedTools.push({ name, input }),
    };

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello', undefined, {
      eventSink: sink,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedTools).toHaveLength(1);
    expect(receivedTools[0].name).toBe('web_search');
    expect(receivedTools[0].input).toEqual({ query: 'test' });
  });

  test('eventSink receives onMessageComplete on generation_cancelled', async () => {
    const conversation = createConversation('event sink cancelled test');
    const cancelledMsg: ServerMessage = {
      type: 'generation_cancelled',
      sessionId: conversation.id,
    };
    const session = makeSessionWithEvent(cancelledMsg);

    let messageCompleteCount = 0;
    const receivedErrors: string[] = [];
    const sink: VoiceRunEventSink = {
      onTextDelta: () => {},
      onMessageComplete: () => { messageCompleteCount++; },
      onError: (msg) => receivedErrors.push(msg),
      onToolUse: () => {},
    };

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello', undefined, {
      eventSink: sink,
    });
    await new Promise((r) => setTimeout(r, 50));

    // generation_cancelled should be forwarded as onMessageComplete
    expect(messageCompleteCount).toBe(1);
    // It should NOT trigger onError
    expect(receivedErrors).toHaveLength(0);
  });

  test('eventSink receives onError when runAgentLoop throws', async () => {
    const conversation = createConversation('event sink exception test');

    // Build a session whose runAgentLoop throws an exception instead of
    // emitting events — simulating an unhandled crash in the agent loop.
    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {
        throw new Error('Unexpected agent crash');
      },
      handleConfirmationResponse: () => {},
    } as unknown as Session;

    const receivedErrors: string[] = [];
    const sink: VoiceRunEventSink = {
      onTextDelta: () => {},
      onMessageComplete: () => {},
      onError: (msg) => receivedErrors.push(msg),
      onToolUse: () => {},
    };

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello', undefined, {
      eventSink: sink,
    });
    await new Promise((r) => setTimeout(r, 50));

    // The exception message should be forwarded to the event sink
    expect(receivedErrors).toEqual(['Unexpected agent crash']);
  });

  test('no events forwarded when eventSink is not provided', async () => {
    const conversation = createConversation('no sink test');
    const deltaMsg: ServerMessage = {
      type: 'assistant_text_delta',
      text: 'Hello',
      sessionId: conversation.id,
    };
    const session = makeSessionWithEvent(deltaMsg);

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    // Should not throw when no eventSink is provided
    const { run } = await orchestrator.startRun(conversation.id, 'Hello');
    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run abort / cancellation
// ═══════════════════════════════════════════════════════════════════════════

describe('run abort', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('startRun returns an abort function', async () => {
    const conversation = createConversation('abort handle test');
    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (_c: string, _a: unknown[], reqId: string) => {
        session.currentRequestId = reqId;
        return undefined as unknown as string;
      },
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
      abort: () => {},
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const handle = await orchestrator.startRun(conversation.id, 'Hello');
    expect(typeof handle.abort).toBe('function');
    expect(handle.run.id).toBeDefined();
  });

  test('aborting a run does not crash session state', async () => {
    const conversation = createConversation('abort safety test');
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (_c: string, _a: unknown[], reqId: string) => {
        session.currentRequestId = reqId;
        return undefined as unknown as string;
      },
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {
        // Simulate a long-running agent loop
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => { abortCalled = true; },
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const handle = await orchestrator.startRun(conversation.id, 'Hello');

    // Abort immediately — session still has same requestId
    handle.abort();
    expect(abortCalled).toBe(true);

    // Wait for cleanup to settle
    await new Promise((r) => setTimeout(r, 300));

    // Session state should not be corrupted — the run completes normally
    // since the mock runAgentLoop resolves after 200ms regardless.
    const stored = orchestrator.getRun(handle.run.id);
    expect(stored).not.toBeNull();
  });

  test('stale abort handle is a no-op when session has moved to a new run', async () => {
    const conversation = createConversation('stale abort test');
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (_c: string, _a: unknown[], reqId: string) => {
        session.currentRequestId = reqId;
        return undefined as unknown as string;
      },
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {},
      handleConfirmationResponse: () => {},
      abort: () => { abortCalled = true; },
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    // Start first run and capture its handle
    const handle1 = await orchestrator.startRun(conversation.id, 'First turn');
    await new Promise((r) => setTimeout(r, 50));

    // Start second run — session's currentRequestId now belongs to run 2
    const _handle2 = await orchestrator.startRun(conversation.id, 'Second turn');

    // Attempt to abort using the stale handle from run 1.
    // Since the session has moved to a new requestId, this should be a no-op.
    handle1.abort();
    expect(abortCalled).toBe(false);
  });

  test('abort works when session still has matching requestId', async () => {
    const conversation = createConversation('matching abort test');
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (_c: string, _a: unknown[], reqId: string) => {
        session.currentRequestId = reqId;
        return undefined as unknown as string;
      },
      memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      updateClient: () => {},
      runAgentLoop: async () => {
        // Keep the agent loop running so the session stays on this requestId
        await new Promise((r) => setTimeout(r, 500));
      },
      handleConfirmationResponse: () => {},
      abort: () => { abortCalled = true; },
    } as unknown as Session;

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    const handle = await orchestrator.startRun(conversation.id, 'Hello');

    // Abort while the session is still processing this run
    handle.abort();
    expect(abortCalled).toBe(true);
  });
});
