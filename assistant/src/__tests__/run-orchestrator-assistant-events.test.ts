/**
 * Tests that HTTP-triggered run/session flows mirror messages into the
 * assistant-events hub with payload parity to IPC outbound messages.
 *
 * Tests:
 *   - confirmation_request → hub emits one AssistantEvent
 *   - assistant_text_delta + message_complete → hub emits in order
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';
import type { AssistantEvent } from '../runtime/assistant-event.js';

const testDir = mkdtempSync(join(tmpdir(), 'run-orch-hub-test-'));

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

import { initializeDb, getDb } from '../memory/db.js';
import { createConversation } from '../memory/conversation-store.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';

initializeDb();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a session that calls the updateClient handler with all given messages,
 * then resolves (simulates a completed agent loop).
 */
function makeSessionEmitting(...messages: ServerMessage[]): Session {
  let clientHandler: (msg: ServerMessage) => void = () => {};
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: (handler: (msg: ServerMessage) => void) => {
      clientHandler = handler;
    },
    runAgentLoop: async () => {
      for (const msg of messages) {
        clientHandler(msg);
      }
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HTTP run → confirmation_request mirrors to assistant-events hub', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('confirmation_request emits one AssistantEvent with correct shape', async () => {
    const conversation = createConversation('http-confirmation-test');
    const confirmationMsg: ServerMessage = {
      type: 'confirmation_request',
      requestId: 'req-http-1',
      toolName: 'bash',
      input: { command: 'ls' },
      riskLevel: 'medium',
      allowlistOptions: [{ label: 'ls', description: 'List files', pattern: 'ls' }],
      scopeOptions: [{ label: 'everywhere', scope: 'everywhere' }],
    };
    const session = makeSessionEmitting(confirmationMsg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'ast-http-1' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
    });

    await orchestrator.startRun('ast-http-1', conversation.id, 'Do something');
    // Wait for the async hub chain to flush.
    await new Promise((r) => setTimeout(r, 20));

    sub.dispose();

    expect(received).toHaveLength(1);
    expect(received[0].assistantId).toBe('ast-http-1');
    expect(received[0].sessionId).toBe(conversation.id);
    expect(received[0].message.type).toBe('confirmation_request');
    expect(received[0].message).toBe(confirmationMsg);
  });
});

describe('HTTP run → message flow mirrors to assistant-events hub', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('assistant_text_delta and message_complete emit in order', async () => {
    const conversation = createConversation('http-message-flow-test');
    const deltaMsg: ServerMessage = {
      type: 'assistant_text_delta',
      sessionId: conversation.id,
      text: 'Working on it...',
    };
    const completeMsg: ServerMessage = {
      type: 'message_complete',
      sessionId: conversation.id,
    };
    const session = makeSessionEmitting(deltaMsg, completeMsg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'ast-http-2' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
    });

    await orchestrator.startRun('ast-http-2', conversation.id, 'Hello');
    await new Promise((r) => setTimeout(r, 20));

    sub.dispose();

    expect(received).toHaveLength(2);
    expect(received[0].message.type).toBe('assistant_text_delta');
    expect(received[1].message.type).toBe('message_complete');
    // Both should carry the session id
    expect(received[0].sessionId).toBe(conversation.id);
    expect(received[1].sessionId).toBe(conversation.id);
    // Messages are the unmodified originals
    expect(received[0].message).toBe(deltaMsg);
    expect(received[1].message).toBe(completeMsg);
  });

  test('sessionId falls back to conversationId when message lacks it', async () => {
    const conversation = createConversation('http-session-fallback-test');
    // pong has no sessionId field
    const msg: ServerMessage = { type: 'pong' };
    const session = makeSessionEmitting(msg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'ast-http-3' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
    });

    await orchestrator.startRun('ast-http-3', conversation.id, 'ping');
    await new Promise((r) => setTimeout(r, 20));

    sub.dispose();

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe(conversation.id);
  });
});
