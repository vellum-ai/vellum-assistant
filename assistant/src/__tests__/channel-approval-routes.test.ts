import { describe, test, expect, beforeEach, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { conversations } from '../memory/schema.js';
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
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalByRunAndGuardianChat,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
  updateApprovalDecision,
} from '../memory/channel-guardian-store.js';
import type { RunOrchestrator } from '../runtime/run-orchestrator.js';
import { handleChannelInbound, isChannelApprovalsEnabled } from '../runtime/routes/channel-routes.js';
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
    headers: { 'Content-Type': 'application/json' },
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

  test('proceeds normally even when pending approvals exist', async () => {
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

    // Should proceed normally — no approval interception
    expect(body.accepted).toBe(true);
    expect(body.approval).toBeUndefined();
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
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

  test('markProcessed IS called even when run is not in terminal state after poll timeout', async () => {
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

    // getRun returns null — run disappeared, poll loop breaks, isTerminal = false.
    // Even though the run is not terminal, the event is marked as processed
    // because the run is still alive and waiting for an approval decision.
    // Marking it as failed would cause the retry sweep to replay through
    // processMessage and dead-letter the conversation.
    const orchNull = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => null),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchNull);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed SHOULD have been called — the timeout path now marks as
    // processed instead of failed, relying on the post-decision delivery in
    // handleApprovalInterception to deliver the reply when the user decides.
    expect(markSpy).toHaveBeenCalled();

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

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
// 12. Timeout marks event as processed (not failed)
// ═══════════════════════════════════════════════════════════════════════════

describe('poll timeout marks event as processed', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('marks event as processed (not failed) when run disappears (getRun returns null) before terminal state', async () => {
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

    // getRun returns null — run disappeared, poll loop breaks, isTerminal = false
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => null),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello timeout' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed SHOULD have been called — the run is still alive, just
    // waiting for approval. Marking as failed would cause the retry sweep to
    // replay through processMessage and dead-letter the conversation.
    expect(markSpy).toHaveBeenCalled();

    // recordProcessingFailure should NOT have been called
    expect(failureSpy).not.toHaveBeenCalled();

    linkSpy.mockRestore();
    markSpy.mockRestore();
    failureSpy.mockRestore();
    deliverSpy.mockRestore();
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-chat-verify',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: `/guardian_verify ${secret}`,
        senderExternalUserId: 'sms-user-42',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token');
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-chat-verify-fail',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: '/guardian_verify invalid-token-here',
        senderExternalUserId: 'sms-user-43',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token');
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceChannel: 'sms',
        externalChatId: 'sms-other-chat',
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: 'do something',
        senderExternalUserId: 'sms-other-user',
        replyCallbackUrl: 'https://gateway.test/deliver',
      }),
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

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
// 21. Scoped guardian decision lookup — multiple pending approvals (WS-3)
// ═══════════════════════════════════════════════════════════════════════════

describe('scoped guardian decision lookup — multiple pending approvals', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('callback for older run resolves correctly when multiple approvals are pending', async () => {
    // Set up a guardian binding
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-multi',
      guardianDeliveryChatId: 'guardian-chat-multi',
    });

    // Create two conversations and runs with pending approvals
    ensureConversation('conv-older');
    const olderRun = createRun('conv-older');
    setRunConfirmation(olderRun.id, sampleConfirmation);

    ensureConversation('conv-newer');
    const newerRun = createRun('conv-newer');
    setRunConfirmation(newerRun.id, sampleConfirmation);

    // Create guardian approval requests for both runs — same guardian chat
    createApprovalRequest({
      runId: olderRun.id,
      conversationId: 'conv-older',
      channel: 'telegram',
      requesterExternalUserId: 'requester-a',
      requesterChatId: 'chat-requester-a',
      guardianExternalUserId: 'guardian-multi',
      guardianChatId: 'guardian-chat-multi',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    createApprovalRequest({
      runId: newerRun.id,
      conversationId: 'conv-newer',
      channel: 'telegram',
      requesterExternalUserId: 'requester-b',
      requesterChatId: 'chat-requester-b',
      guardianExternalUserId: 'guardian-multi',
      guardianChatId: 'guardian-chat-multi',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const orchestrator = makeMockOrchestrator();

    // Guardian sends a callback button targeting the OLDER run specifically
    const req = makeInboundRequest({
      sourceChannel: 'telegram',
      externalChatId: 'guardian-chat-multi',
      senderExternalUserId: 'guardian-multi',
      content: '',
      callbackData: `apr:${olderRun.id}:approve_once`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // The older approval should now be resolved ('approved')
    const olderResolved = getPendingApprovalForRun(olderRun.id);
    expect(olderResolved).toBeNull(); // no longer pending

    // The newer approval should still be pending
    const newerPending = getPendingApprovalForRun(newerRun.id);
    expect(newerPending).not.toBeNull();
    expect(newerPending!.status).toBe('pending');

    // The orchestrator should have been called with the OLDER run's conversation
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(olderRun.id, 'allow');

    // Requester A should have been notified
    const notifyCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { chatId?: string }).chatId === 'chat-requester-a' &&
        (call[1] as { text?: string }).text?.includes('approved by the guardian'),
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
  });

  test('scoped lookup by (runId, channel, guardianChatId) returns correct approval', () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-scope',
      guardianDeliveryChatId: 'guardian-chat-scope',
    });

    ensureConversation('conv-scope-1');
    const run1 = createRun('conv-scope-1');
    setRunConfirmation(run1.id, sampleConfirmation);

    ensureConversation('conv-scope-2');
    const run2 = createRun('conv-scope-2');
    setRunConfirmation(run2.id, sampleConfirmation);

    createApprovalRequest({
      runId: run1.id,
      conversationId: 'conv-scope-1',
      channel: 'telegram',
      requesterExternalUserId: 'req-1',
      requesterChatId: 'chat-req-1',
      guardianExternalUserId: 'guardian-scope',
      guardianChatId: 'guardian-chat-scope',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    createApprovalRequest({
      runId: run2.id,
      conversationId: 'conv-scope-2',
      channel: 'telegram',
      requesterExternalUserId: 'req-2',
      requesterChatId: 'chat-req-2',
      guardianExternalUserId: 'guardian-scope',
      guardianChatId: 'guardian-chat-scope',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    // Scoped lookup for run1 returns the correct approval
    const result1 = getPendingApprovalByRunAndGuardianChat(
      run1.id, 'telegram', 'guardian-chat-scope',
    );
    expect(result1).not.toBeNull();
    expect(result1!.runId).toBe(run1.id);
    expect(result1!.conversationId).toBe('conv-scope-1');

    // Scoped lookup for run2 returns the correct approval
    const result2 = getPendingApprovalByRunAndGuardianChat(
      run2.id, 'telegram', 'guardian-chat-scope',
    );
    expect(result2).not.toBeNull();
    expect(result2!.runId).toBe(run2.id);
    expect(result2!.conversationId).toBe('conv-scope-2');

    // Scoped lookup for a non-existent run returns null
    const result3 = getPendingApprovalByRunAndGuardianChat(
      'nonexistent-run', 'telegram', 'guardian-chat-scope',
    );
    expect(result3).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. Ambiguous plain-text decision with multiple pending requests (WS-3)
// ═══════════════════════════════════════════════════════════════════════════

describe('ambiguous plain-text guardian decision with multiple pending approvals', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('plain-text "approve" with multiple pending approvals requires disambiguation', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-disambig',
      guardianDeliveryChatId: 'guardian-chat-disambig',
    });

    // Create two pending approvals in the same guardian chat
    ensureConversation('conv-disambig-1');
    const run1 = createRun('conv-disambig-1');
    setRunConfirmation(run1.id, sampleConfirmation);

    ensureConversation('conv-disambig-2');
    const run2 = createRun('conv-disambig-2');
    setRunConfirmation(run2.id, sampleConfirmation);

    createApprovalRequest({
      runId: run1.id,
      conversationId: 'conv-disambig-1',
      channel: 'telegram',
      requesterExternalUserId: 'req-d1',
      requesterChatId: 'chat-req-d1',
      guardianExternalUserId: 'guardian-disambig',
      guardianChatId: 'guardian-chat-disambig',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    createApprovalRequest({
      runId: run2.id,
      conversationId: 'conv-disambig-2',
      channel: 'telegram',
      requesterExternalUserId: 'req-d2',
      requesterChatId: 'chat-req-d2',
      guardianExternalUserId: 'guardian-disambig',
      guardianChatId: 'guardian-chat-disambig',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const orchestrator = makeMockOrchestrator();

    // Guardian sends plain-text "approve" — ambiguous since 2 requests are pending
    const req = makeInboundRequest({
      sourceChannel: 'telegram',
      externalChatId: 'guardian-chat-disambig',
      senderExternalUserId: 'guardian-disambig',
      content: 'approve',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // submitDecision should NOT have been called — the plain-text decision was
    // rejected due to ambiguity
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // Both approvals should still be pending
    const pending1 = getPendingApprovalForRun(run1.id);
    const pending2 = getPendingApprovalForRun(run2.id);
    expect(pending1).not.toBeNull();
    expect(pending2).not.toBeNull();

    // The disambiguation message should have been sent
    const disambigCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { text?: string }).text?.includes('pending approval requests'),
    );
    expect(disambigCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
  });

  test('plain-text "approve" with single pending approval works normally', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-single',
      guardianDeliveryChatId: 'guardian-chat-single',
    });

    ensureConversation('conv-single-1');
    const run1 = createRun('conv-single-1');
    setRunConfirmation(run1.id, sampleConfirmation);

    createApprovalRequest({
      runId: run1.id,
      conversationId: 'conv-single-1',
      channel: 'telegram',
      requesterExternalUserId: 'req-s1',
      requesterChatId: 'chat-req-s1',
      guardianExternalUserId: 'guardian-single',
      guardianChatId: 'guardian-chat-single',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const orchestrator = makeMockOrchestrator();

    // Guardian sends plain-text "approve" — only one request, so no ambiguity
    const req = makeInboundRequest({
      sourceChannel: 'telegram',
      externalChatId: 'guardian-chat-single',
      senderExternalUserId: 'guardian-single',
      content: 'approve',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // submitDecision SHOULD have been called — single pending approval
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run1.id, 'allow');

    // The approval should now be resolved
    const resolved = getPendingApprovalForRun(run1.id);
    expect(resolved).toBeNull();

    deliverSpy.mockRestore();
  });

  test('callback button works even with multiple pending approvals (uses scoped lookup)', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-btn-multi',
      guardianDeliveryChatId: 'guardian-chat-btn-multi',
    });

    ensureConversation('conv-btn-1');
    const run1 = createRun('conv-btn-1');
    setRunConfirmation(run1.id, sampleConfirmation);

    ensureConversation('conv-btn-2');
    const run2 = createRun('conv-btn-2');
    setRunConfirmation(run2.id, sampleConfirmation);

    createApprovalRequest({
      runId: run1.id,
      conversationId: 'conv-btn-1',
      channel: 'telegram',
      requesterExternalUserId: 'req-btn-1',
      requesterChatId: 'chat-req-btn-1',
      guardianExternalUserId: 'guardian-btn-multi',
      guardianChatId: 'guardian-chat-btn-multi',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    createApprovalRequest({
      runId: run2.id,
      conversationId: 'conv-btn-2',
      channel: 'telegram',
      requesterExternalUserId: 'req-btn-2',
      requesterChatId: 'chat-req-btn-2',
      guardianExternalUserId: 'guardian-btn-multi',
      guardianChatId: 'guardian-chat-btn-multi',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const orchestrator = makeMockOrchestrator();

    // Guardian uses callback button for run2 specifically
    const req = makeInboundRequest({
      sourceChannel: 'telegram',
      externalChatId: 'guardian-chat-btn-multi',
      senderExternalUserId: 'guardian-btn-multi',
      content: '',
      callbackData: `apr:${run2.id}:reject`,
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('guardian_decision_applied');

    // submitDecision should have been called for run2 (reject)
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run2.id, 'deny');

    // run1 should still be pending
    const pending1 = getPendingApprovalForRun(run1.id);
    expect(pending1).not.toBeNull();

    // run2 should be resolved
    const pending2 = getPendingApprovalForRun(run2.id);
    expect(pending2).toBeNull();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23. Expired guardian approval auto-denies proactively (WS-3)
// ═══════════════════════════════════════════════════════════════════════════

describe('expired guardian approval auto-denies proactively', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('expired approval is auto-denied when requester sends follow-up', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-expiry',
      guardianDeliveryChatId: 'guardian-chat-expiry',
    });

    const deliverSpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const approvalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    ensureConversation('conv-expiry-manual');
    const run = createRun('conv-expiry-manual');
    setRunConfirmation(run.id, sampleConfirmation);

    // Create an approval request that has ALREADY expired
    createApprovalRequest({
      runId: run.id,
      conversationId: 'conv-expiry-manual',
      channel: 'telegram',
      requesterExternalUserId: 'requester-expiry',
      requesterChatId: 'chat-requester-expiry',
      guardianExternalUserId: 'guardian-expiry',
      guardianChatId: 'guardian-chat-expiry',
      toolName: 'shell',
      expiresAt: Date.now() - 1000, // already expired
    });

    // The approval should be detectable as unresolved but NOT as pending
    // (since it's expired)
    const pendingCheck = getPendingApprovalForRun(run.id);
    expect(pendingCheck).toBeNull(); // expired, so not returned by time-filtered query

    const unresolvedCheck = getUnresolvedApprovalForRun(run.id);
    expect(unresolvedCheck).not.toBeNull(); // still status='pending' in DB
    expect(unresolvedCheck!.status).toBe('pending');

    const orchestrator = makeMockOrchestrator();

    // We need to establish the conversation mapping for the requester's chat
    // so that recordInbound returns the correct conversationId.
    const db = getDb();
    const now = Date.now();
    try {
      db.run(`INSERT INTO conversation_keys (id, conversation_key, conversation_id, created_at)
        VALUES ('ck-setup-expiry', 'telegram:chat-requester-expiry', 'conv-expiry-manual', ${now})`);
    } catch { /* already exists */ }

    deliverSpy.mockClear();

    // When the requester sends a follow-up, the expired-but-unresolved
    // approval should be auto-denied via the interception path
    const reqFromRequester = makeInboundRequest({
      sourceChannel: 'telegram',
      externalChatId: 'chat-requester-expiry',
      senderExternalUserId: 'requester-expiry',
      content: 'what happened?',
    });

    const res = await handleChannelInbound(reqFromRequester, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe('decision_applied');

    // The orchestrator should have denied the run
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    // The approval should now be marked as 'expired' (not 'pending')
    const afterExpiry = getUnresolvedApprovalForRun(run.id);
    expect(afterExpiry).toBeNull(); // status changed from 'pending'

    // The requester should have received the expiry notice
    const expiryCalls = deliverSpy.mock.calls.filter(
      (call) => typeof call[1] === 'object' &&
        (call[1] as { text?: string }).text?.includes('expired'),
    );
    expect(expiryCalls.length).toBeGreaterThanOrEqual(1);

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });

  test('getExpiredPendingApprovals returns expired but still-pending approvals', async () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-timer',
      guardianDeliveryChatId: 'guardian-chat-timer',
    });

    ensureConversation('conv-timer');
    const run = createRun('conv-timer');
    setRunConfirmation(run.id, sampleConfirmation);

    // Create an approval request with a very short TTL (already expired)
    const approval = createApprovalRequest({
      runId: run.id,
      conversationId: 'conv-timer',
      channel: 'telegram',
      requesterExternalUserId: 'requester-timer',
      requesterChatId: 'chat-requester-timer',
      guardianExternalUserId: 'guardian-timer',
      guardianChatId: 'guardian-chat-timer',
      toolName: 'shell',
      expiresAt: Date.now() - 100, // already expired
    });

    // The approval should be unresolved (status='pending') but not returned
    // by getPendingApprovalForRun (time-filtered)
    const unresolved = getUnresolvedApprovalForRun(run.id);
    expect(unresolved).not.toBeNull();
    expect(unresolved!.status).toBe('pending');

    const pending = getPendingApprovalForRun(run.id);
    expect(pending).toBeNull();

    // getExpiredPendingApprovals should find it
    const { getExpiredPendingApprovals } = await import('../memory/channel-guardian-store.js');
    const expired = getExpiredPendingApprovals();
    const matchingExpired = expired.filter((a) => a.runId === run.id);
    expect(matchingExpired.length).toBe(1);
    expect(matchingExpired[0].id).toBe(approval.id);

    // After marking it expired, it should no longer appear
    updateApprovalDecision(approval.id, { status: 'expired' });
    const afterUpdate = getUnresolvedApprovalForRun(run.id);
    expect(afterUpdate).toBeNull();
  });

  test('getAllPendingApprovalsByGuardianChat returns all pending approvals', () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-all',
      guardianDeliveryChatId: 'guardian-chat-all',
    });

    ensureConversation('conv-all-1');
    const run1 = createRun('conv-all-1');
    setRunConfirmation(run1.id, sampleConfirmation);

    ensureConversation('conv-all-2');
    const run2 = createRun('conv-all-2');
    setRunConfirmation(run2.id, sampleConfirmation);

    ensureConversation('conv-all-3');
    const run3 = createRun('conv-all-3');
    setRunConfirmation(run3.id, sampleConfirmation);

    createApprovalRequest({
      runId: run1.id,
      conversationId: 'conv-all-1',
      channel: 'telegram',
      requesterExternalUserId: 'req-all-1',
      requesterChatId: 'chat-req-all-1',
      guardianExternalUserId: 'guardian-all',
      guardianChatId: 'guardian-chat-all',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    createApprovalRequest({
      runId: run2.id,
      conversationId: 'conv-all-2',
      channel: 'telegram',
      requesterExternalUserId: 'req-all-2',
      requesterChatId: 'chat-req-all-2',
      guardianExternalUserId: 'guardian-all',
      guardianChatId: 'guardian-chat-all',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    // Third approval for a different channel — should NOT be returned
    createApprovalRequest({
      runId: run3.id,
      conversationId: 'conv-all-3',
      channel: 'sms',
      requesterExternalUserId: 'req-all-3',
      requesterChatId: 'chat-req-all-3',
      guardianExternalUserId: 'guardian-all',
      guardianChatId: 'guardian-chat-all',
      toolName: 'shell',
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const allPending = getAllPendingApprovalsByGuardianChat('telegram', 'guardian-chat-all');
    expect(allPending.length).toBe(2);
    const runIds = allPending.map((a) => a.runId);
    expect(runIds).toContain(run1.id);
    expect(runIds).toContain(run2.id);
  });
});
