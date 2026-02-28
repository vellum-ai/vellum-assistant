/**
 * Tests for the non-guardian tool grant escalation path:
 *
 * 1. ToolApprovalHandler grant-miss escalation behavior
 * 2. tool_grant_request resolver registration and behavior
 * 3. Canonical decision primitive grant minting for tool_grant_request kind
 * 4. End-to-end: deny -> approve -> consume grant flow
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'tool-grant-escalation-test-'));

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
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

// Mock guardian control-plane policy — not targeting control-plane by default
mock.module('../tools/guardian-control-plane-policy.js', () => ({
  enforceGuardianOnlyPolicy: () => ({ denied: false }),
}));

// Mock task run rules — no task run rules by default
mock.module('../tasks/ephemeral-permissions.js', () => ({
  getTaskRunRules: () => [],
}));

// Mock tool registry — return a fake tool for 'bash'
const fakeTool = {
  name: 'bash',
  description: 'Run a shell command',
  category: 'shell',
  defaultRiskLevel: 'high',
  getDefinition: () => ({ name: 'bash', description: 'Run a shell command', input_schema: {} }),
  execute: async () => ({ content: 'ok', isError: false }),
};

mock.module('../tools/registry.js', () => ({
  getTool: (name: string) => (name === 'bash' ? fakeTool : undefined),
  getAllTools: () => [fakeTool],
}));

// Mock notification emission — capture calls without running the full pipeline
const emittedSignals: Array<Record<string, unknown>> = [];
mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return { signalId: 'test-signal', deduplicated: false, dispatched: true, reason: 'ok', deliveryResults: [] };
  },
  registerBroadcastFn: () => {},
}));

// Mock channel guardian service — provide a guardian binding for 'self' + 'telegram'
mock.module('../runtime/channel-guardian-service.js', () => ({
  getGuardianBinding: (assistantId: string, channel: string) => {
    if (assistantId === 'self' && channel === 'telegram') {
      return {
        id: 'binding-1',
        assistantId: 'self',
        channel: 'telegram',
        guardianExternalUserId: 'guardian-1',
        guardianDeliveryChatId: 'guardian-chat-1',
        status: 'active',
      };
    }
    return null;
  },
  createOutboundSession: () => ({
    sessionId: 'test-session',
    secret: '123456',
  }),
}));

// Mock gateway client — capture delivery calls
const deliveredReplies: Array<{ chatId: string; text: string }> = [];
mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async (_url: string, payload: { chatId: string; text: string }) => {
    deliveredReplies.push(payload);
  },
}));

import {
  applyCanonicalGuardianDecision,
} from '../approvals/guardian-decision-primitive.js';
import type { ActorContext } from '../approvals/guardian-request-resolvers.js';
import { getRegisteredKinds, getResolver } from '../approvals/guardian-request-resolvers.js';
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from '../memory/canonical-guardian-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { scopedApprovalGrants } from '../memory/schema.js';
import { computeToolApprovalDigest } from '../security/tool-approval-digest.js';
import { ToolApprovalHandler } from '../tools/tool-approval-handler.js';
import type { ToolContext, ToolLifecycleEvent } from '../tools/types.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
  db.run('DELETE FROM canonical_guardian_deliveries');
  db.run('DELETE FROM canonical_guardian_requests');
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    sessionId: 'session-1',
    conversationId: 'conv-1',
    assistantId: 'self',
    requestId: 'req-1',
    guardianTrustClass: 'trusted_contact',
    executionChannel: 'telegram',
    requesterExternalUserId: 'requester-1',
    ...overrides,
  };
}

function guardianActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    externalUserId: 'guardian-1',
    channel: 'telegram',
    isTrusted: false,
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. tool_grant_request resolver registration
// ---------------------------------------------------------------------------

describe('tool_grant_request resolver registration', () => {
  test('tool_grant_request resolver is registered', () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain('tool_grant_request');
  });

  test('getResolver returns resolver for tool_grant_request', () => {
    const resolver = getResolver('tool_grant_request');
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe('tool_grant_request');
  });
});

// ---------------------------------------------------------------------------
// 2. Grant-miss escalation behavior in ToolApprovalHandler
// ---------------------------------------------------------------------------

describe('ToolApprovalHandler / grant-miss escalation', () => {
  const handler = new ToolApprovalHandler();
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => { events.push(event); };

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
  });

  test('non-guardian + grant miss + host tool creates canonical tool_grant_request', async () => {
    const toolName = 'bash';
    const input = { command: 'cat /etc/passwd' };

    const context = makeContext({ guardianTrustClass: 'trusted_contact' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;

    // A canonical tool_grant_request should have been created
    const requests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
    });
    expect(requests.length).toBe(1);
    expect(requests[0].toolName).toBe('bash');
    expect(requests[0].requesterExternalUserId).toBe('requester-1');
    expect(requests[0].guardianExternalUserId).toBe('guardian-1');

    // Notification signal should have been emitted
    expect(emittedSignals.length).toBe(1);
    expect(emittedSignals[0].sourceEventName).toBe('guardian.question');
    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requestKind).toBe('tool_grant_request');
  });

  test('non-guardian grant-miss response includes request code', async () => {
    const toolName = 'bash';
    const input = { command: 'deploy' };

    const context = makeContext({ guardianTrustClass: 'trusted_contact' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toContain('request has been sent to the guardian');
    expect(result.result.content).toContain('request code:');
    expect(result.result.content).toContain('Please retry after the guardian approves');
  });

  test('non-guardian duplicate grant-miss deduplicates the request', async () => {
    const toolName = 'bash';
    const input = { command: 'rm -rf /' };

    const context = makeContext({ guardianTrustClass: 'trusted_contact' });

    // First invocation creates the request
    await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    const firstRequests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
    });
    expect(firstRequests.length).toBe(1);

    // Reset notification tracking
    emittedSignals.length = 0;

    // Second invocation with same tool+input deduplicates
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toContain('already pending');

    // Still only one canonical request
    const requests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
    });
    expect(requests.length).toBe(1);

    // No duplicate notification
    expect(emittedSignals.length).toBe(0);
  });

  test('unverified_channel does NOT create escalation request', async () => {
    const toolName = 'bash';
    const input = { command: 'ls' };

    const context = makeContext({
      guardianTrustClass: 'unknown',
      executionChannel: 'telegram',
      requesterExternalUserId: 'unknown-user',
    });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Should get the generic denial message, not escalation
    expect(result.result.content).toContain('verified channel identity');

    // No canonical request should have been created
    const requests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
    });
    expect(requests.length).toBe(0);
  });

  test('non-guardian without executionChannel falls back to generic denial', async () => {
    const toolName = 'bash';
    const input = { command: 'deploy' };

    const context = makeContext({
      guardianTrustClass: 'trusted_contact',
      executionChannel: undefined, // no channel info
    });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Generic denial, no escalation attempted
    expect(result.result.content).toContain('guardian approval');
    expect(result.result.content).not.toContain('request has been sent');

    const requests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
    });
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Canonical decision and grant minting for tool_grant_request kind
// ---------------------------------------------------------------------------

describe('applyCanonicalGuardianDecision / tool_grant_request', () => {
  beforeEach(() => {
    resetTables();
    deliveredReplies.length = 0;
  });

  test('approving tool_grant_request with tool metadata mints a grant', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_grant_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      conversationId: 'conv-1',
      requesterExternalUserId: 'requester-1',
      guardianExternalUserId: 'guardian-1',
      toolName: 'bash',
      inputDigest: 'sha256:testdigest',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(true);

    // Verify canonical request is approved
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
    expect(resolved!.decidedByExternalUserId).toBe('guardian-1');
  });

  test('rejecting tool_grant_request does NOT mint a grant', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_grant_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      conversationId: 'conv-1',
      requesterExternalUserId: 'requester-1',
      guardianExternalUserId: 'guardian-1',
      toolName: 'bash',
      inputDigest: 'sha256:testdigest',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'reject',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(false);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('denied');
  });

  test('identity mismatch blocks tool_grant_request approval', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_grant_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      conversationId: 'conv-1',
      requesterExternalUserId: 'requester-1',
      guardianExternalUserId: 'guardian-1',
      toolName: 'bash',
      inputDigest: 'sha256:testdigest',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor({ externalUserId: 'imposter-99' }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('identity_mismatch');

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: deny -> approve -> consume grant flow
// ---------------------------------------------------------------------------

describe('end-to-end: tool grant escalation -> approval -> consume', () => {
  const handler = new ToolApprovalHandler();
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => { events.push(event); };

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
  });

  test('first invocation denied + request created; guardian approves; second invocation succeeds; replay denied', async () => {
    const toolName = 'bash';
    const input = { command: 'echo secret' };
    const _inputDigest = computeToolApprovalDigest(toolName, input);

    const context = makeContext({ guardianTrustClass: 'trusted_contact' });

    // Step 1: First invocation is denied, but a tool_grant_request is created
    const firstResult = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );
    expect(firstResult.allowed).toBe(false);

    // Verify the canonical request was created
    const pendingRequests = listCanonicalGuardianRequests({
      kind: 'tool_grant_request',
      status: 'pending',
      toolName: 'bash',
    });
    expect(pendingRequests.length).toBe(1);
    const canonicalRequestId = pendingRequests[0].id;

    // Step 2: Guardian approves the canonical request -> grant is minted
    const approvalResult = await applyCanonicalGuardianDecision({
      requestId: canonicalRequestId,
      action: 'approve_once',
      actorContext: guardianActor(),
    });
    expect(approvalResult.applied).toBe(true);
    if (!approvalResult.applied) return;
    expect(approvalResult.grantMinted).toBe(true);

    // Verify request is now approved
    const resolvedRequest = getCanonicalGuardianRequest(canonicalRequestId);
    expect(resolvedRequest!.status).toBe('approved');

    // Step 3: Second identical invocation consumes the grant and succeeds
    const secondResult = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );
    expect(secondResult.allowed).toBe(true);
    if (!secondResult.allowed) return;
    expect(secondResult.grantConsumed).toBe(true);

    // Step 4: Replay is denied (one-time grant semantics)
    const replayResult = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );
    expect(replayResult.allowed).toBe(false);
  });
});
