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
import {
  createRun,
  setRunConfirmation,
} from '../memory/runs-store.js';
import type { PendingConfirmation } from '../memory/runs-store.js';
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
    db.run(
      `INSERT INTO conversations (id, createdAt, updatedAt) VALUES (?, ?, ?)`,
      [conversationId, Date.now(), Date.now()],
    );
  } catch {
    // already exists
  }
}

function resetTables(): void {
  const db = getDb();
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
    const run = createRun('conv-1', 'msg-1');
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
    const events = db.prepare('SELECT conversationId FROM channel_inbound_events').all() as Array<{ conversationId: string }>;
    const conversationId = events[0]?.conversationId;
    expect(conversationId).toBeTruthy();

    // Ensure conversation row exists for FK constraints
    ensureConversation(conversationId!);

    // Create a pending run for this conversation
    const run = createRun(conversationId!, 'msg-1');
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
    const events = db.prepare('SELECT conversationId FROM channel_inbound_events').all() as Array<{ conversationId: string }>;
    const conversationId = events[0]?.conversationId;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!, 'msg-1');
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
    const events = db.prepare('SELECT conversationId FROM channel_inbound_events').all() as Array<{ conversationId: string }>;
    const conversationId = events[0]?.conversationId;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!, 'msg-1');
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
    const events = db.prepare('SELECT conversationId FROM channel_inbound_events').all() as Array<{ conversationId: string }>;
    const conversationId = events[0]?.conversationId;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!, 'msg-1');
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
    const events = db.prepare('SELECT conversationId FROM channel_inbound_events').all() as Array<{ conversationId: string }>;
    const conversationId = events[0]?.conversationId;
    ensureConversation(conversationId!);

    const run = createRun(conversationId!, 'msg-1');
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
