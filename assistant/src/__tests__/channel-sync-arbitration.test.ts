/**
 * Tests for runtime owner arbitration and move-sync for Telegram channel sync.
 *
 * Verifies:
 * - Owner send succeeds without conflict
 * - Non-owner send returns conflict with ownerConversationId
 * - Send without senderConversationId skips check (backward compatible)
 * - Move-sync rebinds ownership atomically
 * - Inbound after move routes to new owner
 * - Hide (delete) then recreate works correctly
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'channel-sync-arb-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  getHttpTokenPath: () => join(testDir, 'http-token'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
  readHttpToken: () => 'test-bearer-token',
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
  loadConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
  invalidateConfigCache: () => {},
}));

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (key: string) => {
    if (key === 'credential:telegram:bot_token') return 'test-bot-token';
    if (key === 'credential:telegram:webhook_secret') return 'test-secret';
    return undefined;
  },
}));

mock.module('../messaging/providers/telegram-bot/client.js', () => ({
  sendMessage: async () => ({ ok: true }),
  getMe: async () => ({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } }),
}));

import { initializeDb } from '../memory/db.js';
import { v4 as uuid } from 'uuid';
import { getDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import * as externalConversationStore from '../memory/external-conversation-store.js';
import { getOrCreateConversation, deleteConversationKey, getConversationByKey } from '../memory/conversation-key-store.js';
import { telegramBotMessagingProvider } from '../messaging/providers/telegram-bot/adapter.js';
import { handleMoveSync, handleDeleteConversation } from '../runtime/routes/channel-routes.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';

initializeDb();

// ── Helpers ────────────────────────────────────────────────────────────

const ensuredConvIds = new Set<string>();

function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Test: ${id}`,
      createdAt: now,
      updatedAt: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    })
    .onConflictDoNothing()
    .run();
  ensuredConvIds.add(id);
}

function createBinding(conversationId: string, sourceChannel: string, externalChatId: string): void {
  ensureConversation(conversationId);
  externalConversationStore.upsertOutboundBinding({
    conversationId,
    sourceChannel,
    externalChatId,
  });
}

function makeJsonRequest(body: unknown): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: unknown): Request {
  return new Request('http://localhost/test', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('channel sync arbitration', () => {
  const chatId = '12345';

  describe('owner send', () => {
    test('succeeds without conflict when sender is the owner', async () => {
      const convA = uuid();
      createBinding(convA, 'telegram', chatId);

      const result = await telegramBotMessagingProvider.sendMessage(
        '',
        chatId,
        'Hello from owner',
        { senderConversationId: convA },
      );

      expect(result.conflict).toBeUndefined();
      expect(result.conversationId).toBe(chatId);
    });
  });

  describe('non-owner send', () => {
    test('returns conflict with ownerConversationId', async () => {
      const convA = uuid();
      const convB = uuid();
      const uniqueChatId = `non-owner-${uuid()}`;
      createBinding(convA, 'telegram', uniqueChatId);
      ensureConversation(convB);

      const result = await telegramBotMessagingProvider.sendMessage(
        '',
        uniqueChatId,
        'Hello from non-owner',
        { senderConversationId: convB },
      );

      expect(result.conflict).toBeDefined();
      expect(result.conflict!.ownerConversationId).toBe(convA);
      expect(result.id).toBe('');
    });
  });

  describe('backward compatibility', () => {
    test('send without senderConversationId skips check', async () => {
      const convA = uuid();
      const uniqueChatId = `compat-${uuid()}`;
      createBinding(convA, 'telegram', uniqueChatId);

      const result = await telegramBotMessagingProvider.sendMessage(
        '',
        uniqueChatId,
        'Hello without sender ID',
      );

      expect(result.conflict).toBeUndefined();
      expect(result.conversationId).toBe(uniqueChatId);
    });
  });

  describe('move-sync', () => {
    test('rebinds ownership and returns previousOwner', async () => {
      const convA = uuid();
      const convB = uuid();
      const uniqueChatId = `move-${uuid()}`;
      createBinding(convA, 'telegram', uniqueChatId);
      ensureConversation(convB);

      // Also create the conversation key mapping
      const conversationKey = `telegram:${uniqueChatId}`;
      getOrCreateConversation(conversationKey);

      const req = makeJsonRequest({
        sourceChannel: 'telegram',
        externalChatId: uniqueChatId,
        newConversationId: convB,
      });

      const resp = await handleMoveSync(req);
      const body = await resp.json() as { ok: boolean; previousOwner: string | null };

      expect(resp.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.previousOwner).toBe(convA);

      // Verify binding now points to conv-B
      const binding = externalConversationStore.getBindingByChannelChat('telegram', uniqueChatId);
      expect(binding).not.toBeNull();
      expect(binding!.conversationId).toBe(convB);

      // Verify conversation key now points to conv-B
      const keyMapping = getConversationByKey(conversationKey);
      expect(keyMapping).not.toBeNull();
      expect(keyMapping!.conversationId).toBe(convB);
    });
  });

  describe('inbound after move', () => {
    test('routes to new owner after move-sync', async () => {
      const convA = uuid();
      const convB = uuid();
      const uniqueChatId = `inbound-move-${uuid()}`;
      createBinding(convA, 'telegram', uniqueChatId);
      ensureConversation(convB);

      // Create initial conversation key mapping
      const conversationKey = `telegram:${uniqueChatId}`;
      getOrCreateConversation(conversationKey);

      // Move to conv-B
      const moveReq = makeJsonRequest({
        sourceChannel: 'telegram',
        externalChatId: uniqueChatId,
        newConversationId: convB,
      });
      await handleMoveSync(moveReq);

      // Simulate a new inbound — recordInbound uses getOrCreateConversation
      // which should find the key mapping pointing to conv-B now
      const result = channelDeliveryStore.recordInbound(
        'telegram',
        uniqueChatId,
        `msg-${uuid()}`,
      );

      expect(result.conversationId).toBe(convB);
    });
  });

  describe('hide then recreate', () => {
    test('delete binding then new inbound creates fresh conversation', async () => {
      const convA = uuid();
      const uniqueChatId = `hide-${uuid()}`;
      createBinding(convA, 'telegram', uniqueChatId);

      // Create conversation key mapping for the binding
      const conversationKey = `telegram:${uniqueChatId}`;
      getOrCreateConversation(conversationKey);

      // Delete the binding (simulating hide)
      const deleteReq = makeDeleteRequest({
        sourceChannel: 'telegram',
        externalChatId: uniqueChatId,
      });
      const deleteResp = await handleDeleteConversation(deleteReq);
      expect(deleteResp.status).toBe(200);

      // Verify old binding is gone
      const bindingAfterDelete = externalConversationStore.getBindingByChannelChat('telegram', uniqueChatId);
      expect(bindingAfterDelete).toBeNull();

      // Verify old conversation key is gone
      const keyAfterDelete = getConversationByKey(conversationKey);
      expect(keyAfterDelete).toBeNull();

      // New inbound should create a fresh conversation
      const result = channelDeliveryStore.recordInbound(
        'telegram',
        uniqueChatId,
        `msg-${uuid()}`,
      );

      // The new conversation should be different from the old one
      expect(result.conversationId).not.toBe(convA);
      expect(result.accepted).toBe(true);
      expect(result.duplicate).toBe(false);
    });
  });

  describe('move-sync validation', () => {
    test('returns 400 when sourceChannel is missing', async () => {
      const req = makeJsonRequest({
        externalChatId: '12345',
        newConversationId: 'conv-1',
      });
      const resp = await handleMoveSync(req);
      expect(resp.status).toBe(400);
    });

    test('returns 400 when externalChatId is missing', async () => {
      const req = makeJsonRequest({
        sourceChannel: 'telegram',
        newConversationId: 'conv-1',
      });
      const resp = await handleMoveSync(req);
      expect(resp.status).toBe(400);
    });

    test('returns 400 when newConversationId is missing', async () => {
      const req = makeJsonRequest({
        sourceChannel: 'telegram',
        externalChatId: '12345',
      });
      const resp = await handleMoveSync(req);
      expect(resp.status).toBe(400);
    });
  });

  describe('move-sync upsert', () => {
    test('updates binding fields when newConversationId already has an existing binding', async () => {
      const convA = uuid();
      const convB = uuid();
      const uniqueChatIdA = `upsert-a-${uuid()}`;
      const uniqueChatIdB = `upsert-b-${uuid()}`;

      // conv-A owns chat-A, conv-B owns chat-B
      createBinding(convA, 'telegram', uniqueChatIdA);
      createBinding(convB, 'telegram', uniqueChatIdB);

      // Create conversation key mappings
      getOrCreateConversation(`telegram:${uniqueChatIdA}`);
      getOrCreateConversation(`telegram:${uniqueChatIdB}`);

      // Move chat-A to conv-B (which already has a binding for chat-B)
      const req = makeJsonRequest({
        sourceChannel: 'telegram',
        externalChatId: uniqueChatIdA,
        newConversationId: convB,
      });

      const resp = await handleMoveSync(req);
      const body = await resp.json() as { ok: boolean; previousOwner: string | null };

      expect(resp.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.previousOwner).toBe(convA);

      // conv-B's binding should now point to chat-A (sourceChannel/externalChatId updated)
      const binding = externalConversationStore.getBindingByConversation(convB);
      expect(binding).not.toBeNull();
      expect(binding!.sourceChannel).toBe('telegram');
      expect(binding!.externalChatId).toBe(uniqueChatIdA);

      // Conversation key for chat-A should resolve to conv-B
      const keyMapping = getConversationByKey(`telegram:${uniqueChatIdA}`);
      expect(keyMapping).not.toBeNull();
      expect(keyMapping!.conversationId).toBe(convB);
    });
  });
});
