/**
 * Integration tests for the run API lifecycle with swarm tool behavior.
 *
 * Verifies: create run → poll status → completion/failure transitions,
 * including queue behavior when a swarm is active.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';

const testDir = mkdtempSync(join(tmpdir(), 'runtime-runs-test-'));

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
import { RunOrchestrator } from '../runtime/run-orchestrator.js';

initializeDb();

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Session whose agent loop completes immediately (success). */
function makeCompletingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      // Simulate brief processing then complete
      await new Promise((r) => setTimeout(r, 20));
      processing = false;
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

/** Session whose agent loop hangs (simulating a long-running swarm). */
function makeHangingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      // Never resolves — simulates an active swarm
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

/** Session whose agent loop fails with an error event. */
function makeFailingSession(errorMsg: string): Session {
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: () => {},
    runAgentLoop: async (_content: string, _messageId: string, onEvent: (msg: ServerMessage) => void) => {
      onEvent({ type: 'error', message: errorMsg });
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

/** Session whose agent loop emits a confirmation_request. */
function makeConfirmationSession(toolName: string): Session {
  let clientHandler: (msg: ServerMessage) => void = () => {};
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: (handler: (msg: ServerMessage) => void) => {
      clientHandler = handler;
    },
    runAgentLoop: async () => {
      clientHandler({
        type: 'confirmation_request',
        requestId: 'req-1',
        toolName,
        input: { objective: 'test task' },
        riskLevel: 'medium',
        allowlistOptions: [],
        scopeOptions: [],
      });
      // Hang to simulate waiting for decision
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime runs — swarm lifecycle', () => {
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

  test('run transitions to completed after agent loop finishes', async () => {
    const conversation = createConversation('run complete test');
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeCompletingSession(),
      resolveAttachments: () => [],
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Build a feature');
    expect(run.status).toBe('running');

    // Wait for agent loop to complete
    await new Promise((r) => setTimeout(r, 100));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('completed');
  });

  test('run transitions to failed when agent loop reports error', async () => {
    const conversation = createConversation('run error test');
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeFailingSession('Swarm backend unavailable'),
      resolveAttachments: () => [],
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Run swarm');

    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('Swarm backend unavailable');
  });

  test('run enters needs_confirmation when tool requires approval', async () => {
    const conversation = createConversation('run confirmation test');
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeConfirmationSession('swarm_delegate'),
      resolveAttachments: () => [],
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Delegate a swarm task');

    // Give agent loop time to emit confirmation_request
    await new Promise((r) => setTimeout(r, 50));

    const stored = orchestrator.getRun(run.id);
    expect(stored?.status).toBe('needs_confirmation');
    expect(stored?.pendingConfirmation?.toolName).toBe('swarm_delegate');
  });

  test('decision endpoint transitions run back to running', async () => {
    const conversation = createConversation('run decision test');
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeConfirmationSession('swarm_delegate'),
      resolveAttachments: () => [],
    });

    const run = await orchestrator.startRun('assistant-1', conversation.id, 'Run with approval');
    await new Promise((r) => setTimeout(r, 50));

    // Verify pending state
    const pending = orchestrator.getRun(run.id);
    expect(pending?.status).toBe('needs_confirmation');

    // Submit decision
    const result = orchestrator.submitDecision(run.id, 'allow');
    expect(result).toBe('applied');

    // Confirmation should be cleared
    const after = orchestrator.getRun(run.id);
    expect(after?.pendingConfirmation).toBeNull();
  });

  test('second run on busy session is rejected', async () => {
    const hangingSession = makeHangingSession();
    const conversation = createConversation('queue test');
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => hangingSession,
      resolveAttachments: () => [],
    });

    // First run starts and hangs
    await orchestrator.startRun('assistant-1', conversation.id, 'First run');
    await new Promise((r) => setTimeout(r, 20));

    // Second run on the same session should be rejected
    try {
      await orchestrator.startRun('assistant-1', conversation.id, 'Second run');
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain('already processing');
    }
  });

  test('getRun returns null for nonexistent run', () => {
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeCompletingSession(),
      resolveAttachments: () => [],
    });
    expect(orchestrator.getRun('nonexistent-id')).toBeNull();
  });

  test('submitDecision returns run_not_found for unknown run', () => {
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => makeCompletingSession(),
      resolveAttachments: () => [],
    });
    const result = orchestrator.submitDecision('nonexistent-id', 'allow');
    expect(result).toBe('run_not_found');
  });
});
