import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'channel-approval-routes-test-'));

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

// Mock render to return the raw content as text
mock.module('../daemon/handlers.js', () => ({
  renderHistoryContent: (content: unknown) => ({
    text: typeof content === 'string' ? content : JSON.stringify(content),
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations, externalConversationBindings } from '../memory/schema.js';
import {
  createRun,
  setRunConfirmation,
} from '../memory/runs-store.js';
import type { PendingConfirmation } from '../memory/runs-store.js';
import { setConversationKeyIfAbsent } from '../memory/conversation-key-store.js';
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import {
  createBinding,
  createApprovalRequest,
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
} from '../memory/channel-guardian-store.js';
import type { RunOrchestrator } from '../runtime/run-orchestrator.js';
import {
  handleChannelInbound,
  sweepExpiredGuardianApprovals,
  verifyGatewayOrigin,
  _setTestPollMaxWait,
} from '../runtime/routes/channel-routes.js';
import * as gatewayClient from '../runtime/gateway-client.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureConversation(conversationId: string): void {
  const db = getDb();
  try {
    db.insert(conversations).values({
      id: conversationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();
  } catch {
    // already exists
  }
}

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_guardian_approval_requests');
  db.run('DELETE FROM channel_guardian_verification_challenges');
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM conversation_keys');
  db.run('DELETE FROM message_runs');
  db.run('DELETE FROM channel_inbound_events');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  channelDeliveryStore.resetAllRunDeliveryClaims();
}

const sampleConfirmation: PendingConfirmation = {
  toolName: 'shell',
  toolUseId: 'req-abc-123',
  input: { command: 'rm -rf /tmp/test' },
  riskLevel: 'high',
  allowlistOptions: [{ label: 'rm -rf /tmp/test', pattern: 'rm -rf /tmp/test' }],
  scopeOptions: [{ label: 'everywhere', scope: 'everywhere' }],
};

function makeMockOrchestrator(
  submitResult: 'applied' | 'run_not_found' | 'no_pending_decision' = 'applied',
): RunOrchestrator {
  return {
    submitDecision: mock(() => submitResult),
    getRun: mock(() => null),
    startRun: mock(async () => ({
      id: 'run-1',
      conversationId: 'conv-1',
      messageId: null,
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  } as unknown as RunOrchestrator;
}

/** Default bearer token used by tests. Include the X-Gateway-Origin header
 *  so that verifyGatewayOrigin does not reject the request. */
const TEST_BEARER_TOKEN = 'token';

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    sourceChannel: 'telegram',
    externalChatId: 'chat-123',
    senderExternalUserId: 'telegram-user-default',
    externalMessageId: `msg-${Date.now()}-${Math.random()}`,
    content: 'hello',
    replyCallbackUrl: 'https://gateway.test/deliver',
    ...overrides,
  };
  return new Request('http://localhost/channels/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Origin': TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

const noopProcessMessage = mock(async () => ({ messageId: 'msg-1' }));

beforeEach(() => {
  resetTables();
  noopProcessMessage.mockClear();
});
describe('stale callback handling without matching pending approval', () => {
  test('ignores stale callback payloads even when pending approvals exist', async () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const orchestrator = makeMockOrchestrator();
    const req = makeInboundRequest({
      content: 'approve',
      callbackData: 'apr:run-1:approve_once',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, undefined, orchestrator);
    const body = await res.json() as Record<string, unknown>;

    // Callback payloads without a matching pending approval are treated as
    // stale and ignored.
    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Callback data triggers decision handling
// ═══════════════════════════════════════════════════════════════════════════

describe('inbound callback metadata triggers decision handling', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('callback data "apr:<runId>:approve_once" is parsed and applied', async () => {
    // We need the conversation to exist AND have a pending run.
    // The channel-delivery-store will create a conversation for us via recordInbound,
    // but we also need the run to be linked to the same conversationId.
    // Let's set up the conversation first, then create a run.
    ensureConversation('conv-1');

    // Create and record an earlier inbound event for this chat to establish
    // the conversation mapping (so recordInbound returns the same conversationId).
    // Actually, recordInbound auto-creates a conversationId based on source+chat.
    // We need to find out what conversationId will be generated for telegram:chat-123.

    // Let's use a spy to check if handleChannelDecision-equivalent behavior fires.
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // First, send a normal message to establish the conversation.
    const initReq = makeInboundRequest({ content: 'init' });
    const initRes = await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);
    const _initBody = await initRes.json() as { conversationId?: string; eventId?: string; accepted?: boolean };

    // Now we need to find the actual conversationId that was created.
    // Check the channel_inbound_events table.
    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    expect(conversationId).toBeTruthy();

    // Ensure conversation row exists for FK constraints
    ensureConversation(conversationId!);

    // Create a pending run for this conversation
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Now send a callback data message
    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('callback data "apr:<runId>:reject" applies a rejection', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:reject`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Plain text triggers decision handling
// ═══════════════════════════════════════════════════════════════════════════

describe('inbound text decisions via conversational approval trigger decision handling', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('text "approve" triggers approve_once decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved once.',
    }));

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeInboundRequest({ content: 'approve' });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('text "always" triggers approve_always decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_always' as const,
      replyText: 'Approved always.',
    }));

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeInboundRequest({ content: 'always' });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Non-decision messages during pending approval (no conversational engine)
// ═══════════════════════════════════════════════════════════════════════════

describe('non-decision messages during pending approval (legacy fallback)', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('sends a status reply when message is not a decision and no conversational engine', async () => {
    const orchestrator = makeMockOrchestrator();
    const replySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send a message that is NOT a decision
    const req = makeInboundRequest({ content: 'what is the weather?' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // A status reply should have been delivered via deliverChannelReply
    expect(replySpy).toHaveBeenCalled();
    const statusCall = replySpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { chatId?: string }).chatId === 'chat-123',
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    // The status text is generated by composeApprovalMessageGenerative
    // with reminder_prompt scenario — it should mention a pending approval.
    expect(statusPayload.text).toContain('pending approval request');

    replySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Messages without pending approval proceed normally
// ═══════════════════════════════════════════════════════════════════════════

describe('messages without pending approval proceed normally', () => {
  beforeEach(() => {
  });

  test('proceeds to normal processing when no pending approval exists', async () => {
    const orchestrator = makeMockOrchestrator();

    const req = makeInboundRequest({ content: 'hello world' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBeUndefined();
    // Normal flow should have been triggered
  });

  test('text "approve" is processed normally when no pending approval exists', async () => {
    const orchestrator = makeMockOrchestrator();

    const req = makeInboundRequest({ content: 'approve' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should NOT be treated as an approval decision since there's no pending approval
    expect(body.approval).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Empty content with callbackData bypasses validation
// ═══════════════════════════════════════════════════════════════════════════

describe('empty content with callbackData bypasses validation', () => {
  test('rejects empty content without callbackData', async () => {
    const req = makeInboundRequest({ content: '' });
    const res = await handleChannelInbound(req, noopProcessMessage);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('content or attachmentIds is required');
  });

  test('allows empty content when callbackData is present', async () => {
    const orchestrator = makeMockOrchestrator();

    // Establish the conversation first
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    // Should NOT return 400 — callbackData allows empty content through
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    deliverSpy.mockRestore();
  });

  test('allows undefined content when callbackData is present', async () => {
    const orchestrator = makeMockOrchestrator();

    // Establish the conversation first
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Send with no content field at all, just callbackData
    const body = {
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      externalMessageId: `msg-${Date.now()}-${Math.random()}`,
      callbackData: `apr:${run.id}:approve_once`,
      replyCallbackUrl: 'https://gateway.test/deliver',
    };
    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': TEST_BEARER_TOKEN,
      },
      body: JSON.stringify(body),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, TEST_BEARER_TOKEN, orchestrator);
    expect(res.status).toBe(200);
    const resBody = await res.json() as Record<string, unknown>;
    expect(resBody.accepted).toBe(true);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Callback run ID validation — stale button press
// ═══════════════════════════════════════════════════════════════════════════

describe('callback run ID validation', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('ignores stale callback when run ID does not match pending run', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send callback with a DIFFERENT run ID (stale button)
    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:stale-run-id:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');
    // submitDecision should NOT have been called because the run ID didn't match
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test('applies callback when run ID matches pending run', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send callback with the CORRECT run ID
    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    // submitDecision SHOULD have been called with the correct run ID
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('single-pending conversational decision can apply without targetRunId', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved.',
    }));

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // With a single pending approval, targetRunId is optional for decision-bearing dispositions.
    const req = makeInboundRequest({ content: 'yes' });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. linkMessage in approval-aware processing path
// ═══════════════════════════════════════════════════════════════════════════

describe('linkMessage in approval-aware processing path', () => {
  beforeEach(() => {
  });

  test('linkMessage is called when run has a messageId and reaches terminal state', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-link-test',
      conversationId: 'conv-1',
      messageId: 'user-msg-42',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // getRun returns completed status immediately so the poll loop exits
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete (must exceed RUN_POLL_INTERVAL_MS of 500ms)
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Verify linkMessage was called with the run's messageId
    const linkCalls = linkSpy.mock.calls.filter(
      (call) => call[1] === 'user-msg-42',
    );
    expect(linkCalls.length).toBeGreaterThanOrEqual(1);

    // Verify markProcessed was also called
    expect(markSpy).toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Terminal state check before markProcessed
// ═══════════════════════════════════════════════════════════════════════════

describe('terminal state check before markProcessed', () => {
  beforeEach(() => {
  });

  test('records processing failure when run disappears (non-approval non-terminal state)', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-nonterminal',
      conversationId: 'conv-1',
      messageId: 'user-msg-99',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // getRun returns null — run disappeared, poll loop breaks. Since the run
    // is not in needs_confirmation, it falls through to recordProcessingFailure
    // so the retry/dead-letter machinery can handle it.
    const orchNull = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => null),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchNull);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // recordProcessingFailure SHOULD have been called because the run is
    // not in needs_confirmation (it disappeared — status is null).
    expect(failureSpy).toHaveBeenCalled();

    // markProcessed should NOT have been called
    expect(markSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test('markProcessed is called when run reaches completed state', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-completes',
      conversationId: 'conv-1',
      messageId: 'user-msg-100',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed should have been called because the run reached completed
    expect(markSpy).toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test('markProcessed is called when run reaches failed state', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-fails',
      conversationId: 'conv-1',
      messageId: 'user-msg-101',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'failed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed should have been called because the run reached failed
    expect(markSpy).toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. No immediate reply after approval decision (WS-A)
// ═══════════════════════════════════════════════════════════════════════════

describe('no immediate reply after approval decision', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('deliverChannelReply is NOT called from interception after decision is applied', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Clear the spy to only track calls from the decision path
    deliverSpy.mockClear();

    // Send a callback decision
    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.approval).toBe('decision_applied');

    // The interception handler should NOT have called deliverChannelReply.
    // The reply should only come from the terminal run completion path.
    expect(deliverSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test('conversational decision delivers engine reply immediately', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Done, approving this request.',
    }));

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Send a plain-text approval
    const req = makeInboundRequest({ content: 'approve' });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.approval).toBe('decision_applied');
    expect(deliverSpy).toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Stale callback with no pending approval returns stale_ignored (WS-B)
// ═══════════════════════════════════════════════════════════════════════════

describe('stale callback handling', () => {
  beforeEach(() => {
  });

  test('callback with no pending approval returns stale_ignored and does not start a run', async () => {
    const orchestrator = makeMockOrchestrator();

    // No pending run/approval — send a stale callback
    const req = makeInboundRequest({
      content: '',
      callbackData: 'apr:stale-run:approve_once',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');

    // startRun should NOT have been called — the stale callback must not
    // enter processChannelMessageWithApprovals or processChannelMessageInBackground
    expect(orchestrator.startRun).not.toHaveBeenCalled();
  });

  test('callback with non-empty content but no pending approval returns stale_ignored', async () => {
    const orchestrator = makeMockOrchestrator();

    // Simulate what normalize.ts does: callbackData present AND content is
    // set to the callback data value (non-empty). Without the fix, this
    // would fall through to normal processing because the old guard only
    // checked for empty content.
    const req = makeInboundRequest({
      content: 'apr:stale-run:approve_once',
      callbackData: 'apr:stale-run:approve_once',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');
    expect(orchestrator.startRun).not.toHaveBeenCalled();
  });

  test('non-callback message without pending approval proceeds to normal processing', async () => {
    const orchestrator = makeMockOrchestrator();

    // Regular text message (no callbackData) should proceed normally
    const req = makeInboundRequest({ content: 'hello world' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // No approval field — normal processing
    expect(body.approval).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Timeout handling: needs_confirmation marks processed, other states fail
// ═══════════════════════════════════════════════════════════════════════════

describe('poll timeout handling by run state', () => {
  beforeEach(() => {
  });

  test('records processing failure when run disappears (getRun returns null) before terminal state', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-timeout-1',
      conversationId: 'conv-1',
      messageId: 'user-msg-200',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // getRun returns null — run disappeared, poll loop breaks. Since the run
    // is not in needs_confirmation, it records a processing failure.
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => null),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello timeout' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // recordProcessingFailure SHOULD have been called — the run disappeared
    // and is not in needs_confirmation, so the retry machinery should handle it.
    expect(failureSpy).toHaveBeenCalled();

    // markProcessed should NOT have been called
    expect(markSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test('marks event as processed when run is in needs_confirmation state after poll timeout', async () => {
    // Use a short poll timeout so the test can exercise the timeout path
    // without waiting 5 minutes. Must exceed one poll interval (500ms).
    _setTestPollMaxWait(700);

    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-needs-confirm',
      conversationId: 'conv-1',
      messageId: 'user-msg-202',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // getRun returns null on the first call (causing the poll loop to break
    // immediately), then returns needs_confirmation on the post-loop call.
    // This exercises the timeout path deterministically without spinning for
    // the full poll duration.
    let getRunCalls = 0;
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        getRunCalls++;
        if (getRunCalls <= 1) return null;
        return { ...mockRun, status: 'needs_confirmation' as const };
      }),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello needs_confirm' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed SHOULD have been called — the run is waiting for approval,
    // and the post-decision delivery path will handle the final reply.
    expect(markSpy).toHaveBeenCalled();

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
    _setTestPollMaxWait(null);
  });

  test('marks event as processed when run transitions from needs_confirmation to running at poll timeout', async () => {
    // When an approval is applied near the poll deadline, the run transitions
    // from needs_confirmation to running. The post-decision delivery path
    // in handleApprovalInterception handles the final reply, so the main poll
    // should mark the event as processed rather than recording a failure.
    //
    // The hasPostDecisionDelivery flag is only set when the approval prompt
    // is actually delivered successfully — not in auto-deny paths. This test
    // sets up a guardian actor with a real DB run so the standard approval
    // prompt is delivered and the flag is set.
    _setTestPollMaxWait(100);

    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    // Set up a guardian binding so the sender is a guardian (standard approval
    // path, not auto-deny). This ensures the approval prompt is delivered and
    // hasPostDecisionDelivery is set to true.
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });

    const conversationId = `conv-post-approval-${Date.now()}`;
    ensureConversation(conversationId);
    setConversationKeyIfAbsent('asst:self:telegram:chat-123', conversationId);
    setConversationKeyIfAbsent('telegram:chat-123', conversationId);

    let realRunId: string | undefined;

    // Simulate a run that transitions from needs_confirmation back to running
    // (approval applied) before the poll exits, then stays running past timeout.
    let getRunCalls = 0;
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        getRunCalls++;
        // First call inside the loop: needs_confirmation (triggers approval prompt delivery)
        if (getRunCalls <= 1) return {
          id: realRunId ?? 'run-post-approval',
          conversationId,
          messageId: 'user-msg-203',
          status: 'needs_confirmation' as const,
          pendingConfirmation: sampleConfirmation,
          pendingSecret: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // Subsequent calls: running (approval was applied, run resumed)
        return {
          id: realRunId ?? 'run-post-approval',
          conversationId,
          messageId: 'user-msg-203',
          status: 'running' as const,
          pendingConfirmation: null,
          pendingSecret: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
      startRun: mock(async (_convId: string) => {
        const run = createRun(conversationId);
        realRunId = run.id;
        setRunConfirmation(run.id, sampleConfirmation);
        return {
          id: run.id,
          conversationId,
          messageId: null,
          status: 'running' as const,
          pendingConfirmation: null,
          pendingSecret: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello post-approval running' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async to complete (poll timeout + buffer)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The approval prompt should have been delivered (standard path for guardian actor)
    expect(approvalSpy).toHaveBeenCalled();

    // markProcessed SHOULD have been called — the approval prompt was delivered
    // (hasPostDecisionDelivery is true) and the run transitioned to running
    // (post-approval), so the post-decision delivery path handles the final reply.
    expect(markSpy).toHaveBeenCalled();

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
    _setTestPollMaxWait(null);
  });

  test('does NOT call recordProcessingFailure when run reaches terminal state', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-terminal-ok',
      conversationId: 'conv-1',
      messageId: 'user-msg-201',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // getRun returns completed — run is terminal
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello terminal' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

    // markProcessed SHOULD have been called
    expect(markSpy).toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12b. Post-decision delivery after poll timeout
// ═══════════════════════════════════════════════════════════════════════════

describe('post-decision delivery after poll timeout', () => {
  beforeEach(() => {
  });

  test('delivers reply via callback after a late approval decision', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    const orchestrator = makeMockOrchestrator();
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Add a mock assistant message so that deliverReplyViaCallback can find
    // the final reply to deliver.
    conversationStore.addMessage(conversationId!, 'assistant', 'Here is your result.');

    // Now create a second orchestrator that simulates the run completing after
    // the decision is applied (getRun returns completed after first call).
    let getRunCallCount = 0;
    const lateOrchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        getRunCallCount++;
        // First call returns needs_confirmation (decision just applied, resuming),
        // subsequent calls return completed (run finished).
        if (getRunCallCount <= 1) {
          return {
            id: run.id,
            conversationId: conversationId!,
            messageId: 'user-msg-late',
            status: 'needs_confirmation' as const,
            pendingConfirmation: null,
            pendingSecret: null,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
        return {
          id: run.id,
          conversationId: conversationId!,
          messageId: 'user-msg-late',
          status: 'completed' as const,
          pendingConfirmation: null,
          pendingSecret: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
      startRun: mock(async () => ({
        id: run.id,
        conversationId: conversationId!,
        messageId: 'user-msg-late',
        status: 'running' as const,
        pendingConfirmation: null,
        pendingSecret: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
    } as unknown as RunOrchestrator;

    // Clear spy to only track calls from the decision + post-decision path
    deliverSpy.mockClear();

    // Send an approval decision — this simulates a late approval after the
    // original poll has already timed out.
    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', lateOrchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // Wait for the async post-decision delivery poll to complete.
    // It polls every 500ms; the run becomes terminal on the second getRun call.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // deliverChannelReply should have been called by the post-decision
    // delivery path (deliverReplyViaCallback uses deliverChannelReply).
    expect(deliverSpy).toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. sourceChannel is passed to orchestrator.startRun (WS-D)
// ═══════════════════════════════════════════════════════════════════════════

describe('sourceChannel passed to orchestrator.startRun', () => {
  beforeEach(() => {
  });

  test('startRun is called with sourceChannel from inbound event', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-channel-test',
      conversationId: 'conv-1',
      messageId: 'user-msg-300',
      status: 'completed' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({
      content: 'test channel pass-through',
      sourceChannel: 'telegram',
    });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to fire
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Verify startRun was called with the sourceChannel option
    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    // 4th argument is the options object
    const options = startRunArgs[3] as { sourceChannel?: string } | undefined;
    expect(options).toBeDefined();
    expect(options!.sourceChannel).toBe('telegram');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Plain-text fallback surfacing for non-rich channels (WS-E)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 15. SMS channel approval decisions
// ═══════════════════════════════════════════════════════════════════════════

describe('SMS channel approval decisions', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'sms-user-default',
      guardianDeliveryChatId: 'sms-chat-123',
    });
  });

  function makeSmsInboundRequest(overrides: Record<string, unknown> = {}): Request {
    const body = {
      sourceChannel: 'sms',
      externalChatId: 'sms-chat-123',
      senderExternalUserId: 'sms-user-default',
      externalMessageId: `msg-${Date.now()}-${Math.random()}`,
      content: 'hello',
      replyCallbackUrl: 'https://gateway.test/deliver',
      ...overrides,
    };
    return new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': TEST_BEARER_TOKEN,
      },
      body: JSON.stringify(body),
    });
  }

  test('plain-text "yes" via SMS triggers approve_once decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved once.',
    }));

    // Establish the conversation via SMS
    const initReq = makeSmsInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeSmsInboundRequest({ content: 'yes' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('plain-text "no" via SMS triggers reject decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'reject' as const,
      replyText: 'Denied.',
    }));

    const initReq = makeSmsInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeSmsInboundRequest({ content: 'no' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    deliverSpy.mockRestore();
  });

  test('non-decision SMS message during pending approval sends status reply', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const initReq = makeSmsInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeSmsInboundRequest({ content: 'what is happening?' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // SMS non-decision: status reply delivered via plain text
    expect(deliverSpy).toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    const statusCall = deliverSpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { chatId?: string }).chatId === 'sms-chat-123',
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string; approval?: unknown };
    const deliveredText = statusPayload.text ?? '';
    // Status text from composeApprovalMessageGenerative with reminder_prompt scenario
    expect(deliveredText).toContain('pending approval request');
    expect(statusPayload.approval).toBeUndefined();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('sourceChannel "sms" is passed to orchestrator.startRun', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-sms-channel-test',
      conversationId: 'conv-1',
      messageId: 'user-msg-sms',
      status: 'completed' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeSmsInboundRequest({ content: 'test sms channel pass-through' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to fire
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    const options = startRunArgs[3] as { sourceChannel?: string } | undefined;
    expect(options).toBeDefined();
    expect(options!.sourceChannel).toBe('sms');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. SMS guardian verify intercept
// ═══════════════════════════════════════════════════════════════════════════

describe('SMS guardian verify intercept', () => {
  test('/guardian_verify command works with sourceChannel sms', async () => {
    // Set up a guardian verification challenge for SMS
    const { createVerificationChallenge } = await import('../runtime/channel-guardian-service.js');
    const { secret } = createVerificationChallenge('self', 'sms');

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-chat-verify',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: `/guardian_verify ${secret}`,
        senderExternalUserId: 'sms-user-42',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, TEST_BEARER_TOKEN);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.guardianVerification).toBe('verified');

    // Verify the reply was delivered
    expect(deliverSpy).toHaveBeenCalled();
    const replyArgs = deliverSpy.mock.calls[0];
    const replyPayload = replyArgs[1] as { chatId: string; text: string };
    expect(replyPayload.chatId).toBe('sms-chat-verify');
    expect(typeof replyPayload.text).toBe('string');
    expect(replyPayload.text.toLowerCase()).toContain('guardian');
    expect(replyPayload.text.toLowerCase()).toContain('verif');

    deliverSpy.mockRestore();
  });

  test('/guardian_verify with invalid token returns failed via SMS', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-chat-verify-fail',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: '/guardian_verify invalid-token-here',
        senderExternalUserId: 'sms-user-43',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, TEST_BEARER_TOKEN);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.guardianVerification).toBe('failed');

    expect(deliverSpy).toHaveBeenCalled();
    const replyArgs = deliverSpy.mock.calls[0];
    const replyPayload = replyArgs[1] as { chatId: string; text: string };
    expect(typeof replyPayload.text).toBe('string');
    expect(replyPayload.text.toLowerCase()).toContain('verif');
    expect(replyPayload.text.toLowerCase()).toContain('failed');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. SMS non-guardian actor gating
// ═══════════════════════════════════════════════════════════════════════════

describe('SMS non-guardian actor gating', () => {
  beforeEach(() => {
  });

  test('non-guardian SMS actor gets stricter controls when guardian binding exists', async () => {
    // Create a guardian binding for the sms channel
    const { createBinding } = await import('../memory/channel-guardian-store.js');
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'sms-guardian-user',
      guardianDeliveryChatId: 'sms-guardian-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-sms-nongrd',
      conversationId: 'conv-1',
      messageId: 'user-msg-sms-nongrd',
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    // Send message from a NON-guardian sms user
    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-other-chat',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: 'do something',
        senderExternalUserId: 'sms-other-user',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    await handleChannelInbound(req, noopProcessMessage, TEST_BEARER_TOKEN, orchestrator);

    // Wait for the background async to fire
    await new Promise((resolve) => setTimeout(resolve, 800));

    // startRun should have been called with forceStrictSideEffects for non-guardian
    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    const options = startRunArgs[3] as { forceStrictSideEffects?: boolean; sourceChannel?: string } | undefined;
    expect(options).toBeDefined();
    expect(options!.forceStrictSideEffects).toBe(true);
    expect(options!.sourceChannel).toBe('sms');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

describe('non-decision status reply for different channels', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
    createBinding({
      assistantId: 'self',
      channel: 'sms',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('non-decision message on non-rich channel (sms) sends status reply', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation using sms (non-rich channel)
    const initReq = makeInboundRequest({ content: 'init', sourceChannel: 'sms' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send a non-decision message
    const req = makeInboundRequest({ content: 'what is happening?', sourceChannel: 'sms' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // Status reply delivered via deliverChannelReply
    expect(deliverSpy).toHaveBeenCalled();
    const statusCall = deliverSpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { chatId?: string }).chatId === 'chat-123',
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    expect(statusPayload.text).toContain('pending approval request');

    deliverSpy.mockRestore();
  });

  test('non-decision message on telegram sends status reply', async () => {
    const orchestrator = makeMockOrchestrator();
    const replySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation using telegram (rich channel)
    const initReq = makeInboundRequest({ content: 'init', sourceChannel: 'telegram' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send a non-decision message
    const req = makeInboundRequest({ content: 'what is happening?', sourceChannel: 'telegram' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // Status reply delivered via deliverChannelReply
    expect(replySpy).toHaveBeenCalled();
    const statusCall = replySpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { chatId?: string }).chatId === 'chat-123',
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    expect(statusPayload.text).toContain('pending approval request');

    replySpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Helper: orchestrator that creates real DB runs with pending confirmations
// ---------------------------------------------------------------------------

function makeSensitiveOrchestrator(opts: {
  runId: string;
  terminalStatus: 'completed' | 'failed';
}): RunOrchestrator & { realRunId: () => string | undefined } {
  let realRunId: string | undefined;
  let pollCount = 0;
  return {
    submitDecision: mock(() => 'applied' as const),
    getRun: mock(() => {
      pollCount++;
      if (pollCount === 1 && realRunId) {
        return {
          id: realRunId,
          conversationId: 'conv-1',
          messageId: null,
          status: 'needs_confirmation' as const,
          pendingConfirmation: sampleConfirmation,
          pendingSecret: null,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      return {
        id: realRunId ?? opts.runId,
        conversationId: 'conv-1',
        messageId: null,
        status: opts.terminalStatus,
        pendingConfirmation: null,
        pendingSecret: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }),
    startRun: mock(async (conversationId: string) => {
      ensureConversation(conversationId);
      const run = createRun(conversationId);
      setRunConfirmation(run.id, sampleConfirmation);
      realRunId = run.id;
      return {
        id: run.id,
        conversationId,
        messageId: null,
        status: 'running' as const,
        pendingConfirmation: null,
        pendingSecret: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }),
    realRunId: () => realRunId,
  } as unknown as RunOrchestrator & { realRunId: () => string | undefined };
}

// ═══════════════════════════════════════════════════════════════════════════
// 18. Fail-closed guardian gate (WS-1)
// ═══════════════════════════════════════════════════════════════════════════

describe('fail-closed guardian gate — unverified channel', () => {
  beforeEach(() => {
  });

  test('no binding + sensitive action → auto-deny with contextual assistant guidance', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-unv-1', terminalStatus: 'failed' });

    // Non-guardian sender, no binding exists → unverified_channel
    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'user-no-binding',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The run should have been denied (submitDecision called with deny)
    expect(orchestrator.submitDecision).toHaveBeenCalled();
    const decisionArgs = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls[0];
    expect(decisionArgs[1]).toBe('deny');

    // The deny decision should carry guardian setup context for assistant reply generation.
    expect(typeof decisionArgs[2]).toBe('string');
    expect((decisionArgs[2] as string).toLowerCase()).toContain('no guardian');

    // The runtime should not send a second deterministic denial notice.
    const deterministicNoticeCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.toLowerCase().includes('no guardian'),
    );
    expect(deterministicNoticeCalls.length).toBe(0);

    // No approval prompt should have been sent to a guardian (none exists)
    expect(approvalSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('no binding + non-sensitive action → completes normally', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Orchestrator that completes without hitting needs_confirmation
    const mockRun = {
      id: 'run-unv-safe',
      conversationId: 'conv-1',
      messageId: null,
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({
      content: 'what time is it',
      senderExternalUserId: 'user-no-binding',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // submitDecision should NOT have been called — no confirmation needed
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test('unverified channel cannot self-approve via interception', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-unv-self', terminalStatus: 'failed' });

    // First, send a message to establish the conversation and trigger
    // the sensitive action (which will be auto-denied in the poll loop).
    const initReq = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: 'user-no-binding',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Now find the conversation
    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create another pending run in this conversation
    const run2 = createRun(conversationId!);
    setRunConfirmation(run2.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Try to self-approve
    const approveReq = makeInboundRequest({
      content: 'approve',
      senderExternalUserId: 'user-no-binding',
    });

    const res = await handleChannelInbound(approveReq, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // The deny decision should carry guardian setup context for the assistant.
    const submitCalls = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls;
    expect(submitCalls.length).toBeGreaterThanOrEqual(1);
    const lastDecision = submitCalls[submitCalls.length - 1];
    expect(lastDecision[1]).toBe('deny');
    expect(typeof lastDecision[2]).toBe('string');
    expect((lastDecision[2] as string).toLowerCase()).toContain('no guardian');

    // Interception should not emit a separate deterministic denial notice.
    const denialCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.toLowerCase().includes('no guardian'),
    );
    expect(denialCalls.length).toBe(0);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Guardian-with-binding path regression
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian-with-binding path regression', () => {
  beforeEach(() => {
  });

  test('non-guardian with binding routes approval to guardian chat', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-1',
      guardianDeliveryChatId: 'guardian-chat-1',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-binding-1', terminalStatus: 'completed' });

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'non-guardian-user',
      senderUsername: 'nongrd',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Approval prompt should have been sent to the guardian's chat
    expect(approvalSpy).toHaveBeenCalled();
    const approvalArgs = approvalSpy.mock.calls[0];
    expect(approvalArgs[1]).toBe('guardian-chat-1');

    // Requester should have been notified the request was forwarded to the guardian
    const notifyCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.toLowerCase().includes('guardian'),
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('guardian sender gets standard self-approval flow', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-2',
      guardianDeliveryChatId: 'guardian-chat-2',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-binding-2', terminalStatus: 'completed' });

    // Message from the guardian user — should get standard approval prompt
    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'guardian-user-2',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Approval prompt should have been sent to the requester's own chat
    // (standard self-approval flow, not routed to guardian)
    expect(approvalSpy).toHaveBeenCalled();
    const approvalArgs = approvalSpy.mock.calls[0];
    // The chat ID should be the sender's own chat, not guardian-chat-2
    expect(approvalArgs[1]).toBe('chat-123');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('guardian callback for own pending run is handled by standard interception', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-self-callback',
      guardianDeliveryChatId: 'chat-123',
    });

    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation mapping for chat-123.
    const initReq = makeInboundRequest({
      content: 'init',
      senderExternalUserId: 'guardian-user-self-callback',
      externalChatId: 'chat-123',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Button callback includes a runId but there is no guardian approval request
    // because this is the guardian's own approval flow.
    const req = makeInboundRequest({
      content: '',
      senderExternalUserId: 'guardian-user-self-callback',
      externalChatId: 'chat-123',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');
    expect(getPendingApprovalForRun(run.id)).toBeNull();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Guardian rich-delivery failure fallback (WS-2)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian delivery failure → text fallback', () => {
  beforeEach(() => {
  });

  test('rich delivery failure falls back to plain text and keeps request pending', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-df',
      guardianDeliveryChatId: 'guardian-chat-df',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    // Make the guardian approval prompt delivery fail
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockRejectedValue(
      new Error('Network error: guardian unreachable'),
    );

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-df-1', terminalStatus: 'failed' });

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'non-guardian-df-user',
      senderUsername: 'nongrd_df',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Rich button delivery failed, but plain-text fallback succeeded.
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();
    expect(approvalSpy).toHaveBeenCalled();

    // Guardian should have received a parser-compatible plain-text approval prompt.
    const guardianPromptCalls = deliverSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'object' &&
        (call[1] as { chatId?: string; text?: string }).chatId === 'guardian-chat-df' &&
        ((call[1] as { text?: string }).text ?? '').includes('Reply "yes"'),
    );
    expect(guardianPromptCalls.length).toBeGreaterThanOrEqual(1);

    // Requester should still get the forwarded notice once fallback delivery works.
    const successCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.toLowerCase().includes('forwarded'),
    );
    expect(successCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('terminal run resolution clears approvals even when rich delivery falls back to text', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-df2',
      guardianDeliveryChatId: 'guardian-chat-df2',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockRejectedValue(
      new Error('Network error: guardian unreachable'),
    );

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-df-2', terminalStatus: 'failed' });

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'non-guardian-df2-user',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Rich delivery failure alone should not apply an explicit deny decision.
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // Verify the run ID was created
    const runId = orchestrator.realRunId();
    expect(runId).toBeTruthy();

    // This test orchestrator transitions the run to a terminal failed state,
    // which resolves the approval record via run-completion cleanup.
    const pendingApproval = getPendingApprovalForRun(runId!);
    expect(pendingApproval).toBeNull();

    // No unresolved approval should remain after terminal resolution.
    const unresolvedApproval = getUnresolvedApprovalForRun(runId!);
    expect(unresolvedApproval).toBeNull();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20b. Standard rich prompt delivery failure → text fallback (WS-B)
// ═══════════════════════════════════════════════════════════════════════════

describe('standard approval prompt delivery failure → text fallback', () => {
  beforeEach(() => {
  });

  test('standard prompt rich-delivery failure falls back to plain text without auto-deny', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    // Make the approval prompt delivery fail for the standard (self-approval) path
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockRejectedValue(
      new Error('Network error: approval prompt unreachable'),
    );

    // No guardian binding — sender is a guardian (default role), so the
    // standard self-approval path is used.
    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-std-fail', terminalStatus: 'failed' });

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'guardian-std-user',
    });

    // Set up a guardian binding so the sender is recognized as guardian
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-std-user',
      guardianDeliveryChatId: 'chat-123',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(approvalSpy).toHaveBeenCalled();
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    const fallbackCalls = deliverSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'object' &&
        (call[1] as { chatId?: string; text?: string }).chatId === 'chat-123' &&
        ((call[1] as { text?: string }).text ?? '').includes('Reply "yes"'),
    );
    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. Guardian decision scoping — callback for older run resolves correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian decision scoping — multiple pending approvals', () => {
  beforeEach(() => {
  });

  test('callback for older run resolves to the correct approval request', async () => {
    // Set up a guardian binding so the guardian actor role is recognized
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-scope-user',
      guardianDeliveryChatId: 'guardian-scope-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Create two approval requests for different runs, both targeting the
    // same guardian chat. The older run (run-older) was created first.
    const olderConvId = 'conv-scope-older';
    const newerConvId = 'conv-scope-newer';
    ensureConversation(olderConvId);
    ensureConversation(newerConvId);

    const olderRun = createRun(olderConvId);
    setRunConfirmation(olderRun.id, sampleConfirmation);
    createApprovalRequest({
      runId: olderRun.id,
      conversationId: olderConvId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-a',
      requesterChatId: 'chat-requester-a',
      guardianExternalUserId: 'guardian-scope-user',
      guardianChatId: 'guardian-scope-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const newerRun = createRun(newerConvId);
    setRunConfirmation(newerRun.id, sampleConfirmation);
    createApprovalRequest({
      runId: newerRun.id,
      conversationId: newerConvId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-b',
      requesterChatId: 'chat-requester-b',
      guardianExternalUserId: 'guardian-scope-user',
      guardianChatId: 'guardian-scope-chat',
      toolName: 'browser',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // The guardian clicks the approval button for the OLDER run
    const req = makeInboundRequest({
      content: '',
      externalChatId: 'guardian-scope-chat',
      callbackData: `apr:${olderRun.id}:approve_once`,
      senderExternalUserId: 'guardian-scope-user',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // The older run's approval should have been resolved
    const olderApproval = getPendingApprovalForRun(olderRun.id);
    expect(olderApproval).toBeNull();

    // The newer run's approval should still be pending (untouched)
    const newerApproval = getPendingApprovalForRun(newerRun.id);
    expect(newerApproval).not.toBeNull();
    expect(newerApproval!.status).toBe('pending');

    // Verify the decision was applied to the correct (older) run's conversation
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(olderRun.id, 'allow');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. Ambiguous plain-text decision with multiple pending requests
// ═══════════════════════════════════════════════════════════════════════════

describe('ambiguous plain-text decision with multiple pending requests', () => {
  beforeEach(() => {
  });

  test('does not apply plain-text decision to wrong run when multiple pending', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-ambig-user',
      guardianDeliveryChatId: 'guardian-ambig-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Create two pending approval requests targeting the same guardian chat
    const convA = 'conv-ambig-a';
    const convB = 'conv-ambig-b';
    ensureConversation(convA);
    ensureConversation(convB);

    const runA = createRun(convA);
    setRunConfirmation(runA.id, sampleConfirmation);
    createApprovalRequest({
      runId: runA.id,
      conversationId: convA,
      channel: 'telegram',
      requesterExternalUserId: 'requester-x',
      requesterChatId: 'chat-requester-x',
      guardianExternalUserId: 'guardian-ambig-user',
      guardianChatId: 'guardian-ambig-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const runB = createRun(convB);
    setRunConfirmation(runB.id, sampleConfirmation);
    createApprovalRequest({
      runId: runB.id,
      conversationId: convB,
      channel: 'telegram',
      requesterExternalUserId: 'requester-y',
      requesterChatId: 'chat-requester-y',
      guardianExternalUserId: 'guardian-ambig-user',
      guardianChatId: 'guardian-ambig-chat',
      toolName: 'browser',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // Conversational engine that returns keep_pending for disambiguation
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'You have 2 pending requests. Which one?',
    }));

    // Guardian sends plain-text "yes" — ambiguous because two approvals are pending.
    // The conversational engine handles disambiguation by returning keep_pending.
    const req = makeInboundRequest({
      content: 'yes',
      externalChatId: 'guardian-ambig-chat',
      senderExternalUserId: 'guardian-ambig-user',
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // Neither approval should have been resolved — disambiguation was required
    const approvalA = getPendingApprovalForRun(runA.id);
    const approvalB = getPendingApprovalForRun(runB.id);
    expect(approvalA).not.toBeNull();
    expect(approvalB).not.toBeNull();

    // submitDecision should NOT have been called — no decision was applied
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // The conversational engine should have been called with both pending approvals
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<string, unknown>;
    expect((engineCtx.pendingApprovals as Array<unknown>)).toHaveLength(2);

    // A disambiguation reply should have been sent to the guardian
    const disambigCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('pending'),
    );
    expect(disambigCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23. Expired guardian approval auto-denies and transitions to terminal status
// ═══════════════════════════════════════════════════════════════════════════

describe('expired guardian approval auto-denies via sweep', () => {
  beforeEach(() => {
  });

  test('sweepExpiredGuardianApprovals auto-denies and notifies both parties', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Create a guardian approval that is already expired
    const convId = 'conv-expiry-sweep';
    ensureConversation(convId);

    const run = createRun(convId);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: convId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-exp',
      requesterChatId: 'chat-requester-exp',
      guardianExternalUserId: 'guardian-exp-user',
      guardianChatId: 'guardian-exp-chat',
      toolName: 'shell',
      expiresAt: Date.now() - 1000, // already expired
    });

    const orchestrator = makeMockOrchestrator();

    // Run the sweep — pass the gateway base URL (not a full /deliver/<channel> URL)
    sweepExpiredGuardianApprovals(orchestrator, 'https://gateway.test', 'token');

    // Wait for async notifications
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The run should have been denied
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    // The approval should no longer be pending
    const pendingApproval = getPendingApprovalForRun(run.id);
    expect(pendingApproval).toBeNull();

    // There should be no unresolved approval — it was set to 'expired'
    const unresolvedApproval = getUnresolvedApprovalForRun(run.id);
    expect(unresolvedApproval).toBeNull();

    // Both requester and guardian should have been notified
    const requesterNotify = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { chatId?: string }).chatId === 'chat-requester-exp' &&
        (call[1] as { text?: string }).text?.includes('expired'),
    );
    expect(requesterNotify.length).toBeGreaterThanOrEqual(1);

    const guardianNotify = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { chatId?: string }).chatId === 'guardian-exp-chat' &&
        (call[1] as { text?: string }).text?.includes('expired'),
    );
    expect(guardianNotify.length).toBeGreaterThanOrEqual(1);

    // Verify the delivery URL is constructed per-channel (telegram in this case)
    const allDeliverCalls = deliverSpy.mock.calls;
    for (const call of allDeliverCalls) {
      expect(call[0]).toBe('https://gateway.test/deliver/telegram');
    }

    deliverSpy.mockRestore();
  });

  test('non-expired approvals are not affected by the sweep', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const convId = 'conv-not-expired';
    ensureConversation(convId);

    const run = createRun(convId);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: convId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-ne',
      requesterChatId: 'chat-requester-ne',
      guardianExternalUserId: 'guardian-ne-user',
      guardianChatId: 'guardian-ne-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000, // still valid
    });

    const orchestrator = makeMockOrchestrator();

    sweepExpiredGuardianApprovals(orchestrator, 'https://gateway.test', 'token');

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The approval should still be pending
    const pendingApproval = getPendingApprovalForRun(run.id);
    expect(pendingApproval).not.toBeNull();
    expect(pendingApproval!.status).toBe('pending');

    // submitDecision should NOT have been called
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 24. Deliver-once idempotency guard
// ═══════════════════════════════════════════════════════════════════════════

describe('deliver-once idempotency guard', () => {
  test('claimRunDelivery returns true on first call, false on subsequent calls', () => {
    const runId = 'run-idem-unit';
    expect(channelDeliveryStore.claimRunDelivery(runId)).toBe(true);
    expect(channelDeliveryStore.claimRunDelivery(runId)).toBe(false);
    expect(channelDeliveryStore.claimRunDelivery(runId)).toBe(false);
    channelDeliveryStore.resetRunDeliveryClaim(runId);
  });

  test('different run IDs are independent', () => {
    expect(channelDeliveryStore.claimRunDelivery('run-a')).toBe(true);
    expect(channelDeliveryStore.claimRunDelivery('run-b')).toBe(true);
    expect(channelDeliveryStore.claimRunDelivery('run-a')).toBe(false);
    expect(channelDeliveryStore.claimRunDelivery('run-b')).toBe(false);
    channelDeliveryStore.resetRunDeliveryClaim('run-a');
    channelDeliveryStore.resetRunDeliveryClaim('run-b');
  });

  test('resetRunDeliveryClaim allows re-claim', () => {
    const runId = 'run-idem-reset';
    expect(channelDeliveryStore.claimRunDelivery(runId)).toBe(true);
    channelDeliveryStore.resetRunDeliveryClaim(runId);
    expect(channelDeliveryStore.claimRunDelivery(runId)).toBe(true);
    channelDeliveryStore.resetRunDeliveryClaim(runId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 25. Final reply idempotency — main poll wins vs post-decision poll wins
// ═══════════════════════════════════════════════════════════════════════════

describe('final reply idempotency — no duplicate delivery', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('main poll wins: deliverChannelReply called exactly once when main poll delivers first', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init' });
    const orchestrator = makeMockOrchestrator();
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run and add an assistant message for delivery
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);
    conversationStore.addMessage(conversationId!, 'assistant', 'Main poll result.');

    // Orchestrator: first getRun returns needs_confirmation (to trigger
    // approval prompt delivery in the poll), subsequent calls return
    // completed so the main poll can deliver the reply.
    let getRunCount = 0;
    const racingOrchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        getRunCount++;
        if (getRunCount <= 1) {
          return {
            id: run.id,
            conversationId: conversationId!,
            messageId: null,
            status: 'needs_confirmation' as const,
            pendingConfirmation: sampleConfirmation,
            pendingSecret: null,
            inputTokens: 0, outputTokens: 0, estimatedCost: 0,
            error: null,
            createdAt: Date.now(), updatedAt: Date.now(),
          };
        }
        return {
          id: run.id,
          conversationId: conversationId!,
          messageId: null,
          status: 'completed' as const,
          pendingConfirmation: null,
          pendingSecret: null,
          inputTokens: 0, outputTokens: 0, estimatedCost: 0,
          error: null,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
      }),
      startRun: mock(async () => ({
        id: run.id,
        conversationId: conversationId!,
        messageId: null,
        status: 'running' as const,
        pendingConfirmation: null,
        pendingSecret: null,
        inputTokens: 0, outputTokens: 0, estimatedCost: 0,
        error: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      })),
    } as unknown as RunOrchestrator;

    deliverSpy.mockClear();

    // Send a message that triggers the approval path, then send a decision
    // to trigger the post-decision poll. Both pollers should compete for delivery.
    const msgReq = makeInboundRequest({ content: 'do something' });
    await handleChannelInbound(msgReq, noopProcessMessage, 'token', racingOrchestrator);

    // Send the decision to start the post-decision delivery poll
    const decisionReq = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });
    await handleChannelInbound(decisionReq, noopProcessMessage, 'token', racingOrchestrator);

    // Wait for both pollers to finish
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Count deliverChannelReply calls that carry the assistant reply text.
    // Approval-related notifications (e.g. "has been sent to the guardian")
    // are separate from the final reply. The final reply call is the one
    // that delivers the actual conversation content.
    const replyDeliveryCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { text?: string }).text === 'Main poll result.',
    );

    // The guard should ensure at most one delivery of the final reply
    expect(replyDeliveryCalls.length).toBeLessThanOrEqual(1);

    deliverSpy.mockRestore();
  });

  test('post-decision poll wins: delivers exactly once when main poll already exited', async () => {
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation
    const initReq = makeInboundRequest({ content: 'init-late' });
    const orchestrator = makeMockOrchestrator();
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);
    conversationStore.addMessage(conversationId!, 'assistant', 'Post-decision result.');

    // Orchestrator: getRun always returns needs_confirmation for the main poll
    // (so the main poll times out without delivering), then returns completed
    // for the post-decision poll. We use a separate call counter per context.
    let mainPollExited = false;
    let postDecisionGetRunCount = 0;
    const lateOrchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        if (!mainPollExited) {
          // Main poll context — always return needs_confirmation so it exits
          // without delivering (the 5min timeout is simulated by having the
          // main poll see needs_confirmation until it gives up).
          return {
            id: run.id,
            conversationId: conversationId!,
            messageId: null,
            status: 'needs_confirmation' as const,
            pendingConfirmation: sampleConfirmation,
            pendingSecret: null,
            inputTokens: 0, outputTokens: 0, estimatedCost: 0,
            error: null,
            createdAt: Date.now(), updatedAt: Date.now(),
          };
        }
        // Post-decision poll — return completed after a short delay
        postDecisionGetRunCount++;
        if (postDecisionGetRunCount <= 1) {
          return {
            id: run.id,
            conversationId: conversationId!,
            messageId: null,
            status: 'needs_confirmation' as const,
            pendingConfirmation: null,
            pendingSecret: null,
            inputTokens: 0, outputTokens: 0, estimatedCost: 0,
            error: null,
            createdAt: Date.now(), updatedAt: Date.now(),
          };
        }
        return {
          id: run.id,
          conversationId: conversationId!,
          messageId: null,
          status: 'completed' as const,
          pendingConfirmation: null,
          pendingSecret: null,
          inputTokens: 0, outputTokens: 0, estimatedCost: 0,
          error: null,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
      }),
      startRun: mock(async () => ({
        id: run.id,
        conversationId: conversationId!,
        messageId: null,
        status: 'running' as const,
        pendingConfirmation: null,
        pendingSecret: null,
        inputTokens: 0, outputTokens: 0, estimatedCost: 0,
        error: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      })),
    } as unknown as RunOrchestrator;

    deliverSpy.mockClear();

    // Start the main poll — it will see needs_confirmation and exit after
    // the first poll interval (marking the event as processed, not delivering).
    const msgReq = makeInboundRequest({ content: 'do something late' });
    await handleChannelInbound(msgReq, noopProcessMessage, 'token', lateOrchestrator);

    // Wait for the main poll to see needs_confirmation and mark processed
    await new Promise((resolve) => setTimeout(resolve, 800));
    mainPollExited = true;

    // Now send the decision to trigger the post-decision delivery
    const decisionReq = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });
    await handleChannelInbound(decisionReq, noopProcessMessage, 'token', lateOrchestrator);

    // Wait for the post-decision poll to deliver
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Count deliveries of the final assistant reply
    const replyDeliveryCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { text?: string }).text === 'Post-decision result.',
    );

    // Exactly one delivery should have occurred (from the post-decision poll)
    expect(replyDeliveryCalls.length).toBe(1);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 26. Assistant-scoped guardian verification via handleChannelInbound
// ═══════════════════════════════════════════════════════════════════════════

describe('assistant-scoped guardian verification via handleChannelInbound', () => {
  test('/guardian_verify uses the threaded assistantId (default: self)', async () => {
    const { createVerificationChallenge } = await import('../runtime/channel-guardian-service.js');
    const { secret } = createVerificationChallenge('self', 'telegram');

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: `/guardian_verify ${secret}`,
      senderExternalUserId: 'user-default-asst',
    });

    // No assistantId passed => defaults to 'self'
    const res = await handleChannelInbound(req, noopProcessMessage, 'token');
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.guardianVerification).toBe('verified');

    deliverSpy.mockRestore();
  });

  test('/guardian_verify with explicit assistantId resolves against that assistant', async () => {
    const { createVerificationChallenge } = await import('../runtime/channel-guardian-service.js');
    const { getGuardianBinding } = await import('../runtime/channel-guardian-service.js');

    // Create a challenge for asst-route-X
    const { secret } = createVerificationChallenge('asst-route-X', 'telegram');

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: `/guardian_verify ${secret}`,
      senderExternalUserId: 'user-for-asst-x',
    });

    // Pass assistantId = 'asst-route-X'
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', undefined, 'asst-route-X');
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.guardianVerification).toBe('verified');

    // Binding should exist for asst-route-X, not for 'self'
    const bindingX = getGuardianBinding('asst-route-X', 'telegram');
    expect(bindingX).not.toBeNull();
    expect(bindingX!.guardianExternalUserId).toBe('user-for-asst-x');

    deliverSpy.mockRestore();
  });

  test('cross-assistant challenge verification fails', async () => {
    const { createVerificationChallenge } = await import('../runtime/channel-guardian-service.js');

    // Create challenge for asst-A
    const { secret } = createVerificationChallenge('asst-A-cross', 'telegram');

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: `/guardian_verify ${secret}`,
      senderExternalUserId: 'user-cross-test',
    });

    // Try to verify using asst-B — should fail because the challenge is for asst-A
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', undefined, 'asst-B-cross');
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.guardianVerification).toBe('failed');

    deliverSpy.mockRestore();
  });

  test('actor role resolution uses threaded assistantId', async () => {

    // Create guardian binding for asst-role-X
    createBinding({
      assistantId: 'asst-role-X',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-role-user',
      guardianDeliveryChatId: 'guardian-role-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-role-scoped', terminalStatus: 'completed' });

    // Non-guardian user sending to asst-role-X should be recognized as non-guardian
    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'non-guardian-role-user',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator, 'asst-role-X');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The approval prompt should have been sent to the guardian's chat
    expect(approvalSpy).toHaveBeenCalled();
    const approvalArgs = approvalSpy.mock.calls[0];
    expect(approvalArgs[1]).toBe('guardian-role-chat');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('same user is guardian for one assistant but not another', async () => {

    // user-multi is guardian for asst-M1 but not asst-M2
    createBinding({
      assistantId: 'asst-M1',
      channel: 'telegram',
      guardianExternalUserId: 'user-multi',
      guardianDeliveryChatId: 'chat-multi',
    });
    createBinding({
      assistantId: 'asst-M2',
      channel: 'telegram',
      guardianExternalUserId: 'user-other-guardian',
      guardianDeliveryChatId: 'chat-other-guardian',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    // For asst-M1: user-multi is the guardian, so should get standard self-approval
    const orch1 = makeSensitiveOrchestrator({ runId: 'run-m1', terminalStatus: 'completed' });
    const req1 = makeInboundRequest({
      content: 'dangerous action',
      senderExternalUserId: 'user-multi',
    });

    await handleChannelInbound(req1, noopProcessMessage, 'token', orch1, 'asst-M1');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // For asst-M1, user-multi is guardian — approval prompt to own chat (standard flow)
    expect(approvalSpy).toHaveBeenCalled();
    const m1ApprovalArgs = approvalSpy.mock.calls[0];
    // Should be sent to user-multi's own chat (chat-123 from makeInboundRequest default)
    expect(m1ApprovalArgs[1]).toBe('chat-123');

    approvalSpy.mockClear();
    deliverSpy.mockClear();

    // For asst-M2: user-multi is NOT the guardian, so approval should route to asst-M2's guardian
    const orch2 = makeSensitiveOrchestrator({ runId: 'run-m2', terminalStatus: 'completed' });
    const req2 = makeInboundRequest({
      content: 'another dangerous action',
      senderExternalUserId: 'user-multi',
    });

    await handleChannelInbound(req2, noopProcessMessage, 'token', orch2, 'asst-M2');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // For asst-M2, user-multi is non-guardian — approval should go to user-other-guardian's chat
    expect(approvalSpy).toHaveBeenCalled();
    const m2ApprovalArgs = approvalSpy.mock.calls[0];
    expect(m2ApprovalArgs[1]).toBe('chat-other-guardian');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('non-self assistant inbound does not mutate assistant-agnostic external bindings', async () => {
    const db = getDb();
    const now = Date.now();
    ensureConversation('conv-existing-binding');
    db.insert(externalConversationBindings).values({
      conversationId: 'conv-existing-binding',
      sourceChannel: 'telegram',
      externalChatId: 'chat-123',
      externalUserId: 'existing-user',
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
    }).run();

    const req = makeInboundRequest({
      content: 'hello from non-self assistant',
      senderExternalUserId: 'incoming-user',
    });

    const res = await handleChannelInbound(req, undefined, 'token', undefined, 'asst-non-self');
    expect(res.status).toBe(200);

    const binding = db
      .select()
      .from(externalConversationBindings)
      .where(eq(externalConversationBindings.conversationId, 'conv-existing-binding'))
      .get();
    expect(binding).not.toBeNull();
    expect(binding!.externalUserId).toBe('existing-user');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 27. Guardian enforcement behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian enforcement behavior', () => {
  test('guardian sender on telegram uses approval-aware path', async () => {

    // Default senderExternalUserId in makeInboundRequest is telegram-user-default.
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });

    const processSpy = mock(async () => ({ messageId: 'msg-bg-guardian' }));
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-guardian-flag-off-telegram',
      terminalStatus: 'completed',
    });

    const req = makeInboundRequest({
      content: 'place a call',
      senderExternalUserId: 'telegram-user-default',
      sourceChannel: 'telegram',
    });

    const res = await handleChannelInbound(req, processSpy, 'token', orchestrator);
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Regression guard: this must use the orchestrator approval path, not
    // fire-and-forget processMessage, otherwise prompts can time out.
    expect(orchestrator.startRun).toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();

    // Guardian self-approval prompt should be delivered to the requester's chat.
    expect(approvalSpy).toHaveBeenCalled();

    approvalSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test('non-guardian sensitive action routes approval to guardian', async () => {
    // Create a guardian binding — user-guardian is the guardian
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'user-guardian',
      guardianDeliveryChatId: 'chat-guardian',
    });

    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-flag-off-guardian', terminalStatus: 'completed' });
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'user-non-guardian',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(approvalSpy).toHaveBeenCalled();
    const approvalArgs = approvalSpy.mock.calls[0];
    expect(approvalArgs[1]).toBe('chat-guardian');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('missing senderExternalUserId with guardian binding fails closed', async () => {

    // Create a guardian binding — guardian enforcement is active
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'user-guardian',
      guardianDeliveryChatId: 'chat-guardian',
    });

    // Use makeSensitiveOrchestrator so that getRun returns needs_confirmation
    // on the first poll (triggering the unverified_channel auto-deny path)
    // and then returns terminal state.
    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-failclosed-1', terminalStatus: 'failed' });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    // Send a message WITHOUT senderExternalUserId
    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: undefined,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    expect(res.status).toBe(200);

    // Wait for background processing
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The unknown actor should be treated as unverified_channel and denied,
    // with context passed into the tool-denial response for assistant phrasing.
    const submitCalls = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls;
    expect(submitCalls.length).toBeGreaterThanOrEqual(1);
    const lastDecision = submitCalls[submitCalls.length - 1];
    expect(lastDecision[1]).toBe('deny');
    expect(typeof lastDecision[2]).toBe('string');
    expect((lastDecision[2] as string).toLowerCase()).toContain('identity');

    // No separate deterministic denial notice should be emitted here.
    const denialCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object'
        && ((call[1] as { text?: string }).text ?? '').toLowerCase().includes('identity'),
    );
    expect(denialCalls.length).toBe(0);

    // Auto-deny path should never prompt for approval
    expect(approvalSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('missing senderExternalUserId without guardian binding fails closed', async () => {

    // No guardian binding exists, but identity is missing — treat sender as
    // unverified_channel and auto-deny sensitive actions.
    const orchestrator = makeSensitiveOrchestrator({ runId: 'run-failclosed-noid-nobinding', terminalStatus: 'failed' });
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: undefined,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const submitCalls = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls;
    expect(submitCalls.length).toBeGreaterThanOrEqual(1);
    const lastDecision = submitCalls[submitCalls.length - 1];
    expect(lastDecision[1]).toBe('deny');
    expect(typeof lastDecision[2]).toBe('string');
    expect((lastDecision[2] as string).toLowerCase()).toContain('identity');

    const denialCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object'
        && ((call[1] as { text?: string }).text ?? '').toLowerCase().includes('identity'),
    );
    expect(denialCalls.length).toBe(0);
    expect(approvalSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 28. Gateway-origin proof hardening — dedicated secret support
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyGatewayOrigin with dedicated gateway-origin secret', () => {
  function makeReqWithHeader(value?: string): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (value !== undefined) {
      headers['X-Gateway-Origin'] = value;
    }
    return new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers,
      body: '{}',
    });
  }

  test('returns true when no secrets configured (local dev)', () => {
    expect(verifyGatewayOrigin(makeReqWithHeader(), undefined, undefined)).toBe(true);
  });

  test('falls back to bearerToken when no dedicated secret is set', () => {
    expect(verifyGatewayOrigin(makeReqWithHeader('my-bearer'), 'my-bearer', undefined)).toBe(true);
    expect(verifyGatewayOrigin(makeReqWithHeader('wrong'), 'my-bearer', undefined)).toBe(false);
    expect(verifyGatewayOrigin(makeReqWithHeader(), 'my-bearer', undefined)).toBe(false);
  });

  test('uses dedicated secret when set, ignoring bearer token', () => {
    // Dedicated secret matches — should pass even if bearer token differs
    expect(verifyGatewayOrigin(makeReqWithHeader('dedicated-secret'), 'bearer-token', 'dedicated-secret')).toBe(true);
    // Bearer token matches but dedicated secret doesn't — should fail
    expect(verifyGatewayOrigin(makeReqWithHeader('bearer-token'), 'bearer-token', 'dedicated-secret')).toBe(false);
  });

  test('validates dedicated secret even when bearer token is not configured', () => {
    // No bearer token but dedicated secret is set — should validate against it
    expect(verifyGatewayOrigin(makeReqWithHeader('my-secret'), undefined, 'my-secret')).toBe(true);
    expect(verifyGatewayOrigin(makeReqWithHeader('wrong'), undefined, 'my-secret')).toBe(false);
  });

  test('rejects missing header when any secret is configured', () => {
    expect(verifyGatewayOrigin(makeReqWithHeader(), 'bearer', undefined)).toBe(false);
    expect(verifyGatewayOrigin(makeReqWithHeader(), undefined, 'secret')).toBe(false);
    expect(verifyGatewayOrigin(makeReqWithHeader(), 'bearer', 'secret')).toBe(false);
  });

  test('rejects mismatched length headers (constant-time comparison guard)', () => {
    // Different lengths should be rejected without timing leaks
    expect(verifyGatewayOrigin(makeReqWithHeader('short'), 'a-much-longer-secret', undefined)).toBe(false);
    expect(verifyGatewayOrigin(makeReqWithHeader('a-much-longer-secret'), 'short', undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 29. handleChannelInbound passes gatewayOriginSecret to verifyGatewayOrigin
// ═══════════════════════════════════════════════════════════════════════════

describe('handleChannelInbound gatewayOriginSecret integration', () => {
  test('rejects request when bearer token matches but dedicated secret does not', async () => {
    const bearerToken = 'my-bearer';
    const gatewaySecret = 'dedicated-gw-secret';

    // Request carries the bearer token as X-Gateway-Origin, but the
    // dedicated secret is configured — verifyGatewayOrigin should require
    // the dedicated secret, not the bearer token.
    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': bearerToken,
      },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        externalChatId: 'chat-gw-secret-test',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: 'hello',
      }),
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, bearerToken, undefined, 'self', gatewaySecret,
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('GATEWAY_ORIGIN_REQUIRED');
  });

  test('accepts request when dedicated secret matches', async () => {
    const bearerToken = 'my-bearer';
    const gatewaySecret = 'dedicated-gw-secret';

    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': gatewaySecret,
      },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        externalChatId: 'chat-gw-secret-pass',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: 'hello',
      }),
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, bearerToken, undefined, 'self', gatewaySecret,
    );
    // Should pass the gateway-origin check and proceed to normal processing
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });

  test('falls back to bearer token when no dedicated secret is set', async () => {
    const bearerToken = 'my-bearer';

    const req = new Request('http://localhost/channels/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Origin': bearerToken,
      },
      body: JSON.stringify({
        sourceChannel: 'telegram',
        externalChatId: 'chat-gw-fallback',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: 'hello',
      }),
    });

    // No gatewayOriginSecret (6th param undefined) — should fall back to bearer
    const res = await handleChannelInbound(
      req, noopProcessMessage, bearerToken, undefined, 'self', undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 30. Unknown actor identity — forceStrictSideEffects propagation
// ═══════════════════════════════════════════════════════════════════════════

describe('unknown actor identity — forceStrictSideEffects', () => {
  beforeEach(() => {
  });

  test('unknown sender (no senderExternalUserId) with guardian binding gets forceStrictSideEffects', async () => {
    // Create a guardian binding so the channel is guardian-enforced
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'known-guardian',
      guardianDeliveryChatId: 'guardian-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-unknown-actor',
      conversationId: 'conv-1',
      messageId: null,
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    // Send message with no senderExternalUserId — the unknown actor should
    // be classified as unverified_channel and forceStrictSideEffects set.
    const req = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: undefined,
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // startRun should have been called with forceStrictSideEffects: true
    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    const options = startRunArgs[3] as { forceStrictSideEffects?: boolean } | undefined;
    expect(options).toBeDefined();
    expect(options!.forceStrictSideEffects).toBe(true);

    deliverSpy.mockRestore();
  });

  test('known non-guardian sender with guardian binding gets forceStrictSideEffects', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'the-guardian',
      guardianDeliveryChatId: 'guardian-chat-2',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-nongrd-strict',
      conversationId: 'conv-1',
      messageId: null,
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    // Non-guardian user sends a message
    const req = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: 'not-the-guardian',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // startRun should have been called with forceStrictSideEffects: true
    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    const options = startRunArgs[3] as { forceStrictSideEffects?: boolean } | undefined;
    expect(options).toBeDefined();
    expect(options!.forceStrictSideEffects).toBe(true);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('guardian sender does NOT get forceStrictSideEffects', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'the-guardian',
      guardianDeliveryChatId: 'guardian-chat-3',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-grd-no-strict',
      conversationId: 'conv-1',
      messageId: null,
      status: 'running' as const,
      pendingConfirmation: null,
      pendingSecret: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    // The guardian sends a message — should NOT get forceStrictSideEffects
    const req = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: 'the-guardian',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(orchestrator.startRun).toHaveBeenCalled();
    const startRunArgs = (orchestrator.startRun as ReturnType<typeof mock>).mock.calls[0];
    const options = startRunArgs[3] as { forceStrictSideEffects?: boolean; sourceChannel?: string } | undefined;
    expect(options).toBeDefined();
    // Guardian should NOT have forceStrictSideEffects set
    expect(options!.forceStrictSideEffects).toBeUndefined();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Conversational approval engine — standard path
// ═══════════════════════════════════════════════════════════════════════════

describe('conversational approval engine — standard path', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('non-decision follow-up → engine returns keep_pending → assistant reply sent, run remains pending', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Mock conversational engine that returns keep_pending
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'There is a pending shell command. Would you like to approve or deny it?',
    }));

    const req = makeInboundRequest({ content: 'what does this command do?' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // The engine reply should have been delivered
    expect(deliverSpy).toHaveBeenCalled();
    const replyCall = deliverSpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('pending shell command'),
    );
    expect(replyCall).toBeDefined();

    // The orchestrator should NOT have received a decision
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test('natural-language approval → engine returns approve_once → decision applied', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Mock conversational engine that returns approve_once
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Got it, approving the shell command.',
    }));

    const req = makeInboundRequest({ content: 'yeah go ahead and run it' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // The orchestrator should have received an allow decision
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    // The engine reply should have been delivered
    const replyCall = deliverSpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('approving the shell command'),
    );
    expect(replyCall).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('"nevermind" style message → engine returns reject → rejection applied', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Mock conversational engine that returns reject
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'reject' as const,
      replyText: 'No problem, I\'ve cancelled the shell command.',
    }));

    const req = makeInboundRequest({ content: 'nevermind, don\'t run that' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // The orchestrator should have received a deny decision
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    // The engine reply should have been delivered
    const replyCall = deliverSpy.mock.calls.find(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('cancelled the shell command'),
    );
    expect(replyCall).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('callback button still takes priority even with conversational engine present', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Mock conversational engine — should NOT be called for callback buttons
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'This should not be called',
    }));

    const req = makeInboundRequest({
      content: '',
      callbackData: `apr:${run.id}:approve_once`,
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // The callback button should have been used directly, not the engine
    expect(mockConversationGenerator).not.toHaveBeenCalled();
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardian conversational approval engine tests
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian conversational approval via conversation engine', () => {
  beforeEach(() => {
  });

  test('guardian follow-up clarification: engine returns keep_pending, reply sent, run remains pending', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-conv-user',
      guardianDeliveryChatId: 'guardian-conv-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const convId = 'conv-guardian-clarify';
    ensureConversation(convId);
    const run = createRun(convId);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: convId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-clarify',
      requesterChatId: 'chat-requester-clarify',
      guardianExternalUserId: 'guardian-conv-user',
      guardianChatId: 'guardian-conv-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // Engine returns keep_pending for a clarification question
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'Could you clarify which action you want me to approve?',
    }));

    const req = makeInboundRequest({
      content: 'hmm what does this do?',
      externalChatId: 'guardian-conv-chat',
      senderExternalUserId: 'guardian-conv-user',
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // The engine should have been called with role: 'guardian'
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const callCtx = mockConversationGenerator.mock.calls[0][0] as Record<string, unknown>;
    expect(callCtx.role).toBe('guardian');
    expect(callCtx.allowedActions).toEqual(['approve_once', 'reject']);
    expect(callCtx.userMessage).toBe('hmm what does this do?');

    // Clarification reply delivered to the guardian's chat
    const replyCall = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text === 'Could you clarify which action you want me to approve?',
    );
    expect(replyCall).toBeTruthy();

    // The orchestrator should NOT have received a decision
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // The approval should still be pending
    const pending = getAllPendingApprovalsByGuardianChat('telegram', 'guardian-conv-chat', 'self');
    expect(pending).toHaveLength(1);

    deliverSpy.mockRestore();
  });

  test('guardian natural-language approval: engine returns approve_once, decision applied', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-nlp-user',
      guardianDeliveryChatId: 'guardian-nlp-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const convId = 'conv-guardian-nlp';
    ensureConversation(convId);
    const run = createRun(convId);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: convId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-nlp',
      requesterChatId: 'chat-requester-nlp',
      guardianExternalUserId: 'guardian-nlp-user',
      guardianChatId: 'guardian-nlp-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // Engine returns approve_once decision
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved! The shell command will proceed.',
    }));

    const req = makeInboundRequest({
      content: 'yes go ahead and run it',
      externalChatId: 'guardian-nlp-chat',
      senderExternalUserId: 'guardian-nlp-user',
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // The orchestrator should have received an 'allow' decision
    expect(orchestrator.submitDecision).toHaveBeenCalledTimes(1);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    // The approval record should have been updated (no longer pending)
    const pending = getAllPendingApprovalsByGuardianChat('telegram', 'guardian-nlp-chat', 'self');
    expect(pending).toHaveLength(0);

    // The engine context excluded approve_always for guardians
    const callCtx = mockConversationGenerator.mock.calls[0][0] as Record<string, unknown>;
    expect(callCtx.allowedActions).toEqual(['approve_once', 'reject']);
    expect((callCtx.allowedActions as string[])).not.toContain('approve_always');

    deliverSpy.mockRestore();
  });

  test('guardian callback button approve_always is downgraded to approve_once', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-dg-user',
      guardianDeliveryChatId: 'guardian-dg-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const convId = 'conv-guardian-downgrade';
    ensureConversation(convId);
    const run = createRun(convId);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: convId,
      channel: 'telegram',
      requesterExternalUserId: 'requester-dg',
      requesterChatId: 'chat-requester-dg',
      guardianExternalUserId: 'guardian-dg-user',
      guardianChatId: 'guardian-dg-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // Guardian clicks approve_always via callback button
    const req = makeInboundRequest({
      content: '',
      externalChatId: 'guardian-dg-chat',
      callbackData: `apr:${run.id}:approve_always`,
      senderExternalUserId: 'guardian-dg-user',
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      undefined,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // approve_always should have been downgraded to approve_once ('allow')
    expect(orchestrator.submitDecision).toHaveBeenCalledTimes(1);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('multi-pending guardian disambiguation: engine requests clarification', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-multi-user',
      guardianDeliveryChatId: 'guardian-multi-chat',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const convA = 'conv-multi-a';
    const convB = 'conv-multi-b';
    ensureConversation(convA);
    ensureConversation(convB);

    const runA = createRun(convA);
    setRunConfirmation(runA.id, { ...sampleConfirmation, toolUseId: 'req-multi-a' });

    const runB = createRun(convB);
    setRunConfirmation(runB.id, { ...sampleConfirmation, toolName: 'file_edit', toolUseId: 'req-multi-b' });

    createApprovalRequest({
      runId: runA.id,
      conversationId: convA,
      channel: 'telegram',
      requesterExternalUserId: 'requester-multi-a',
      requesterChatId: 'chat-requester-multi-a',
      guardianExternalUserId: 'guardian-multi-user',
      guardianChatId: 'guardian-multi-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    createApprovalRequest({
      runId: runB.id,
      conversationId: convB,
      channel: 'telegram',
      requesterExternalUserId: 'requester-multi-b',
      requesterChatId: 'chat-requester-multi-b',
      guardianExternalUserId: 'guardian-multi-user',
      guardianChatId: 'guardian-multi-chat',
      toolName: 'file_edit',
      expiresAt: Date.now() + 300_000,
    });

    const orchestrator = makeMockOrchestrator();

    // Engine returns keep_pending for disambiguation
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'You have 2 pending requests: shell and file_edit. Which one?',
    }));

    const req = makeInboundRequest({
      content: 'approve it',
      externalChatId: 'guardian-multi-chat',
      senderExternalUserId: 'guardian-multi-user',
    });

    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');

    // The engine should have received both pending approvals
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<string, unknown>;
    expect((engineCtx.pendingApprovals as Array<unknown>)).toHaveLength(2);
    expect(engineCtx.role).toBe('guardian');

    // Both approvals should remain pending
    const pendingA = getPendingApprovalForRun(runA.id);
    const pendingB = getPendingApprovalForRun(runB.id);
    expect(pendingA).not.toBeNull();
    expect(pendingB).not.toBeNull();

    // submitDecision should NOT have been called
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // Disambiguation reply delivered to guardian
    const disambigCall = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('2 pending requests'),
    );
    expect(disambigCall).toBeTruthy();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// keep_pending must remain conversational (no deterministic fallback)
// ═══════════════════════════════════════════════════════════════════════════

describe('keep_pending remains conversational — standard path', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('explicit "approve" with keep_pending returns assistant_turn and does not auto-decide', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'Before deciding, can you confirm the intent?',
    }));

    const req = makeInboundRequest({ content: 'approve' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    const followupReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('confirm the intent'),
    );
    expect(followupReply).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('keep_pending stays assistant_turn even if pending confirmation disappears mid-turn', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      db.$client.prepare('UPDATE message_runs SET pending_confirmation = NULL WHERE id = ?').run(run.id);
      return {
        disposition: 'keep_pending' as const,
        replyText: 'Looks like that request is no longer pending.',
      };
    });

    const req = makeInboundRequest({ content: 'deny' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    const followupReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('no longer pending'),
    );
    expect(followupReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

describe('keep_pending remains conversational — guardian path', () => {
  test('guardian explicit "yes" with keep_pending returns assistant_turn without applying a decision', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-fb',
      guardianDeliveryChatId: 'guardian-chat-fb',
    });

    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-chat-fb',
      senderExternalUserId: 'requester-user-fb',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-user-fb',
      requesterChatId: 'requester-chat-fb',
      guardianExternalUserId: 'guardian-user-fb',
      guardianChatId: 'guardian-chat-fb',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'Which run are you approving?',
    }));

    const guardianReq = makeInboundRequest({
      content: 'yes',
      externalChatId: 'guardian-chat-fb',
      senderExternalUserId: 'guardian-user-fb',
    });
    const res = await handleChannelInbound(
      guardianReq, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    const followupReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('Which run are you approving'),
    );
    expect(followupReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix: requester cancel of guardian-gated pending request (P2)
// ═══════════════════════════════════════════════════════════════════════════

describe('requester cancel of guardian-gated pending request', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-cancel',
      guardianDeliveryChatId: 'guardian-cancel-chat',
    });
  });

  test('requester explicit "deny" can cancel when the conversation engine returns reject', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Create requester conversation and run
    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Create guardian approval request
    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-cancel-user',
      requesterChatId: 'requester-cancel-chat',
      guardianExternalUserId: 'guardian-cancel',
      guardianChatId: 'guardian-cancel-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'reject' as const,
      replyText: 'Cancelling this request now.',
    }));

    // Requester sends "deny" and the engine classifies it as reject.
    const req = makeInboundRequest({
      content: 'deny',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    // Guardian approval should be resolved
    const approval = getPendingApprovalForRun(run.id);
    expect(approval).toBeNull();

    // Requester should have been notified (cancel notice)
    const requesterReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { chatId?: string }).chatId === 'requester-cancel-chat',
    );
    expect(requesterReply).toBeDefined();

    // Guardian should have been notified of the cancellation
    const guardianNotice = deliverSpy.mock.calls.find(
      (call) => (call[1] as { chatId?: string }).chatId === 'guardian-cancel-chat',
    );
    expect(guardianNotice).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester "nevermind" via conversational engine cancels guardian-gated request', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-cancel-user',
      requesterChatId: 'requester-cancel-chat',
      guardianExternalUserId: 'guardian-cancel',
      guardianChatId: 'guardian-cancel-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Conversational engine recognises cancel intent and returns reject
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'reject' as const,
      replyText: 'OK, I have cancelled the pending request.',
    }));

    const req = makeInboundRequest({
      content: 'actually never mind, cancel it',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    // Engine should have been called with reject-only allowed actions
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<string, unknown>;
    expect(engineCtx.allowedActions).toEqual(['reject']);

    // Engine reply should have been delivered to requester
    const replyCall = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('cancelled the pending request'),
    );
    expect(replyCall).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester cancel returns stale_ignored when pending disappears before apply', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-cancel-race-chat',
      senderExternalUserId: 'requester-cancel-race-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-cancel-race-user',
      requesterChatId: 'requester-cancel-race-chat',
      guardianExternalUserId: 'guardian-cancel',
      guardianChatId: 'guardian-cancel-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      db.$client.prepare('UPDATE message_runs SET pending_confirmation = NULL WHERE id = ?').run(run.id);
      return {
        disposition: 'reject' as const,
        replyText: 'Cancelling that now.',
      };
    });

    const req = makeInboundRequest({
      content: 'never mind cancel',
      externalChatId: 'requester-cancel-race-chat',
      senderExternalUserId: 'requester-cancel-race-user',
    });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    const staleReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('already been resolved'),
    );
    expect(staleReply).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester non-cancel message with keep_pending returns conversational reply', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-cancel-user',
      requesterChatId: 'requester-cancel-chat',
      guardianExternalUserId: 'guardian-cancel',
      guardianChatId: 'guardian-cancel-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Engine returns keep_pending (not a cancel intent)
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: 'keep_pending' as const,
      replyText: 'Still waiting.',
    }));

    const req = makeInboundRequest({
      content: 'what is happening?',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('assistant_turn');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // Should have received the conversational keep_pending reply
    const pendingReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('Still waiting.'),
    );
    expect(pendingReply).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester "approve" is blocked — self-approval not allowed even during cancel check', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-cancel-user',
      requesterChatId: 'requester-cancel-chat',
      guardianExternalUserId: 'guardian-cancel',
      guardianChatId: 'guardian-cancel-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Requester tries to self-approve while guardian approval is pending.
    // Self-approval stays blocked in the requester-cancel path.
    const req = makeInboundRequest({
      content: 'approve',
      externalChatId: 'requester-cancel-chat',
      senderExternalUserId: 'requester-cancel-user',
    });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should get the guardian-pending notice, NOT decision_applied
    expect(body.approval).toBe('assistant_turn');
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix: stale_ignored when engine decision races with concurrent resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('engine decision race condition — standard path', () => {
  beforeEach(() => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'telegram-user-default',
      guardianDeliveryChatId: 'chat-123',
    });
  });

  test('returns stale_ignored when engine approves but run was already resolved', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    deliverSpy.mockClear();

    // Engine returns approve_once, but clears the pending confirmation
    // before handleChannelDecision is called (simulating race condition)
    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      db.$client.prepare('UPDATE message_runs SET pending_confirmation = NULL WHERE id = ?').run(run.id);
      return {
        disposition: 'approve_once' as const,
        replyText: 'Approved! Running the command now.',
      };
    });

    const req = makeInboundRequest({ content: 'go ahead' });
    const res = await handleChannelInbound(
      req, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');

    // submitDecision should NOT have been called since there was no pending
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // The engine's optimistic "Approved!" reply should NOT have been delivered
    const approvedReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('Approved!'),
    );
    expect(approvedReply).toBeUndefined();

    // A stale notice should have been delivered instead
    const staleReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('already been resolved'),
    );
    expect(staleReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

describe('engine decision race condition — guardian path', () => {
  test('returns stale_ignored when guardian engine approves but run was already resolved', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-race-user',
      guardianDeliveryChatId: 'guardian-race-chat',
    });

    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeInboundRequest({
      content: 'init',
      externalChatId: 'requester-race-chat',
      senderExternalUserId: 'requester-race-user',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    createApprovalRequest({
      runId: run.id,
      conversationId: conversationId!,
      assistantId: 'self',
      channel: 'telegram',
      requesterExternalUserId: 'requester-race-user',
      requesterChatId: 'requester-race-chat',
      guardianExternalUserId: 'guardian-race-user',
      guardianChatId: 'guardian-race-chat',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Guardian engine returns approve_once, but clears pending confirmation
    // to simulate a concurrent resolution (expiry sweep or requester cancel)
    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      db.$client.prepare('UPDATE message_runs SET pending_confirmation = NULL WHERE id = ?').run(run.id);
      return {
        disposition: 'approve_once' as const,
        replyText: 'Approved the request.',
      };
    });

    const guardianReq = makeInboundRequest({
      content: 'approve it',
      externalChatId: 'guardian-race-chat',
      senderExternalUserId: 'guardian-race-user',
    });
    const res = await handleChannelInbound(
      guardianReq, noopProcessMessage, 'token', orchestrator, 'self', undefined, undefined,
      mockConversationGenerator,
    );
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');

    // submitDecision should NOT have been called
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // The engine's "Approved the request." should NOT be delivered
    const optimisticReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('Approved the request'),
    );
    expect(optimisticReply).toBeUndefined();

    // A stale notice should have been delivered instead
    const staleReply = deliverSpy.mock.calls.find(
      (call) => (call[1] as { text?: string }).text?.includes('already been resolved'),
    );
    expect(staleReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});
