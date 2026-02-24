/**
 * Tests for busy behavior on POST /v1/runs — verifies that a second send
 * attempt on a busy session queues the message instead of rejecting.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Session / processor helpers ─────────────────────────────────────────────

function makeHangingSession(): Session {
  let processing = false;
  const queuedMessages: Array<{ onEvent: (msg: unknown) => void }> = [];
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      await new Promise<void>(() => {}); // hangs forever
    },
    enqueueMessage: (_content: string, _attachments: unknown[], onEvent: (msg: unknown) => void) => {
      if (!processing) return { queued: false, requestId: 'req-1' };
      queuedMessages.push({ onEvent });
      return { queued: true, requestId: 'req-1' };
    },
    getQueueDepth: () => queuedMessages.length,
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
  } as unknown as Session;
}

function makeCompletingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: { scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      await new Promise((r) => setTimeout(r, 20));
      processing = false;
    },
    enqueueMessage: () => ({ queued: false, requestId: 'req-1' }),
    getQueueDepth: () => 0,
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
  } as unknown as Session;
}

// ── Test infrastructure ─────────────────────────────────────────────────────

const TEST_TOKEN = 'test-bearer-send-busy';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

function cleanDb() {
  const db = getDb();
  db.run('DELETE FROM message_runs');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  db.run('DELETE FROM conversation_keys');
}

describe('send endpoint busy behavior — POST /v1/runs', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(cleanDb);

  async function startServer(sessionFactory: () => Session) {
    port = 19000 + Math.floor(Math.random() * 1000);
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => sessionFactory(),
      resolveAttachments: () => [],
      deriveDefaultStrictSideEffects: () => false,
    });
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN, runOrchestrator: orchestrator });
    await server.start();
  }

  async function stopServer() {
    await server?.stop();
  }

  function runsUrl() {
    return `http://127.0.0.1:${port}/v1/runs`;
  }

  test('returns 201 with queued status when session is busy', async () => {
    const session = makeHangingSession();
    await startServer(() => session);

    // First run starts and hangs
    const res1 = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ conversationKey: 'conv-busy-run', content: 'First', sourceChannel: 'macos' }),
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json() as { status: string };
    expect(body1.status).toBe('running');

    await new Promise((r) => setTimeout(r, 30));

    // Second run should be queued (not rejected)
    const res2 = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ conversationKey: 'conv-busy-run', content: 'Second', sourceChannel: 'macos' }),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json() as { id: string; status: string };
    expect(body2.status).toBe('queued');
    expect(body2.id).toBeDefined();

    await stopServer();
  });

  test('returns 201 when session is not busy', async () => {
    await startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ conversationKey: 'conv-ok-run', content: 'Hello', sourceChannel: 'macos' }),
    });
    expect(res.status).toBe(201);

    await stopServer();
  });
});

