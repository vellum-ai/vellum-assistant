import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-conv-lifecycle-test-')));

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
  getRootDir: () => testDir,
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
  }),
}));

import * as conversationStore from '../memory/conversation-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

const TEST_TOKEN = 'test-bearer-token-conversation-lifecycle';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe('Conversation lifecycle HTTP routes', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(async () => {
    conversationStore.clearAll();
    const db = getDb();
    db.run('DELETE FROM conversation_keys');
    db.run('DELETE FROM external_conversation_bindings');

    port = 17500 + Math.floor(Math.random() * 500);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test('supports archive, unarchive, and hard delete for conversations', async () => {
    const conversation = conversationStore.createConversation({ title: 'Delete Me' });
    await conversationStore.addMessage(conversation.id, 'user', 'hello');

    const archiveRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${encodeURIComponent(conversation.id)}/archive`,
      { method: 'POST', headers: AUTH_HEADERS },
    );
    const archiveBody = await archiveRes.json() as { ok: boolean; isArchived: boolean; archivedAt?: number };
    expect(archiveRes.status).toBe(200);
    expect(archiveBody.ok).toBe(true);
    expect(archiveBody.isArchived).toBe(true);
    expect(typeof archiveBody.archivedAt).toBe('number');

    const activeListRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations`,
      { headers: AUTH_HEADERS },
    );
    const activeListBody = await activeListRes.json() as { sessions: Array<{ id: string }> };
    expect(activeListRes.status).toBe(200);
    expect(activeListBody.sessions.some((s) => s.id === conversation.id)).toBe(false);

    const allListRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations?includeArchived=true`,
      { headers: AUTH_HEADERS },
    );
    const allListBody = await allListRes.json() as {
      sessions: Array<{ id: string; isArchived?: boolean; archivedAt?: number }>;
    };
    const archivedSession = allListBody.sessions.find((s) => s.id === conversation.id);
    expect(allListRes.status).toBe(200);
    expect(archivedSession).toBeDefined();
    expect(archivedSession?.isArchived).toBe(true);
    expect(typeof archivedSession?.archivedAt).toBe('number');

    const unarchiveRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${encodeURIComponent(conversation.id)}/unarchive`,
      { method: 'POST', headers: AUTH_HEADERS },
    );
    const unarchiveBody = await unarchiveRes.json() as { ok: boolean; isArchived: boolean };
    expect(unarchiveRes.status).toBe(200);
    expect(unarchiveBody.ok).toBe(true);
    expect(unarchiveBody.isArchived).toBe(false);

    const activeAgainRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations`,
      { headers: AUTH_HEADERS },
    );
    const activeAgainBody = await activeAgainRes.json() as { sessions: Array<{ id: string; isArchived?: boolean }> };
    const activeSession = activeAgainBody.sessions.find((s) => s.id === conversation.id);
    expect(activeAgainRes.status).toBe(200);
    expect(activeSession).toBeDefined();
    expect(activeSession?.isArchived).toBe(false);

    const deleteRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${encodeURIComponent(conversation.id)}`,
      { method: 'DELETE', headers: AUTH_HEADERS },
    );
    const deleteBody = await deleteRes.json() as { ok: boolean; deleted: boolean };
    expect(deleteRes.status).toBe(200);
    expect(deleteBody.ok).toBe(true);
    expect(deleteBody.deleted).toBe(true);

    expect(conversationStore.getConversation(conversation.id)).toBeNull();
    expect(conversationStore.getMessages(conversation.id)).toEqual([]);
  });

  test('returns 404 for lifecycle operations when conversation does not exist', async () => {
    const missingId = 'conv-missing-id';

    const archiveRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${missingId}/archive`,
      { method: 'POST', headers: AUTH_HEADERS },
    );
    expect(archiveRes.status).toBe(404);

    const unarchiveRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${missingId}/unarchive`,
      { method: 'POST', headers: AUTH_HEADERS },
    );
    expect(unarchiveRes.status).toBe(404);

    const deleteRes = await fetch(
      `http://127.0.0.1:${port}/v1/conversations/${missingId}`,
      { method: 'DELETE', headers: AUTH_HEADERS },
    );
    expect(deleteRes.status).toBe(404);
  });
});

