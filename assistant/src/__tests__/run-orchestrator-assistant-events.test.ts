/**
 * Tests that HTTP-triggered run/session flows mirror messages into the
 * assistant-events hub with payload parity to IPC outbound messages.
 *
 * The Session class has two distinct outbound paths:
 *   1. updateClient handler — used by the prompter for confirmation_request,
 *      trace emitter, secret prompter.
 *   2. runAgentLoop onEvent callback — used for the primary streaming events:
 *      assistant_text_delta, message_complete, tool_use_start, tool_result, etc.
 *
 * Both paths must publish to the hub.
 *
 * Tests:
 *   - confirmation_request (updateClient path) → hub emits one AssistantEvent
 *   - assistant_text_delta + message_complete (onEvent path) → hub emits in order
 *   - sessionId falls back to conversationId when the message lacks it
 */
import { afterAll, describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
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

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { createConversation } from '../memory/conversation-store.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';

initializeDb();

afterAll(() => {
  resetDb();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a session that calls the updateClient handler with the given messages
 * (simulates prompter / confirmation path).
 */
function makeSessionEmittingViaClient(...messages: ServerMessage[]): Session {
  let clientHandler: (msg: ServerMessage) => void = () => {};
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
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

/**
 * Build a session that calls the onEvent callback with the given messages
 * (simulates the primary agent-loop streaming path).
 */
function makeSessionEmittingViaAgentLoop(...messages: ServerMessage[]): Session {
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    updateClient: () => {},
    runAgentLoop: async (_content: string, _messageId: string, onEvent: (msg: ServerMessage) => void) => {
      for (const msg of messages) {
        onEvent(msg);
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

  test('confirmation_request (updateClient path) emits one AssistantEvent', async () => {
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
    const session = makeSessionEmittingViaClient(confirmationMsg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'self' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Do something');
    // Wait for the async hub chain to flush.
    await new Promise((r) => setTimeout(r, 20));

    sub.dispose();

    expect(received).toHaveLength(1);
    expect(received[0].assistantId).toBe('self');
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

  test('assistant_text_delta and message_complete (onEvent path) emit in order', async () => {
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
    const session = makeSessionEmittingViaAgentLoop(deltaMsg, completeMsg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'self' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'Hello');
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

  test('sessionId falls back to conversationId when message lacks it (onEvent path)', async () => {
    const conversation = createConversation('http-session-fallback-test');
    // pong has no sessionId field
    const msg: ServerMessage = { type: 'pong' };
    const session = makeSessionEmittingViaAgentLoop(msg);

    const received: AssistantEvent[] = [];
    const sub = assistantEventHub.subscribe(
      { assistantId: 'self' },
      (e) => { received.push(e); },
    );

    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => session,
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });

    await orchestrator.startRun(conversation.id, 'ping');
    await new Promise((r) => setTimeout(r, 20));

    sub.dispose();

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe(conversation.id);
  });
});
