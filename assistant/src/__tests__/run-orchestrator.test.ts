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

initializeDb();

function makeSessionWithConfirmation(message: ServerMessage): Session {
  let clientHandler: (msg: ServerMessage) => void = () => {};
  return {
    isProcessing: () => false,
    // Return undefined so createRun stores messageId as null and avoids
    // a foreign-key dependency on the conversation-store message table.
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
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
    setAssistantId: () => {},
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
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Hello');

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
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Hello');

    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('Something went wrong');
  });
});

describe('run approval state executionTarget', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('stores pending confirmation executionTarget when provided', () => {
    const conversation = createConversation('run test');
    const run = createRun('assistant-1', conversation.id);

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
    const run = createRun('assistant-1', conversation.id);

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
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Run host command');
    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('needs_confirmation');
    expect(stored?.pendingConfirmation?.executionTarget).toBe('host');
  });
});
