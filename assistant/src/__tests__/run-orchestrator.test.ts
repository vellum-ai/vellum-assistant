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

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { createConversation } from '../memory/conversation-store.js';
import { createRun, getRun, setRunConfirmation } from '../memory/runs-store.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';
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

    const run = await orchestrator.startRun(conversation.id, 'Hello');

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

    const run = await orchestrator.startRun(conversation.id, 'Hello');

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

    const run = await orchestrator.startRun(conversation.id, 'Run host command');
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

  test('defaults to http-api when no sourceChannel is provided', async () => {
    const conversation = createConversation('http-api default test');
    let capturedCapabilities: ChannelCapabilities | null = null;

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {},
      setChannelCapabilities: (caps: ChannelCapabilities | null) => {
        if (caps) capturedCapabilities = caps;
      },
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
    expect(capturedCapabilities!.channel).toBe('http-api');
  });

  test('defaults to http-api when options are provided without sourceChannel', async () => {
    const conversation = createConversation('options no channel test');
    let capturedCapabilities: ChannelCapabilities | null = null;

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {},
      setChannelCapabilities: (caps: ChannelCapabilities | null) => {
        if (caps) capturedCapabilities = caps;
      },
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
    expect(capturedCapabilities!.channel).toBe('http-api');
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
