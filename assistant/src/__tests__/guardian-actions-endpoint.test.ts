/**
 * Tests for the deterministic guardian action endpoints:
 * - HTTP route handlers (guardian-action-routes.ts)
 * - IPC handlers (guardian-actions.ts)
 *
 * Covers: conversationId scoping, stale handling, access-request routing,
 * invalid action rejection, pending interaction fallback, and not-found paths.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-actions-endpoint-test-'));

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
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock applyGuardianDecision to avoid needing the full approval + session machinery
const mockApplyGuardianDecision = mock(() => ({
  applied: true,
  requestId: 'req-123',
}));
mock.module('../approvals/guardian-decision-primitive.js', () => ({
  applyGuardianDecision: mockApplyGuardianDecision,
}));

// Mock handleChannelDecision for the pending-interactions fallback path
const mockHandleChannelDecision = mock(() => ({
  applied: true,
  requestId: 'req-456',
}));
mock.module('../runtime/channel-approvals.js', () => ({
  handleChannelDecision: mockHandleChannelDecision,
}));

// Mock handleAccessRequestDecision for ingress_access_request routing
const mockHandleAccessRequestDecision = mock(() => ({
  handled: true,
  type: 'approved' as const,
  verificationSessionId: 'vs-1',
  verificationCode: '123456',
}));
mock.module('../runtime/routes/access-request-decision.js', () => ({
  handleAccessRequestDecision: mockHandleAccessRequestDecision,
}));

import { initializeDb, resetDb } from '../memory/db.js';
import {
  createApprovalRequest,
  getPendingApprovalForRequest,
} from '../memory/channel-guardian-store.js';
import { getDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import * as pendingInteractions from '../runtime/pending-interactions.js';
import {
  handleGuardianActionDecision,
  handleGuardianActionsPending,
  listGuardianDecisionPrompts,
} from '../runtime/routes/guardian-action-routes.js';
import { guardianActionsHandlers } from '../daemon/handlers/guardian-actions.js';

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id, title: `Conversation ${id}`, createdAt: now, updatedAt: now })
    .run();
}

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_guardian_approval_requests');
  db.run('DELETE FROM conversations');
  pendingInteractions.clear();
  mockApplyGuardianDecision.mockClear();
  mockHandleChannelDecision.mockClear();
  mockHandleAccessRequestDecision.mockClear();
}

/** Create a minimal pending approval for testing. */
function createTestApproval(overrides: {
  conversationId: string;
  requestId: string;
  toolName?: string;
  guardianExternalUserId?: string;
  reason?: string;
}) {
  ensureConversation(overrides.conversationId);
  return createApprovalRequest({
    runId: `run-${overrides.requestId}`,
    requestId: overrides.requestId,
    conversationId: overrides.conversationId,
    channel: 'vellum',
    requesterExternalUserId: 'user-1',
    requesterChatId: 'chat-1',
    guardianExternalUserId: overrides.guardianExternalUserId ?? 'guardian-1',
    guardianChatId: 'gchat-1',
    toolName: overrides.toolName ?? 'bash',
    reason: overrides.reason,
    expiresAt: Date.now() + 60_000,
  });
}

// ── IPC helper ──────────────────────────────────────────────────────────

/** Minimal stub for IPC socket and context to capture sent messages. */
function createIpcStub() {
  const sent: Array<Record<string, unknown>> = [];
  const socket = {} as unknown; // opaque — the handler just passes it through
  const ctx = {
    send: (_socket: unknown, msg: Record<string, unknown>) => {
      sent.push(msg);
    },
  };
  return { socket, ctx, sent };
}

// ── Cleanup ─────────────────────────────────────────────────────────────

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort
  }
});

// =========================================================================
// HTTP route: handleGuardianActionDecision
// =========================================================================

describe('HTTP handleGuardianActionDecision', () => {
  beforeEach(resetTables);

  test('rejects missing requestId', async () => {
    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('requestId');
  });

  test('rejects missing action', async () => {
    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-1' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('action');
  });

  test('rejects invalid action', async () => {
    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-1', action: 'nuke_from_orbit' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Invalid action');
  });

  test('returns 404 when no pending approval or interaction exists', async () => {
    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'nonexistent', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(404);
  });

  test('applies decision via applyGuardianDecision for channel approval', async () => {
    createTestApproval({ conversationId: 'conv-1', requestId: 'req-gd-1' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-gd-1' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-gd-1', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.requestId).toBe('req-gd-1');
    expect(mockApplyGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test('rejects decision when conversationId does not match approval', async () => {
    createTestApproval({ conversationId: 'conv-1', requestId: 'req-scope-1' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-scope-1', action: 'approve_once', conversationId: 'conv-wrong' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('does not match');
    expect(mockApplyGuardianDecision).not.toHaveBeenCalled();
  });

  test('allows decision when conversationId matches approval', async () => {
    createTestApproval({ conversationId: 'conv-match', requestId: 'req-scope-2' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-scope-2' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-scope-2', action: 'reject', conversationId: 'conv-match' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
  });

  test('allows decision when no conversationId is provided (backward compat)', async () => {
    createTestApproval({ conversationId: 'conv-any', requestId: 'req-scope-3' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-scope-3' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-scope-3', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(200);
  });

  test('routes ingress_access_request through handleAccessRequestDecision', async () => {
    createTestApproval({
      conversationId: 'conv-access',
      requestId: 'req-access-1',
      toolName: 'ingress_access_request',
      guardianExternalUserId: 'guardian-42',
    });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-access-1', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.accessRequestResult).toBeDefined();
    expect(mockHandleAccessRequestDecision).toHaveBeenCalledTimes(1);
    // Should NOT call applyGuardianDecision for access requests
    expect(mockApplyGuardianDecision).not.toHaveBeenCalled();
  });

  test('maps reject to deny for access request decisions', async () => {
    createTestApproval({
      conversationId: 'conv-access-deny',
      requestId: 'req-access-deny',
      toolName: 'ingress_access_request',
    });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-access-deny', action: 'reject' }),
    });
    await handleGuardianActionDecision(req);
    const call = mockHandleAccessRequestDecision.mock.calls[0];
    expect(call[1]).toBe('deny');
  });

  test('returns stale when access request decision is stale', async () => {
    createTestApproval({
      conversationId: 'conv-access-stale',
      requestId: 'req-access-stale',
      toolName: 'ingress_access_request',
    });
    mockHandleAccessRequestDecision.mockReturnValueOnce({
      handled: false,
      type: 'stale' as const,
    });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-access-stale', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toBe('stale');
    expect(body.requestId).toBe('req-access-stale');
  });

  test('preserves requestId in response when applyGuardianDecision returns stale without requestId', async () => {
    createTestApproval({ conversationId: 'conv-stale', requestId: 'req-stale-1' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: false, reason: 'stale' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-stale-1', action: 'approve_once' }),
    });
    const res = await handleGuardianActionDecision(req);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.reason).toBe('stale');
    // requestId should fall back to the original msg requestId
    expect(body.requestId).toBe('req-stale-1');
  });

  test('falls back to pending interactions when no channel approval exists', async () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-pi-1', {
      session: fakeSession,
      conversationId: 'conv-pi',
      kind: 'confirmation',
    });
    mockHandleChannelDecision.mockReturnValueOnce({ applied: true, requestId: 'req-pi-1' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-pi-1', action: 'approve_always' }),
    });
    const res = await handleGuardianActionDecision(req);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(mockHandleChannelDecision).toHaveBeenCalledTimes(1);
    expect(mockApplyGuardianDecision).not.toHaveBeenCalled();
  });

  test('rejects interaction decision when conversationId mismatches', async () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-pi-scope', {
      session: fakeSession,
      conversationId: 'conv-pi-correct',
      kind: 'confirmation',
    });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-pi-scope', action: 'approve_once', conversationId: 'conv-pi-wrong' }),
    });
    const res = await handleGuardianActionDecision(req);
    expect(res.status).toBe(400);
    expect(mockHandleChannelDecision).not.toHaveBeenCalled();
  });

  test('passes actorExternalUserId as undefined (unauthenticated endpoint)', async () => {
    createTestApproval({ conversationId: 'conv-actor', requestId: 'req-actor-1' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-actor-1' });

    const req = new Request('http://localhost/v1/guardian-actions/decision', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-actor-1', action: 'approve_once' }),
    });
    await handleGuardianActionDecision(req);
    const call = mockApplyGuardianDecision.mock.calls[0][0];
    expect(call.actorExternalUserId).toBeUndefined();
    expect(call.actorChannel).toBe('vellum');
  });
});

// =========================================================================
// HTTP route: handleGuardianActionsPending
// =========================================================================

describe('HTTP handleGuardianActionsPending', () => {
  beforeEach(resetTables);

  test('returns 400 when conversationId is missing', () => {
    const req = new Request('http://localhost/v1/guardian-actions/pending');
    const res = handleGuardianActionsPending(req);
    expect(res.status).toBe(400);
  });

  test('returns prompts for a conversation with pending approvals', () => {
    createTestApproval({ conversationId: 'conv-list', requestId: 'req-list-1', reason: 'Run bash: ls' });

    const req = new Request('http://localhost/v1/guardian-actions/pending?conversationId=conv-list');
    const res = handleGuardianActionsPending(req);
    expect(res.status).toBe(200);

    // Verify the prompts directly via the shared helper
    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-list' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe('req-list-1');
    expect(prompts[0].questionText).toBe('Run bash: ls');
  });

  test('returns empty prompts for a conversation with no pending approvals', () => {
    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-empty' });
    expect(prompts).toHaveLength(0);
  });
});

// =========================================================================
// listGuardianDecisionPrompts
// =========================================================================

describe('listGuardianDecisionPrompts', () => {
  beforeEach(resetTables);

  test('excludes expired approvals', () => {
    ensureConversation('conv-expired');
    // Create approval that's already expired
    createApprovalRequest({
      runId: 'run-expired',
      requestId: 'req-expired',
      conversationId: 'conv-expired',
      channel: 'vellum',
      requesterExternalUserId: 'user-1',
      requesterChatId: 'chat-1',
      guardianExternalUserId: 'guardian-1',
      guardianChatId: 'gchat-1',
      toolName: 'bash',
      expiresAt: Date.now() - 1000, // already expired
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-expired' });
    expect(prompts).toHaveLength(0);
  });

  test('excludes approvals without requestId', () => {
    ensureConversation('conv-no-reqid');
    createApprovalRequest({
      runId: 'run-no-reqid',
      // no requestId
      conversationId: 'conv-no-reqid',
      channel: 'vellum',
      requesterExternalUserId: 'user-1',
      requesterChatId: 'chat-1',
      guardianExternalUserId: 'guardian-1',
      guardianChatId: 'gchat-1',
      toolName: 'bash',
      expiresAt: Date.now() + 60_000,
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-no-reqid' });
    expect(prompts).toHaveLength(0);
  });

  test('includes pending interaction confirmations', () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-int-prompt', {
      session: fakeSession,
      conversationId: 'conv-int-prompt',
      kind: 'confirmation',
      confirmationDetails: {
        toolName: 'read_file',
        input: { path: '/etc/passwd' },
        riskLevel: 'high',
        allowlistOptions: [],
        scopeOptions: [],
        persistentDecisionsAllowed: true,
      },
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-int-prompt' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].toolName).toBe('read_file');
    expect(prompts[0].requestId).toBe('req-int-prompt');
  });

  test('deduplicates interactions that share a requestId with a channel approval', () => {
    createTestApproval({ conversationId: 'conv-dedup', requestId: 'req-dedup-shared' });

    const fakeSession = {} as any;
    pendingInteractions.register('req-dedup-shared', {
      session: fakeSession,
      conversationId: 'conv-dedup',
      kind: 'confirmation',
      confirmationDetails: {
        toolName: 'bash',
        input: {},
        riskLevel: 'medium',
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-dedup' });
    // Should only appear once (from the channel approval)
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe('req-dedup-shared');
  });

  test('skips non-confirmation interactions', () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-secret', {
      session: fakeSession,
      conversationId: 'conv-secret',
      kind: 'secret',
    });

    const prompts = listGuardianDecisionPrompts({ conversationId: 'conv-secret' });
    expect(prompts).toHaveLength(0);
  });
});

// =========================================================================
// IPC handler: guardian_action_decision
// =========================================================================

describe('IPC guardian_action_decision', () => {
  beforeEach(resetTables);

  const handler = guardianActionsHandlers.guardian_action_decision;

  test('rejects invalid action', () => {
    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-1', action: 'self_destruct' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe('invalid_action');
    expect(sent[0].requestId).toBe('req-ipc-1');
  });

  test('returns not_found when no approval or interaction exists', () => {
    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ghost', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe('not_found');
  });

  test('applies decision via applyGuardianDecision for channel approval', () => {
    createTestApproval({ conversationId: 'conv-ipc-1', requestId: 'req-ipc-gd' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-ipc-gd' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-gd', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
    expect(sent[0].requestId).toBe('req-ipc-gd');
    expect(mockApplyGuardianDecision).toHaveBeenCalledTimes(1);
  });

  test('rejects decision when conversationId does not match approval', () => {
    createTestApproval({ conversationId: 'conv-ipc-correct', requestId: 'req-ipc-scope' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: 'guardian_action_decision',
        requestId: 'req-ipc-scope',
        action: 'approve_once',
        conversationId: 'conv-ipc-wrong',
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe('conversation_mismatch');
    expect(sent[0].requestId).toBe('req-ipc-scope');
    expect(mockApplyGuardianDecision).not.toHaveBeenCalled();
  });

  test('allows decision when conversationId matches', () => {
    createTestApproval({ conversationId: 'conv-ipc-match', requestId: 'req-ipc-match' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-ipc-match' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: 'guardian_action_decision',
        requestId: 'req-ipc-match',
        action: 'reject',
        conversationId: 'conv-ipc-match',
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
  });

  test('routes ingress_access_request through handleAccessRequestDecision', () => {
    createTestApproval({
      conversationId: 'conv-ipc-access',
      requestId: 'req-ipc-access',
      toolName: 'ingress_access_request',
      guardianExternalUserId: 'guardian-99',
    });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-access', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
    expect(mockHandleAccessRequestDecision).toHaveBeenCalledTimes(1);
    // Guardian identity should be passed through
    const call = mockHandleAccessRequestDecision.mock.calls[0];
    expect(call[2]).toBe('guardian-99');
  });

  test('returns stale for stale access request', () => {
    createTestApproval({
      conversationId: 'conv-ipc-stale-ar',
      requestId: 'req-ipc-stale-ar',
      toolName: 'ingress_access_request',
    });
    mockHandleAccessRequestDecision.mockReturnValueOnce({
      handled: false,
      type: 'stale' as const,
    });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-stale-ar', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe('stale');
    expect(sent[0].requestId).toBe('req-ipc-stale-ar');
  });

  test('preserves requestId when applyGuardianDecision returns without one', () => {
    createTestApproval({ conversationId: 'conv-ipc-stale', requestId: 'req-ipc-stale' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: false, reason: 'stale' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-stale', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].requestId).toBe('req-ipc-stale');
    expect(sent[0].reason).toBe('stale');
  });

  test('falls back to pending interactions', () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-ipc-pi', {
      session: fakeSession,
      conversationId: 'conv-ipc-pi',
      kind: 'confirmation',
    });
    mockHandleChannelDecision.mockReturnValueOnce({ applied: true, requestId: 'req-ipc-pi' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-pi', action: 'approve_always' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(true);
    expect(mockHandleChannelDecision).toHaveBeenCalledTimes(1);
  });

  test('rejects interaction fallback when conversationId mismatches', () => {
    const fakeSession = {} as any;
    pendingInteractions.register('req-ipc-pi-scope', {
      session: fakeSession,
      conversationId: 'conv-ipc-pi-right',
      kind: 'confirmation',
    });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      {
        type: 'guardian_action_decision',
        requestId: 'req-ipc-pi-scope',
        action: 'approve_once',
        conversationId: 'conv-ipc-pi-wrong',
      } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].applied).toBe(false);
    expect(sent[0].reason).toBe('conversation_mismatch');
    expect(mockHandleChannelDecision).not.toHaveBeenCalled();
  });

  test('passes actorExternalUserId as undefined (unauthenticated endpoint)', () => {
    createTestApproval({ conversationId: 'conv-ipc-actor', requestId: 'req-ipc-actor' });
    mockApplyGuardianDecision.mockReturnValueOnce({ applied: true, requestId: 'req-ipc-actor' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_action_decision', requestId: 'req-ipc-actor', action: 'approve_once' } as any,
      socket as any,
      ctx as any,
    );
    const call = mockApplyGuardianDecision.mock.calls[0][0];
    expect(call.actorExternalUserId).toBeUndefined();
    expect(call.actorChannel).toBe('vellum');
  });
});

// =========================================================================
// IPC handler: guardian_actions_pending_request
// =========================================================================

describe('IPC guardian_actions_pending_request', () => {
  beforeEach(resetTables);

  const handler = guardianActionsHandlers.guardian_actions_pending_request;

  test('returns prompts for a conversation', () => {
    createTestApproval({ conversationId: 'conv-ipc-list', requestId: 'req-ipc-list', reason: 'Run bash: pwd' });

    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_actions_pending_request', conversationId: 'conv-ipc-list' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('guardian_actions_pending_response');
    expect(sent[0].conversationId).toBe('conv-ipc-list');
    const prompts = sent[0].prompts as Array<{ requestId: string; questionText: string }>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe('req-ipc-list');
    expect(prompts[0].questionText).toBe('Run bash: pwd');
  });

  test('returns empty prompts for conversation with no pending approvals', () => {
    const { socket, ctx, sent } = createIpcStub();
    handler(
      { type: 'guardian_actions_pending_request', conversationId: 'conv-empty-ipc' } as any,
      socket as any,
      ctx as any,
    );
    expect(sent).toHaveLength(1);
    const prompts = sent[0].prompts as unknown[];
    expect(prompts).toHaveLength(0);
  });
});
