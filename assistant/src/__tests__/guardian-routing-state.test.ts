import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'guardian-routing-state-test-'));

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

// Mock security check to always pass
mock.module('../security/secret-ingress.js', () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// Mock ingress member store with a configurable member lookup.
// By default returns an active member so ACL passes.
let mockFindMember: (() => unknown) | null = null;
mock.module('../memory/ingress-member-store.js', () => ({
  findMember: (..._args: unknown[]) => {
    if (mockFindMember) return mockFindMember();
    return {
      id: 'member-test-default',
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'telegram-user-default',
      externalChatId: null,
      displayName: null,
      username: null,
      status: 'active',
      policy: 'allow',
      inviteId: null,
      createdBySessionId: null,
      revokedReason: null,
      blockedReason: null,
      lastSeenAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
  updateLastSeen: () => {},
  upsertMember: () => {},
}));

import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import { createBinding } from '../memory/channel-guardian-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { channelInboundEvents, messages } from '../memory/schema.js';
import { sweepFailedEvents } from '../runtime/channel-retry-sweep.js';
import {
  type GuardianContext,
  resolveRoutingState,
  resolveRoutingStateFromRuntime,
} from '../runtime/guardian-context-resolver.js';
import { handleChannelInbound } from '../runtime/routes/channel-routes.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_inbound_events');
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_guardian_approval_requests');
  db.run('DELETE FROM canonical_guardian_requests');
  db.run('DELETE FROM conversation_keys');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  db.run('DELETE FROM assistant_ingress_members');
  db.run('DELETE FROM external_conversation_bindings');
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests: resolveRoutingState
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveRoutingState', () => {
  test('guardian actors are always interactive and route-resolvable', () => {
    const ctx: GuardianContext = {
      trustClass: 'guardian',
      guardianExternalUserId: 'guardian-123',
      guardianChatId: 'chat-123',
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: true,
      promptWaitingAllowed: true,
    });
  });

  test('guardian actors are interactive even without guardianExternalUserId', () => {
    // Edge case: guardian is chatting in their own chat, no separate binding needed
    const ctx: GuardianContext = {
      trustClass: 'guardian',
    };
    const state = resolveRoutingState(ctx);
    expect(state.canBeInteractive).toBe(true);
    expect(state.promptWaitingAllowed).toBe(true);
  });

  test('trusted contact with resolvable guardian route is interactive', () => {
    const ctx: GuardianContext = {
      trustClass: 'trusted_contact',
      guardianExternalUserId: 'guardian-456',
      guardianChatId: 'guardian-chat-456',
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: true,
      promptWaitingAllowed: true,
    });
  });

  test('trusted contact without guardian route is NOT interactive (fail-fast)', () => {
    const ctx: GuardianContext = {
      trustClass: 'trusted_contact',
      // No guardianExternalUserId — no guardian binding for this channel
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: false,
      promptWaitingAllowed: false,
    });
  });

  test('unknown actors are never interactive regardless of guardian route', () => {
    const withRoute: GuardianContext = {
      trustClass: 'unknown',
      guardianExternalUserId: 'guardian-789',
    };
    const withoutRoute: GuardianContext = {
      trustClass: 'unknown',
    };

    expect(resolveRoutingState(withRoute).promptWaitingAllowed).toBe(false);
    expect(resolveRoutingState(withRoute).canBeInteractive).toBe(false);
    expect(resolveRoutingState(withoutRoute).promptWaitingAllowed).toBe(false);
  });
});

describe('resolveRoutingStateFromRuntime', () => {
  test('produces same result as resolveRoutingState for guardian runtime context', () => {
    const runtimeCtx = {
      sourceChannel: 'telegram' as const,
      trustClass: 'trusted_contact' as const,
      guardianExternalUserId: 'guardian-rt-1',
    };
    const state = resolveRoutingStateFromRuntime(runtimeCtx);
    expect(state.promptWaitingAllowed).toBe(true);
    expect(state.guardianRouteResolvable).toBe(true);
  });

  test('trusted contact runtime context without guardian binding is not interactive', () => {
    const runtimeCtx = {
      sourceChannel: 'telegram' as const,
      trustClass: 'trusted_contact' as const,
      // No guardianExternalUserId
    };
    const state = resolveRoutingStateFromRuntime(runtimeCtx);
    expect(state.promptWaitingAllowed).toBe(false);
    expect(state.guardianRouteResolvable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests: inbound message handler interactivity
// ═══════════════════════════════════════════════════════════════════════════

describe('inbound-message-handler trusted-contact interactivity', () => {
  beforeEach(() => {
    resetTables();
    mockFindMember = null;
  });

  function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
    return new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': 'test-token',
      },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        interface: 'telegram',
        conversationExternalId: 'chat-123',
        externalMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: 'hello',
        actorExternalId: 'telegram-user-default',
        replyCallbackUrl: 'https://gateway.test/deliver/telegram',
        ...overrides,
      }),
    });
  }

  test('trusted contact with guardian binding gets interactive turn', async () => {
    // Create guardian binding so the trusted contact has a resolvable route
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-for-tc',
      guardianDeliveryChatId: 'guardian-chat-for-tc',
    });

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(async (
      conversationId: string,
      _content: string,
      _attachmentIds?: string[],
      options?: Record<string, unknown>,
    ) => {
      processCalls.push({ options });
      const messageId = `msg-tc-interactive-${Date.now()}`;
      const db = getDb();
      db.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'hello' }]),
        createdAt: Date.now(),
      }).run();
      return { messageId };
    });

    const req = makeInboundRequest({
      externalMessageId: `msg-tc-interactive-${Date.now()}`,
    });

    const res = await handleChannelInbound(req, processMessage as any, 'test-token');
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Wait for background processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);
  });

  test('trusted contact WITHOUT guardian binding gets non-interactive turn (fail-fast)', async () => {
    // No guardian binding created — trusted contact has no guardian route
    // but findMember still returns an active member (trusted_contact trust class)

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(async (
      conversationId: string,
      _content: string,
      _attachmentIds?: string[],
      options?: Record<string, unknown>,
    ) => {
      processCalls.push({ options });
      const messageId = `msg-tc-noroute-${Date.now()}`;
      const db = getDb();
      db.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'hello' }]),
        createdAt: Date.now(),
      }).run();
      return { messageId };
    });

    const req = makeInboundRequest({
      externalMessageId: `msg-tc-noroute-${Date.now()}`,
    });

    const res = await handleChannelInbound(req, processMessage as any, 'test-token');
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    // Trusted contact without a guardian binding should NOT be interactive
    // to prevent dead-end 300s prompt waits
    expect(processCalls[0].options?.isInteractive).toBe(false);
  });

  test('guardian actors remain interactive regardless', async () => {
    // Guardian binding matches the sender
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(async (
      conversationId: string,
      _content: string,
      _attachmentIds?: string[],
      options?: Record<string, unknown>,
    ) => {
      processCalls.push({ options });
      const messageId = `msg-guardian-${Date.now()}`;
      const db = getDb();
      db.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'hello' }]),
        createdAt: Date.now(),
      }).run();
      return { messageId };
    });

    const req = makeInboundRequest({
      externalMessageId: `msg-guardian-${Date.now()}`,
    });

    const res = await handleChannelInbound(req, processMessage as any, 'test-token');
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);
  });

  test('unknown actors remain non-interactive', async () => {
    // No guardian binding, no member record => unknown trust class
    mockFindMember = () => null;

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(async (
      conversationId: string,
      _content: string,
      _attachmentIds?: string[],
      options?: Record<string, unknown>,
    ) => {
      processCalls.push({ options });
      const messageId = `msg-unknown-${Date.now()}`;
      const db = getDb();
      db.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'hello' }]),
        createdAt: Date.now(),
      }).run();
      return { messageId };
    });

    const req = makeInboundRequest({
      externalMessageId: `msg-unknown-${Date.now()}`,
      // No actorExternalId => unknown trust class
      actorExternalId: undefined,
    });

    const res = await handleChannelInbound(req, processMessage as any, 'test-token');
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests: channel-retry-sweep routing state
// ═══════════════════════════════════════════════════════════════════════════

describe('channel-retry-sweep routing state', () => {
  beforeEach(() => {
    resetTables();
    mockFindMember = null;
  });

  function seedFailedEvent(trustClass: 'guardian' | 'trusted_contact' | 'unknown', guardianExternalUserId?: string): string {
    const inbound = channelDeliveryStore.recordInbound('telegram', `chat-${trustClass}`, `msg-${trustClass}-${Date.now()}`);
    channelDeliveryStore.storePayload(inbound.eventId, {
      content: 'retry me',
      sourceChannel: 'telegram',
      interface: 'telegram',
      guardianCtx: {
        trustClass,
        sourceChannel: 'telegram',
        requesterExternalUserId: 'test-user',
        requesterChatId: `chat-${trustClass}`,
        ...(guardianExternalUserId ? { guardianExternalUserId } : {}),
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

  test('trusted_contact with guardian binding replays as interactive', async () => {
    seedFailedEvent('trusted_contact', 'guardian-for-sweep');
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-tc-sweep-${Date.now()}`;
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

    expect(capturedOptions?.isInteractive).toBe(true);
  });

  test('trusted_contact without guardian binding replays as non-interactive', async () => {
    seedFailedEvent('trusted_contact');
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-tc-no-binding-${Date.now()}`;
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

    expect(capturedOptions?.isInteractive).toBe(false);
  });

  test('guardian replays as interactive', async () => {
    seedFailedEvent('guardian', 'guardian-self');
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-guardian-sweep-${Date.now()}`;
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

    expect(capturedOptions?.isInteractive).toBe(true);
  });

  test('unknown replays as non-interactive', async () => {
    seedFailedEvent('unknown');
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-unknown-sweep-${Date.now()}`;
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

    expect(capturedOptions?.isInteractive).toBe(false);
  });
});
