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
import {
  createBinding,
  createApprovalRequest,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
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
    const initBody = await initRes.json() as { conversationId?: string; eventId?: string; accepted?: boolean };

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

  test('does NOT markProcessed when run is not in terminal state after poll timeout', async () => {
    const linkSpy = spyOn(channelDeliveryStore, 'linkMessage').mockImplementation(() => {});
    const markSpy = spyOn(channelDeliveryStore, 'markProcessed');
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

    // getRun always returns 'running' — the run never completes within the poll
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'running' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    // To avoid the 5-minute timeout, we patch the poll constants by testing
    // through a short scenario: since the poll loop checks Date.now() vs
    // RUN_POLL_MAX_WAIT_MS (300_000), we can't easily test the full timeout.
    // Instead, test the terminal check by having getRun return null (run
    // disappeared), which causes the poll to break without a terminal status.
    const orchNull = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => null),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({ content: 'hello world' });
    await handleChannelInbound(req, noopProcessMessage, 'token', orchNull);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // markProcessed should NOT have been called because the run is not terminal
    // (getRun returned null, so isTerminal = false)
    const markCalls = markSpy.mock.calls;
    // Filter for calls that would correspond to the approval path event
    // (the init message from processChannelMessageInBackground could also call markProcessed,
    // but that's the non-approval path)
    expect(markCalls.length).toBe(0);

    linkSpy.mockRestore();
    markSpy.mockRestore();
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
// 10. Fail-closed guardian gate: unverified channel + sensitive request
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Helper to build a mock orchestrator that creates a real run in the DB
 * with a pending confirmation, so `getPendingConfirmationsByConversation`
 * returns the expected data during the background poll loop.
 *
 * The `startRun` callback discovers the auto-generated conversationId from
 * the channel_inbound_events table and creates a real run+confirmation.
 */
function makeSensitiveOrchestrator(opts: {
  runId: string;
  /** After needs_confirmation is detected and handled, return this terminal status. */
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
      // Create a real run in the DB so getPendingConfirmationsByConversation works
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

describe('fail-closed guardian gate (unverified channel)', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('no-binding + sensitive request auto-denies and never self-approves', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-unverified-deny',
      terminalStatus: 'failed',
    });

    // Send from a non-guardian user with no guardian binding on the channel.
    // senderExternalUserId triggers the actor role resolution path.
    const req = makeInboundRequest({
      content: 'do something dangerous',
      senderExternalUserId: 'user-no-guardian',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The orchestrator should have auto-denied (submitDecision called with 'deny')
    const realId = (orchestrator as unknown as { realRunId: () => string }).realRunId();
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(realId, 'deny');

    // The requester should have been notified about missing guardian
    const replyCalls = deliverReplySpy.mock.calls;
    const denialNotice = replyCalls.find(
      (call) => typeof call[1]?.text === 'string' &&
        call[1].text.includes('no guardian has been set up'),
    );
    expect(denialNotice).toBeDefined();

    deliverReplySpy.mockRestore();
  });

  test('no-binding + non-sensitive request still completes normally', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const mockRun = {
      id: 'run-unverified-ok',
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

    // Run completes without ever needing confirmation (non-sensitive action)
    const orchestrator = {
      submitDecision: mock(() => 'applied' as const),
      getRun: mock(() => ({ ...mockRun, status: 'completed' as const })),
      startRun: mock(async () => mockRun),
    } as unknown as RunOrchestrator;

    const req = makeInboundRequest({
      content: 'hello world',
      senderExternalUserId: 'user-no-guardian',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);

    // Wait for the background async to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    // submitDecision should NOT have been called because no confirmation was needed
    expect(orchestrator.submitDecision).not.toHaveBeenCalled();

    // No denial notice should have been sent
    const denialNotice = deliverReplySpy.mock.calls.find(
      (call) => typeof call[1]?.text === 'string' &&
        call[1].text.includes('no guardian has been set up'),
    );
    expect(denialNotice).toBeUndefined();

    deliverReplySpy.mockRestore();
  });

  test('unverified channel user cannot self-approve via approval interception', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    const orchestrator = makeMockOrchestrator();

    // Establish the conversation from the unverified user
    const initReq = makeInboundRequest({
      content: 'init',
      senderExternalUserId: 'user-no-guardian',
    });
    await handleChannelInbound(initReq, noopProcessMessage, 'token', orchestrator);

    const db = getDb();
    const events = db.$client.prepare('SELECT conversation_id FROM channel_inbound_events').all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Create a pending run for this conversation
    const run = createRun(conversationId!);
    setRunConfirmation(run.id, sampleConfirmation);

    // Try to self-approve as the unverified user
    const req = makeInboundRequest({
      content: 'approve',
      senderExternalUserId: 'user-no-guardian',
    });

    const res = await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);
    const body = await res.json() as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should be denied, not approved
    expect(body.approval).toBe('decision_applied');
    // submitDecision should have been called with 'deny' (auto-deny)
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');

    deliverReplySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Guardian-with-binding path regression
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian-with-binding path regression', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('non-guardian with binding routes approval to guardian', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    const deliverApprovalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);

    // Set up a guardian binding for telegram channel
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-1',
      guardianDeliveryChatId: 'guardian-chat-1',
      verifiedVia: 'challenge',
    });

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-with-binding',
      terminalStatus: 'completed',
    });

    // Non-guardian user sends a message
    const req = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: 'requester-user-1',
      senderUsername: 'requester_username',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The approval prompt should be delivered to the guardian's chat
    expect(deliverApprovalSpy).toHaveBeenCalled();
    const approvalCall = deliverApprovalSpy.mock.calls[0];
    expect(approvalCall[1]).toBe('guardian-chat-1'); // guardian chat ID

    // The requester should have been notified
    const requesterNotice = deliverReplySpy.mock.calls.find(
      (call) => typeof call[1]?.text === 'string' &&
        call[1].text.includes('sent to the guardian for approval'),
    );
    expect(requesterNotice).toBeDefined();

    // submitDecision should NOT have been called with 'deny' (no auto-deny)
    const denyCalls = (orchestrator.submitDecision as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => call[1] === 'deny',
    );
    expect(denyCalls.length).toBe(0);

    deliverReplySpy.mockRestore();
    deliverApprovalSpy.mockRestore();
  });

  test('guardian actor gets standard self-approval prompt', async () => {
    const deliverApprovalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockResolvedValue(undefined);
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);

    // Set up a guardian binding
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-2',
      guardianDeliveryChatId: 'guardian-chat-2',
      verifiedVia: 'challenge',
    });

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-guardian-self',
      terminalStatus: 'completed',
    });

    // Guardian user sends a message (their external user ID matches the binding)
    const req = makeInboundRequest({
      content: 'do something',
      senderExternalUserId: 'guardian-user-2',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The approval prompt should be delivered to the guardian's own chat (self-approval)
    expect(deliverApprovalSpy).toHaveBeenCalled();
    const approvalCall = deliverApprovalSpy.mock.calls[0];
    // Should be sent to the requester's chat (externalChatId), not the guardian binding chat
    expect(approvalCall[1]).toBe('chat-123');

    deliverApprovalSpy.mockRestore();
    deliverReplySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Guardian delivery failure denial
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian delivery failure denial', () => {
  beforeEach(() => {
    process.env.CHANNEL_APPROVALS_ENABLED = 'true';
  });

  test('delivery failure immediately denies run and notifies requester', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    // Make deliverApprovalPrompt throw to simulate delivery failure
    const deliverApprovalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockRejectedValue(
      new Error('Network error: guardian unreachable'),
    );

    // Set up a guardian binding
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-fail',
      guardianDeliveryChatId: 'guardian-chat-fail',
      verifiedVia: 'challenge',
    });

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-delivery-fail',
      terminalStatus: 'failed',
    });

    // Non-guardian user sends a message
    const req = makeInboundRequest({
      content: 'do something sensitive',
      senderExternalUserId: 'requester-user-fail',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The run should have been auto-denied
    const realId = (orchestrator as unknown as { realRunId: () => string }).realRunId();
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(realId, 'deny');

    // The requester should be notified that approval could not be obtained
    const denialNotice = deliverReplySpy.mock.calls.find(
      (call) => typeof call[1]?.text === 'string' &&
        call[1].text.includes('could not be sent to the guardian'),
    );
    expect(denialNotice).toBeDefined();

    // No success notice ("has been sent to the guardian") should have been sent
    // (the delivery failed, so the success notification should be skipped)
    const successNotice = deliverReplySpy.mock.calls.find(
      (call) => typeof call[1]?.text === 'string' &&
        call[1].text.includes('has been sent to the guardian for approval'),
    );
    expect(successNotice).toBeUndefined();

    deliverReplySpy.mockRestore();
    deliverApprovalSpy.mockRestore();
  });

  test('delivery failure sets approval status to denied, preventing requester fallback', async () => {
    const deliverReplySpy = spyOn(gatewayClient, 'deliverChannelReply').mockResolvedValue(undefined);
    // Make deliverApprovalPrompt throw
    const deliverApprovalSpy = spyOn(gatewayClient, 'deliverApprovalPrompt').mockRejectedValue(
      new Error('Network error'),
    );

    // Set up a guardian binding
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-fail-2',
      guardianDeliveryChatId: 'guardian-chat-fail-2',
      verifiedVia: 'challenge',
    });

    const orchestrator = makeSensitiveOrchestrator({
      runId: 'run-delivery-fail-2',
      terminalStatus: 'failed',
    });

    const req = makeInboundRequest({
      content: 'do something sensitive',
      senderExternalUserId: 'requester-user-fail-2',
    });

    await handleChannelInbound(req, noopProcessMessage, 'token', orchestrator);

    // Wait for background async
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // After delivery failure, there should be no pending approval that the
    // requester could exploit as a fallback path.
    const realId = (orchestrator as unknown as { realRunId: () => string }).realRunId()!;
    const pendingApproval = getPendingApprovalForRun(realId);
    expect(pendingApproval).toBeNull();

    // The unresolved approval (if any) should also not be in 'pending' status
    const unresolvedApproval = getUnresolvedApprovalForRun(realId);
    expect(unresolvedApproval).toBeNull();

    deliverReplySpy.mockRestore();
    deliverApprovalSpy.mockRestore();
  });
});
