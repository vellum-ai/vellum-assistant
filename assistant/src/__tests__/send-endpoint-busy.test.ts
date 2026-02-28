/**
 * Tests for POST /v1/messages queue-if-busy behavior and hub publishing.
 *
 * Validates that:
 * - Messages are accepted (202) when the session is idle, with hub events published.
 * - Messages are queued (202, queued: true) when the session is busy, not 409.
 * - SSE subscribers receive events from messages sent via this endpoint.
 */
import { mkdtempSync, realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock,test } from 'bun:test';

import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'send-endpoint-busy-test-')));

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
    ui: {},
    
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import type { AssistantEvent } from '../runtime/assistant-event.js';
import { AssistantEventHub } from '../runtime/assistant-event-hub.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';

initializeDb();

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Session that completes its agent loop quickly and emits a text delta + message_complete. */
function makeCompletingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: (_content: string, _attachments: unknown[], requestId?: string) => {
      processing = true;
      return requestId ?? 'msg-1';
    },
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    updateClient: () => {},
    enqueueMessage: () => ({ queued: false, requestId: 'noop' }),
    runAgentLoop: async (_content: string, _messageId: string, onEvent: (msg: ServerMessage) => void) => {
      onEvent({ type: 'assistant_text_delta', text: 'Hello!' });
      onEvent({ type: 'message_complete', sessionId: 'test-session' });
      processing = false;
    },
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
  } as unknown as Session;
}

/** Session that hangs forever in the agent loop (simulates a busy session). */
function makeHangingSession(): Session {
  let processing = false;
  const enqueuedMessages: Array<{ content: string; onEvent: (msg: ServerMessage) => void; requestId: string }> = [];
  return {
    isProcessing: () => processing,
    persistUserMessage: (_content: string, _attachments: unknown[], requestId?: string) => {
      processing = true;
      return requestId ?? 'msg-1';
    },
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    updateClient: () => {},
    enqueueMessage: (content: string, _attachments: unknown[], onEvent: (msg: ServerMessage) => void, requestId: string) => {
      enqueuedMessages.push({ content, onEvent, requestId });
      return { queued: true, requestId };
    },
    runAgentLoop: async () => {
      // Hang forever
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    _enqueuedMessages: enqueuedMessages,
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bearer-token-send';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe('POST /v1/messages — queue-if-busy and hub publishing', () => {
  let server: RuntimeHttpServer;
  let port: number;
  let eventHub: AssistantEventHub;

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM conversation_keys');
    eventHub = new AssistantEventHub();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function startServer(sessionFactory: () => Session): Promise<void> {
    port = 19000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({
      port,
      bearerToken: TEST_TOKEN,
      sendMessageDeps: {
        getOrCreateSession: async () => sessionFactory(),
        assistantEventHub: eventHub,
        resolveAttachments: () => [],
      },
    });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function messagesUrl(): string {
    return `http://127.0.0.1:${port}/v1/messages`;
  }

  // ── Idle session: immediate processing ──────────────────────────────

  test('returns 202 with accepted: true and messageId when session is idle', async () => {
    await startServer(() => makeCompletingSession());

    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: 'conv-idle',
        content: 'Hello',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    const body = await res.json() as { accepted: boolean; messageId: string };

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBeDefined();

    await stopServer();
  });

  test('publishes events to assistantEventHub when session is idle', async () => {
    const publishedEvents: AssistantEvent[] = [];

    await startServer(() => makeCompletingSession());

    eventHub.subscribe(
      { assistantId: 'self' },
      (event) => { publishedEvents.push(event); },
    );

    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: 'conv-hub',
        content: 'Hello hub',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    expect(res.status).toBe(202);

    // Wait for the async agent loop to complete and events to be published
    await new Promise((r) => setTimeout(r, 100));

    // Should have received assistant_text_delta and message_complete
    const types = publishedEvents.map((e) => e.message.type);
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('message_complete');

    await stopServer();
  });

  // ── Busy session: queue-if-busy ─────────────────────────────────────

  test('returns 202 with queued: true when session is busy (not 409)', async () => {
    const session = makeHangingSession();
    await startServer(() => session);

    // First message starts the agent loop and makes the session busy
    const res1 = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: 'conv-busy',
        content: 'First',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    expect(res1.status).toBe(202);
    const body1 = await res1.json() as { accepted: boolean; messageId: string };
    expect(body1.accepted).toBe(true);
    expect(body1.messageId).toBeDefined();

    // Wait for the agent loop to start
    await new Promise((r) => setTimeout(r, 30));

    // Second message should be queued, not rejected
    const res2 = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: 'conv-busy',
        content: 'Second',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    const body2 = await res2.json() as { accepted: boolean; queued: boolean };

    expect(res2.status).toBe(202);
    expect(body2.accepted).toBe(true);
    expect(body2.queued).toBe(true);

    await stopServer();
  });

  // ── Validation ──────────────────────────────────────────────────────

  test('returns 400 when sourceChannel is missing', async () => {
    await startServer(() => makeCompletingSession());

    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ conversationKey: 'conv-val', content: 'Hello' }),
    });
    expect(res.status).toBe(400);

    await stopServer();
  });

  test('returns 400 when content is empty', async () => {
    await startServer(() => makeCompletingSession());

    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        conversationKey: 'conv-empty',
        content: '',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    expect(res.status).toBe(400);

    await stopServer();
  });

  test('returns 400 when conversationKey is missing', async () => {
    await startServer(() => makeCompletingSession());

    const res = await fetch(messagesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        content: 'Hello',
        sourceChannel: 'vellum',
        interface: 'macos',
      }),
    });
    expect(res.status).toBe(400);

    await stopServer();
  });
});
