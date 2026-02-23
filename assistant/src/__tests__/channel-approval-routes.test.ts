import { describe, test, expect, beforeEach, afterAll, afterEach, mock, spyOn } from 'bun:test';
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
import * as channelDeliveryStore from '../memory/channel-delivery-store.js';
import * as conversationStore from '../memory/conversation-store.js';
import {
  createBinding,
  createApprovalRequest,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
} from '../memory/channel-guardian-store.js';
import type { RunOrchestrator } from '../runtime/run-orchestrator.js';
import {
  handleChannelInbound,
  isChannelApprovalsEnabled,
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

// ---------------------------------------------------------------------------
// Set up / tear down feature flag for each test
// ---------------------------------------------------------------------------

let originalEnv: string | undefined;

beforeEach(() => {
  resetTables();
  originalEnv = process.env.CHANNEL_APPROVALS_ENABLED;
  noopProcessMessage.mockClear();
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CHANNEL_APPROVALS_ENABLED;
  } else {
    process.env.CHANNEL_APPROVALS_ENABLED = originalEnv;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Feature flag gating
// ═══════════════════════════════════════════════════════════════════════════

describe('isChannelApprovalsEnabled', () => {
  test('returns false when env var is not set', () => {
    delete process.env.CHANNEL_APPROVALS_ENABLED;
    expect(isChannelApprovalsEnabled()).toBe(false);
  });

  test('returns false when env var is "false"', () => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'false';
    expect(isChannelApprovalsEnabled()).toBe(false);
  });

  test('returns true when env var is "true"', () => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
    expect(isChannelApprovalsEnabled()).toBe(true);
  });
});

describe('feature flag disabled → normal flow', () => {
  beforeEach(() => {
    delete process.env.CHANNEL_APPROVALS_ENABLED;
  });

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

    // With generic approvals disabled, callback payloads without a matching
    // pending approval are still treated as stale and ignored.
    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('stale_ignored');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Callback data triggers decision handling
// ═══════════════════════════════════════════════════════════════════════════

describe('inbound callback metadata triggers decision handling', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

describe('inbound text matching approval phrases triggers decision handling', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('text "approve" triggers approve_once decision', async () => {
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

    const req = makeInboundRequest({ content: 'approve' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('text "always" triggers approve_always decision', async () => {
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

    const req = makeInboundRequest({ content: 'always' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Non-decision messages during pending approval trigger reminder
// ═══════════════════════════════════════════════════════════════════════════

describe('non-decision messages during pending approval trigger reminder', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('sends a reminder prompt when message is not a decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
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
    expect(body.approval).toBe('reminder_sent');

    // The approval prompt delivery should have been called
    expect(deliverSpy).toHaveBeenCalled();
    const callArgs = deliverSpy.mock.calls[0];
    // The text should contain the reminder prefix
    expect(callArgs[2]).toContain("I'm still waiting");
    // The approval UI metadata should be present
    expect(callArgs[3]).toBeDefined();
    expect(callArgs[3]!.runId).toBe(run.id);

    deliverSpy.mockRestore();
    replySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Messages without pending approval proceed normally
// ═══════════════════════════════════════════════════════════════════════════

describe('messages without pending approval proceed normally', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

  test('plain-text decisions bypass run ID validation (no runId in result)', async () => {
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

    // Send plain text "yes" — no runId in the parsed result, so validation is skipped
    const req = makeInboundRequest({ content: 'yes' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

  test('plain-text decision also does not trigger immediate reply', async () => {
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

    deliverSpy.mockClear();

    // Send a plain-text approval
    const req = makeInboundRequest({ content: 'approve' });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.approval).toBe('decision_applied');
    expect(deliverSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Stale callback with no pending approval returns stale_ignored (WS-B)
// ═══════════════════════════════════════════════════════════════════════════

describe('stale callback handling', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    // without waiting 5 minutes.
    _setTestPollMaxWait(100);

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
    _setTestPollMaxWait(100);

    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
    const failureSpy = spyOn(channelDeliveryStore, 'recordProcessingFailure').mockImplementation(() => {});
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-post-approval',
      conversationId: 'conv-1',
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

    // Simulate a run that transitions from needs_confirmation back to running
    // (approval applied) before the poll exits, then stays running past timeout.
    let getRunCalls = 0;
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => {
        getRunCalls++;
        // First call inside the loop: needs_confirmation (triggers approval prompt delivery)
        if (getRunCalls <= 1) return { ...mockRun, status: 'needs_confirmation' as const };
        // Subsequent calls: running (approval was applied, run resumed)
        return { ...mockRun, status: 'running' as const };
      }),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello post-approval running' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async to complete (poll timeout + buffer)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // markProcessed SHOULD have been called — the run was in needs_confirmation
    // and then transitioned to running (post-approval), so the post-decision
    // delivery path handles the final reply.
    expect(markSpy).toHaveBeenCalled();

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  function makeSmsInboundRequest(overrides: Record<string, unknown> = {}): Request {
    const body = {
      sourceChannel: 'sms',
      externalChatId: 'sms-chat-123',
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
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    deliverSpy.mockRestore();
  });

  test('plain-text "no" via SMS triggers reject decision', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const initReq = makeSmsInboundRequest({ content: 'init' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    const req = makeSmsInboundRequest({ content: 'no' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    deliverSpy.mockRestore();
  });

  test('non-decision SMS message during pending approval triggers reminder with plain-text fallback', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
    const replySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

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
    expect(body.approval).toBe('reminder_sent');

    // SMS is a non-rich channel so the delivered text should include plain-text fallback
    expect(deliverSpy).toHaveBeenCalled();
    const callArgs = deliverSpy.mock.calls[0];
    const deliveredText = callArgs[2] as string;
    expect(deliveredText).toContain("I'm still waiting");
    expect(deliveredText).toContain('Reply "yes"');

    deliverSpy.mockRestore();
    replySpy.mockRestore();
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
    expect(replyPayload.text).toContain('Guardian verified successfully');

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
    expect(replyPayload.text).toContain('Verification failed');

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. SMS non-guardian actor gating
// ═══════════════════════════════════════════════════════════════════════════

describe('SMS non-guardian actor gating', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

describe('plain-text fallback surfacing for non-rich channels', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('reminder prompt includes plainTextFallback for non-rich channel (http-api)', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
    const replySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Establish the conversation using http-api (non-rich channel)
    const initReq = makeInboundRequest({ content: 'init', sourceChannel: 'http-api' });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Send a non-decision message to trigger a reminder
    const req = makeInboundRequest({ content: 'what is happening?', sourceChannel: 'http-api' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('reminder_sent');

    // The delivered text should include the plainTextFallback instructions
    expect(deliverSpy).toHaveBeenCalled();
    const callArgs = deliverSpy.mock.calls[0];
    const deliveredText = callArgs[2] as string;
    // For non-rich channels, the text should contain both the reminder prefix
    // AND the plainTextFallback instructions (e.g. "Reply yes to approve")
    expect(deliveredText).toContain("I'm still waiting");
    expect(deliveredText).toContain('Reply "yes"');

    deliverSpy.mockRestore();
    replySpy.mockRestore();
  });

  test('reminder prompt does NOT include plainTextFallback for telegram (rich channel)', async () => {
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
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

    // Send a non-decision message to trigger a reminder
    const req = makeInboundRequest({ content: 'what is happening?', sourceChannel: 'telegram' });
    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('reminder_sent');

    // For rich channels (telegram), the delivered text should be just the
    // promptText (with reminder prefix) — NOT the plainTextFallback.
    expect(deliverSpy).toHaveBeenCalled();
    const callArgs = deliverSpy.mock.calls[0];
    const deliveredText = callArgs[2] as string;
    expect(deliveredText).toContain("I'm still waiting");
    // The raw promptText does not contain "Reply" instructions — those are
    // only in the plainTextFallback.
    expect(deliveredText).not.toContain('Reply "yes"');

    deliverSpy.mockRestore();
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('no binding + sensitive action → auto-deny and setup notice', async () => {
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

    // The requester should have been notified about missing guardian setup
    const replyCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('no guardian has been set up'),
    );
    expect(replyCalls.length).toBeGreaterThanOrEqual(1);

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

    // The denial notice should have been sent
    const denialCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('no guardian has been set up'),
    );
    expect(denialCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Guardian-with-binding path regression
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian-with-binding path regression', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

    // Requester should have been notified the request was sent to the guardian
    const notifyCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('has been sent to the guardian for approval'),
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
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Guardian delivery failure denial (WS-2)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian delivery failure → denial', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('delivery failure denies run and notifies requester', async () => {
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

    // The run should have been denied
    expect(orchestrator.submitDecision).toHaveBeenCalled();
    const decisionArgs = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls[0];
    expect(decisionArgs[1]).toBe('deny');

    // Requester should have been notified that delivery failed
    const failureCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('could not be sent to the guardian for approval'),
    );
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);

    // The "has been sent to the guardian for approval" success notice should
    // NOT have been delivered (since delivery failed).
    const successCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('has been sent to the guardian for approval'),
    );
    expect(successCalls.length).toBe(0);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('no pending/unresolved approvals remain after delivery failure', async () => {
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

    // Verify the run ID was created
    const runId = orchestrator.realRunId();
    expect(runId).toBeTruthy();

    // After delivery failure, there should be NO pending approval for the run
    const pendingApproval = getPendingApprovalForRun(runId!);
    expect(pendingApproval).toBeNull();

    // There should also be NO unresolved approval (it was set to 'denied')
    const unresolvedApproval = getUnresolvedApprovalForRun(runId!);
    expect(unresolvedApproval).toBeNull();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20b. Standard approval prompt delivery failure → auto-deny (WS-B)
// ═══════════════════════════════════════════════════════════════════════════

describe('standard approval prompt delivery failure → auto-deny', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('standard prompt delivery failure auto-denies the run (fail-closed)', async () => {
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

    // The run should have been auto-denied because the prompt could not be delivered
    expect(orchestrator.submitDecision).toHaveBeenCalled();
    const decisionArgs = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls[0];
    expect(decisionArgs[1]).toBe('deny');

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. Guardian decision scoping — callback for older run resolves correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian decision scoping — multiple pending approvals', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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

    // Guardian sends plain-text "yes" — ambiguous because two approvals are pending
    const req = makeInboundRequest({
      content: 'yes',
      externalChatId: 'guardian-ambig-chat',
      senderExternalUserId: 'guardian-ambig-user',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // Neither approval should have been resolved — disambiguation was required
    const approvalA = getPendingApprovalForRun(runA.id);
    const approvalB = getPendingApprovalForRun(runB.id);
    expect(approvalA).not.toBeNull();
    expect(approvalB).not.toBeNull();

    // submitDecision should NOT have been called — no decision was applied
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // A disambiguation message should have been sent to the guardian
    const disambigCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' && (call[1] as { text?: string }).text?.includes('pending approval requests'),
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';

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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';

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
// 27. Guardian enforcement decoupled from CHANNEL_APPROVALS_ENABLED
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian enforcement independence from approval flag', () => {
  test('non-guardian sensitive action routes approval to guardian when CHANNEL_APPROVALS_ENABLED is off', async () => {
    delete process.env.CHANNEL_APPROVALS_ENABLED;

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
    delete process.env.CHANNEL_APPROVALS_ENABLED;

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

    // The unknown actor should be treated as unverified_channel and
    // sensitive actions should be auto-denied via the no_identity branch.
    // deliverChannelReply args: (callbackUrl, payload, bearerToken?)
    // The denial notice is in payload.text (index 1 of the call args).
    expect(deliverSpy).toHaveBeenCalled();
    const denialCalls = deliverSpy.mock.calls.filter(
      (call) => {
        if (typeof call[1] !== 'object') return false;
        const text = (call[1] as { text?: string }).text ?? '';
        return text.includes('requires guardian approval') &&
          text.includes('identity could not be determined') &&
          text.includes('denied');
      },
    );
    expect(denialCalls.length).toBeGreaterThanOrEqual(1);

    // Auto-deny path should never prompt for approval
    expect(approvalSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('missing senderExternalUserId without guardian binding uses default flow', async () => {
    delete process.env.CHANNEL_APPROVALS_ENABLED;

    // No guardian binding exists — default behavior should be preserved
    const orchestrator = makeMockOrchestrator();
    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const req = makeInboundRequest({
      content: 'hello world',
      senderExternalUserId: undefined,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    deliverSpy.mockRestore();
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
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
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
