import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-attach-meta-test-')));

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
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

import { initializeDb, getDb } from '../memory/db.js';
import * as conversationStore from '../memory/conversation-store.js';
import { getOrCreateConversation } from '../memory/conversation-key-store.js';
import {
  uploadAttachment,
  linkAttachmentToMessage,
} from '../memory/attachments-store.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';

initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

const TEST_TOKEN = 'test-bearer-token-attach';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe('Runtime attachment metadata', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(async () => {
    const db = getDb();
    db.run('DELETE FROM message_attachments');
    db.run('DELETE FROM attachments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM conversation_keys');

    // Use a random port to avoid conflicts
    port = 17000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test('GET /messages includes attachment metadata for assistant messages', async () => {
    const conversationKey = 'test-conv-1';

    // Set up conversation and messages using "self" as the assistantId
    const mapping = getOrCreateConversation(conversationKey);
    conversationStore.addMessage(mapping.conversationId, 'user', 'Hello');
    const assistantMsg = conversationStore.addMessage(
      mapping.conversationId,
      'assistant',
      JSON.stringify([{ type: 'text', text: 'Here is a chart' }]),
    );

    // Upload and link an attachment using "self" as the assistantId
    const stored = uploadAttachment('chart.png', 'image/png', 'iVBOR');
    linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/messages?conversationKey=${conversationKey}`,
      { headers: AUTH_HEADERS },
    );
    const body = await res.json() as { messages: Array<{ role: string; content: string; attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; kind: string }> }> };

    expect(res.status).toBe(200);

    // Find the assistant message
    const aMsg = body.messages.find((m) => m.role === 'assistant');
    expect(aMsg).toBeDefined();
    expect(aMsg!.attachments).toHaveLength(1);
    expect(aMsg!.attachments[0].id).toBe(stored.id);
    expect(aMsg!.attachments[0].filename).toBe('chart.png');
    expect(aMsg!.attachments[0].mimeType).toBe('image/png');
    expect(aMsg!.attachments[0].kind).toBe('image');
    expect(aMsg!.attachments[0].sizeBytes).toBeGreaterThan(0);

    // User message should have empty attachments
    const uMsg = body.messages.find((m) => m.role === 'user');
    expect(uMsg).toBeDefined();
    expect(uMsg!.attachments).toEqual([]);
  });

  test('GET /messages returns empty attachments when none linked', async () => {
    const conversationKey = 'test-conv-2';

    const mapping = getOrCreateConversation(conversationKey);
    conversationStore.addMessage(mapping.conversationId, 'user', 'Hello');
    conversationStore.addMessage(
      mapping.conversationId,
      'assistant',
      JSON.stringify([{ type: 'text', text: 'No attachments here' }]),
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/messages?conversationKey=${conversationKey}`,
      { headers: AUTH_HEADERS },
    );
    const body = await res.json() as { messages: Array<{ role: string; attachments: unknown[] }> };

    expect(res.status).toBe(200);
    const aMsg = body.messages.find((m) => m.role === 'assistant');
    expect(aMsg).toBeDefined();
    expect(aMsg!.attachments).toEqual([]);
  });

  test('GET /attachments/:id returns attachment with payload', async () => {
    const stored = uploadAttachment('report.pdf', 'application/pdf', 'JVBER');

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}`,
      { headers: AUTH_HEADERS },
    );
    const body = await res.json() as {
      id: string; filename: string; mimeType: string; sizeBytes: number; kind: string; data: string;
    };

    expect(res.status).toBe(200);
    expect(body.id).toBe(stored.id);
    expect(body.filename).toBe('report.pdf');
    expect(body.mimeType).toBe('application/pdf');
    expect(body.kind).toBe('document');
    expect(body.data).toBe('JVBER');
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  test('GET /attachments/:id returns attachment stored under "self"', async () => {
    const stored = uploadAttachment('shared.txt', 'text/plain', 'c2hhcmVk');

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/${stored.id}`,
      { headers: AUTH_HEADERS },
    );
    const body = await res.json() as { id: string; filename: string };

    expect(res.status).toBe(200);
    expect(body.id).toBe(stored.id);
    expect(body.filename).toBe('shared.txt');
  });

  test('GET /attachments/:id returns 404 for nonexistent attachment', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/attachments/nonexistent-id`,
      { headers: AUTH_HEADERS },
    );
    const body = await res.json() as { error: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe('Attachment not found');
  });
});
