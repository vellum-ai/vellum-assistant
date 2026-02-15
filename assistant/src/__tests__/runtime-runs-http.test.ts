/**
 * HTTP-layer integration tests for the run API endpoints.
 *
 * Tests POST /runs, GET /runs/:id, and POST /runs/:id/decision
 * through RuntimeHttpServer with a real RunOrchestrator instance.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-runs-http-test-')));

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
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';

initializeDb();

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function makeCompletingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      await new Promise((r) => setTimeout(r, 20));
      processing = false;
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

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

function makeHangingSession(): Session {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: () => undefined as unknown as string,
    setAssistantId: () => {},
    updateClient: () => {},
    runAgentLoop: async () => {
      processing = true;
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: () => {},
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ASSISTANT_ID = 'ast-run-http';

describe('runtime runs — HTTP layer', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_runs');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM conversation_keys');
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function startServer(sessionFactory: () => Session): { orchestrator: RunOrchestrator } {
    port = 18000 + Math.floor(Math.random() * 1000);
    const orchestrator = new RunOrchestrator({
      getOrCreateSession: async () => sessionFactory(),
      resolveAttachments: () => [],
    });
    server = new RuntimeHttpServer({ port, runOrchestrator: orchestrator });
    server.start();
    return { orchestrator };
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function runsUrl(path = ''): string {
    return `http://localhost:${port}/v1/assistants/${ASSISTANT_ID}/runs${path}`;
  }

  // ── POST /runs ──────────────────────────────────────────────────────

  test('POST /runs creates a run and returns 201', async () => {
    startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-1', content: 'Hello' }),
    });
    const body = await res.json() as { id: string; status: string; messageId: string; createdAt: string };

    expect(res.status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.status).toBe('running');
    expect(body.messageId).toBeNull();
    expect(body.createdAt).toBeDefined();

    await stopServer();
  });

  test('POST /runs returns 400 when conversationKey missing', async () => {
    startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('conversationKey');

    await stopServer();
  });

  test('POST /runs returns 400 when content is empty', async () => {
    startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-2', content: '' }),
    });

    expect(res.status).toBe(400);

    await stopServer();
  });

  test('POST /runs returns 409 when session busy', async () => {
    const session = makeHangingSession();
    startServer(() => session);

    // First run starts and hangs
    const res1 = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-busy', content: 'First' }),
    });
    expect(res1.status).toBe(201);

    await new Promise((r) => setTimeout(r, 30));

    // Second run should be rejected
    const res2 = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-busy', content: 'Second' }),
    });
    expect(res2.status).toBe(409);

    await stopServer();
  });

  // ── GET /runs/:id ───────────────────────────────────────────────────

  test('GET /runs/:id returns run status', async () => {
    startServer(() => makeCompletingSession());

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-get', content: 'Test' }),
    });
    const { id } = await createRes.json() as { id: string };

    const getRes = await fetch(runsUrl(`/${id}`));
    const body = await getRes.json() as { id: string; status: string; messageId: string };

    expect(getRes.status).toBe(200);
    expect(body.id).toBe(id);
    expect(body.status).toBe('running');

    await stopServer();
  });

  test('GET /runs/:id returns completed after agent loop finishes', async () => {
    startServer(() => makeCompletingSession());

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-done', content: 'Build it' }),
    });
    const { id } = await createRes.json() as { id: string };

    await new Promise((r) => setTimeout(r, 100));

    const getRes = await fetch(runsUrl(`/${id}`));
    const body = await getRes.json() as { id: string; status: string };

    expect(getRes.status).toBe(200);
    expect(body.status).toBe('completed');

    await stopServer();
  });

  test('GET /runs/:id returns failed with error', async () => {
    startServer(() => makeFailingSession('Backend error'));

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-fail', content: 'Do it' }),
    });
    const { id } = await createRes.json() as { id: string };

    await new Promise((r) => setTimeout(r, 50));

    const getRes = await fetch(runsUrl(`/${id}`));
    const body = await getRes.json() as { id: string; status: string; error: string };

    expect(getRes.status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.error).toBe('Backend error');

    await stopServer();
  });

  test('GET /runs/:id returns 404 for unknown run', async () => {
    startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl('/nonexistent'));
    expect(res.status).toBe(404);

    await stopServer();
  });

  test('GET /runs/:id returns 404 for different assistant', async () => {
    startServer(() => makeCompletingSession());

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-scope', content: 'Test' }),
    });
    const { id } = await createRes.json() as { id: string };

    // Try to access via a different assistant
    const res = await fetch(`http://localhost:${port}/v1/assistants/other-assistant/runs/${id}`);
    expect(res.status).toBe(404);

    await stopServer();
  });

  // ── POST /runs/:id/decision ─────────────────────────────────────────

  test('POST /runs/:id/decision returns accepted for pending confirmation', async () => {
    startServer(() => makeConfirmationSession('swarm_delegate'));

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-decide', content: 'Approve' }),
    });
    const { id } = await createRes.json() as { id: string };

    await new Promise((r) => setTimeout(r, 50));

    // Verify pending state via GET
    const getRes = await fetch(runsUrl(`/${id}`));
    const runBody = await getRes.json() as { status: string; pendingConfirmation: { toolName: string } };
    expect(runBody.status).toBe('needs_confirmation');
    expect(runBody.pendingConfirmation.toolName).toBe('swarm_delegate');

    // Submit decision
    const decisionRes = await fetch(runsUrl(`/${id}/decision`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    const decisionBody = await decisionRes.json() as { accepted: boolean };

    expect(decisionRes.status).toBe(200);
    expect(decisionBody.accepted).toBe(true);

    await stopServer();
  });

  test('POST /runs/:id/decision returns 400 for invalid decision', async () => {
    startServer(() => makeHangingSession());

    const createRes = await fetch(runsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey: 'conv-bad-dec', content: 'Test' }),
    });
    const { id } = await createRes.json() as { id: string };

    const res = await fetch(runsUrl(`/${id}/decision`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });

    expect(res.status).toBe(400);

    await stopServer();
  });

  test('POST /runs/:id/decision returns 404 for unknown run', async () => {
    startServer(() => makeCompletingSession());

    const res = await fetch(runsUrl('/nonexistent/decision'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });

    expect(res.status).toBe(404);

    await stopServer();
  });
});
