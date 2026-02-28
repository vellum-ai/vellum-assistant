import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'channel-retry-sweep-test-'));

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
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { channelInboundEvents, messages } from '../memory/schema.js';
import { sweepFailedEvents } from '../runtime/channel-retry-sweep.js';

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // Best effort cleanup
  }
});

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_inbound_events');
  db.run('DELETE FROM conversation_keys');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

function seedFailedLegacyEvent(actorRole: 'guardian' | 'non-guardian' | 'unverified_channel'): string {
  const inbound = channelDeliveryStore.recordInbound('telegram', 'chat-legacy', `msg-${actorRole}`);
  channelDeliveryStore.storePayload(inbound.eventId, {
    content: 'retry me',
    sourceChannel: 'telegram',
    interface: 'telegram',
    guardianCtx: {
      actorRole,
      sourceChannel: 'telegram',
      requesterExternalUserId: 'legacy-user',
      requesterChatId: 'chat-legacy',
    },
  });

  const db = getDb();
  db.update(channelInboundEvents)
    .set({
      processingStatus: 'failed',
      processingAttempts: 1,
      retryAfter: Date.now() - 1,
    })
    .where(eq(channelInboundEvents.id, inbound.eventId))
    .run();

  return inbound.eventId;
}

describe('channel-retry-sweep', () => {
  beforeEach(() => {
    resetTables();
  });

  test('replays legacy guardianCtx.actorRole with preserved trust semantics', async () => {
    const cases: Array<{
      actorRole: 'guardian' | 'non-guardian' | 'unverified_channel';
      expectedTrustClass: 'guardian' | 'trusted_contact' | 'unknown';
      expectedInteractive: boolean;
    }> = [
      { actorRole: 'guardian', expectedTrustClass: 'guardian', expectedInteractive: true },
      { actorRole: 'non-guardian', expectedTrustClass: 'trusted_contact', expectedInteractive: false },
      { actorRole: 'unverified_channel', expectedTrustClass: 'unknown', expectedInteractive: false },
    ];

    for (const c of cases) {
      const eventId = seedFailedLegacyEvent(c.actorRole);
      let capturedOptions: {
        guardianContext?: { trustClass?: string };
        isInteractive?: boolean;
      } | undefined;

      await sweepFailedEvents(
        async (conversationId, _content, _attachmentIds, options) => {
          capturedOptions = options as {
            guardianContext?: { trustClass?: string };
            isInteractive?: boolean;
          };
          const messageId = `message-${c.actorRole}`;
          const db = getDb();
          db.insert(messages).values({
            id: messageId,
            conversationId,
            role: 'user',
            content: JSON.stringify([{ type: 'text', text: 'retry me' }]),
            createdAt: Date.now(),
          }).run();
          return { messageId };
        },
        undefined,
      );

      expect(capturedOptions?.guardianContext?.trustClass).toBe(c.expectedTrustClass);
      expect(capturedOptions?.isInteractive).toBe(c.expectedInteractive);

      const db = getDb();
      const row = db.select().from(channelInboundEvents).where(eq(channelInboundEvents.id, eventId)).get();
      expect(row?.processingStatus).toBe('processed');
    }
  });
});
