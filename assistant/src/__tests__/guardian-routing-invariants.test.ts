/**
 * Guard tests for canonical guardian request routing invariants.
 *
 * These tests verify that the canonical guardian request system maintains
 * its key architectural invariants:
 *
 *   1. All decision paths route through `applyCanonicalGuardianDecision`
 *   2. Identity checks are enforced before decisions are applied
 *   3. Stale/expired/already-resolved decisions are rejected
 *   4. Code-only messages return clarification (not auto-approve)
 *   5. Disambiguation with multiple pending requests stays fail-closed
 *
 * The tests combine import-verification (ensuring callers reference the
 * canonical primitive) and unit tests of the router and primitive functions.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-routing-invariants-test-'));

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

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from '../memory/canonical-guardian-store.js';
import {
  applyCanonicalGuardianDecision,
} from '../approvals/guardian-decision-primitive.js';
import {
  getResolver,
  getRegisteredKinds,
} from '../approvals/guardian-request-resolvers.js';
import type { ActorContext } from '../approvals/guardian-request-resolvers.js';
import {
  routeGuardianReply,
  type GuardianReplyContext,
} from '../runtime/guardian-reply-router.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM scoped_approval_grants');
  db.run('DELETE FROM canonical_guardian_deliveries');
  db.run('DELETE FROM canonical_guardian_requests');
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guardianActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    externalUserId: 'guardian-1',
    channel: 'telegram',
    isTrusted: false,
    ...overrides,
  };
}

function trustedActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    externalUserId: undefined,
    channel: 'desktop',
    isTrusted: true,
    ...overrides,
  };
}

function replyCtx(overrides: Partial<GuardianReplyContext> = {}): GuardianReplyContext {
  return {
    messageText: '',
    channel: 'telegram',
    actor: guardianActor(),
    conversationId: 'conv-test',
    ...overrides,
  };
}

// ===========================================================================
// SECTION 1: Import-verification guard tests
//
// These verify that all known decision entrypoints import from and call
// `applyCanonicalGuardianDecision` rather than inlining decision logic.
// ===========================================================================

describe('routing invariant: all decision paths reference applyCanonicalGuardianDecision', () => {
  const srcRoot = resolve(__dirname, '..');

  // The files that constitute decision entrypoints. Each must import
  // `applyCanonicalGuardianDecision` from the guardian-decision-primitive.
  const DECISION_ENTRYPOINTS = [
    // Inbound channel router (Telegram/SMS/WhatsApp)
    'runtime/guardian-reply-router.ts',
    // HTTP API route handler (desktop and API clients)
    'runtime/routes/guardian-action-routes.ts',
    // IPC handler (desktop socket clients)
    'daemon/handlers/guardian-actions.ts',
  ];

  for (const relPath of DECISION_ENTRYPOINTS) {
    test(`${relPath} imports applyCanonicalGuardianDecision`, () => {
      const fullPath = join(srcRoot, relPath);
      const source = readFileSync(fullPath, 'utf-8');
      expect(source).toContain('applyCanonicalGuardianDecision');
    });
  }

  // The inbound message handler and session-process both use routeGuardianReply
  // which itself calls applyCanonicalGuardianDecision. Verify they reference
  // the shared router rather than inlining decision logic.
  const ROUTER_CONSUMERS = [
    'runtime/routes/inbound-message-handler.ts',
    'daemon/session-process.ts',
  ];

  for (const relPath of ROUTER_CONSUMERS) {
    test(`${relPath} uses routeGuardianReply (shared router)`, () => {
      const fullPath = join(srcRoot, relPath);
      const source = readFileSync(fullPath, 'utf-8');
      expect(source).toContain('routeGuardianReply');
    });
  }

  test('guardian-reply-router routes all decisions through applyCanonicalGuardianDecision', () => {
    const fullPath = join(srcRoot, 'runtime/guardian-reply-router.ts');
    const source = readFileSync(fullPath, 'utf-8');
    // The router must import and call the canonical primitive, not applyGuardianDecision
    expect(source).toContain('applyCanonicalGuardianDecision');
    // The router must NOT directly call the legacy applyGuardianDecision
    expect(source).not.toContain('applyGuardianDecision(');
  });
});

// ===========================================================================
// SECTION 2: Identity enforcement invariants
// ===========================================================================

describe('routing invariant: identity checks enforced before decisions', () => {
  beforeEach(() => resetTables());

  test('non-matching actor identity is rejected by canonical primitive', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
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

    // Request must remain pending (no state change)
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe('pending');
  });

  test('trusted (desktop) actor bypasses identity check', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'desktop',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: trustedActor(),
    });

    expect(result.applied).toBe(true);
  });

  test('request with no guardian binding accepts any actor', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      // No guardianExternalUserId — open request
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor({ externalUserId: 'anyone' }),
    });

    expect(result.applied).toBe(true);
  });

  test('identity mismatch on code-only message blocks detail leakage', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'ABC123',
      toolName: 'shell',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'ABC123',
      actor: guardianActor({ externalUserId: 'imposter' }),
      conversationId: 'conv-1',
    }));

    // Code-only clarification should be returned but must NOT reveal tool details
    expect(result.consumed).toBe(true);
    expect(result.type).toBe('code_only_clarification');
    expect(result.replyText).toBe('Request not found.');
    expect(result.decisionApplied).toBe(false);
  });
});

// ===========================================================================
// SECTION 3: Stale / expired / already-resolved rejection
// ===========================================================================

describe('routing invariant: stale/expired/already-resolved decisions rejected', () => {
  beforeEach(() => resetTables());

  test('expired request is rejected by canonical primitive', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // already expired
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('expired');
  });

  test('already-resolved request is rejected (first-writer-wins)', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // First decision succeeds
    const first = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });
    expect(first.applied).toBe(true);

    // Second decision fails — request is no longer pending
    const second = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'reject',
      actorContext: guardianActor(),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe('already_resolved');

    // First decision stuck
    const final = getCanonicalGuardianRequest(req.id);
    expect(final!.status).toBe('approved');
  });

  test('nonexistent request returns not_found', async () => {
    const result = await applyCanonicalGuardianDecision({
      requestId: 'nonexistent-id',
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('not_found');
  });

  test('already-resolved request via router returns not_consumed (code lookup filters pending only)', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'ABC123',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Resolve the request first
    await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    // Attempt to resolve again via router with code prefix.
    // Since getCanonicalGuardianRequestByCode only returns pending requests,
    // the resolved request won't be found and the code won't match.
    const result = await routeGuardianReply(replyCtx({
      messageText: 'ABC123 approve',
      conversationId: 'conv-1',
    }));

    // Code lookup filters by status='pending', so the resolved request is invisible.
    // The router does not match the code and returns not_consumed.
    expect(result.consumed).toBe(false);
  });

  test('expired request via callback returns stale type', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // already expired
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: '',
      callbackData: `apr:${req.id}:approve_once`,
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.type).toBe('canonical_decision_stale');
    expect(result.decisionApplied).toBe(false);
  });
});

// ===========================================================================
// SECTION 4: Code-only messages return clarification, not auto-approve
// ===========================================================================

describe('routing invariant: code-only messages return clarification', () => {
  beforeEach(() => resetTables());

  test('code-only message returns clarification with request details', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'A1B2C3',
      toolName: 'shell',
      questionText: 'Run shell command: ls -la',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'A1B2C3',
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.type).toBe('code_only_clarification');
    expect(result.decisionApplied).toBe(false);
    // Must provide actionable instructions
    expect(result.replyText).toContain('A1B2C3');
    expect(result.replyText).toContain('approve');
    expect(result.replyText).toContain('reject');

    // The request must remain pending — NOT auto-approved
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe('pending');
  });

  test('code with decision text does apply the decision', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'A1B2C3',
      toolName: 'shell',
      inputDigest: 'sha256:abc',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'A1B2C3 approve',
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.type).toBe('canonical_decision_applied');
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
  });

  test('code with reject text denies the request', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'D4E5F6',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'D4E5F6 reject',
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('denied');
  });
});

// ===========================================================================
// SECTION 5: Disambiguation with multiple pending requests stays fail-closed
// ===========================================================================

describe('routing invariant: disambiguation stays fail-closed', () => {
  beforeEach(() => resetTables());

  test('multiple pending requests without target return disambiguation (not auto-resolve)', async () => {
    // Create two pending requests for the same guardian
    const req1 = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'AAA111',
      toolName: 'shell',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const req2 = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'BBB222',
      toolName: 'file_write',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // The NL engine mock: returns a decision but no specific target.
    // This simulates a guardian saying "yes" without specifying which request.
    const mockGenerator = async () => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved!',
      targetRequestId: undefined,
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'yes approve it',
      conversationId: 'conv-1',
      pendingRequestIds: [req1.id, req2.id],
      approvalConversationGenerator: mockGenerator as any,
    }));

    expect(result.consumed).toBe(true);
    expect(result.type).toBe('disambiguation_needed');
    expect(result.decisionApplied).toBe(false);

    // Both requests must remain pending — fail-closed
    const r1 = getCanonicalGuardianRequest(req1.id);
    const r2 = getCanonicalGuardianRequest(req2.id);
    expect(r1!.status).toBe('pending');
    expect(r2!.status).toBe('pending');

    // Disambiguation reply should list request codes
    expect(result.replyText).toContain('AAA111');
    expect(result.replyText).toContain('BBB222');
  });

  test('single pending request does not need disambiguation', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      requestCode: 'CCC333',
      toolName: 'shell',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // NL engine returns a decision without specifying target — but only one
    // request is pending, so it should be resolved without disambiguation.
    const mockGenerator = async () => ({
      disposition: 'approve_once' as const,
      replyText: 'Approved!',
      targetRequestId: undefined,
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: 'yes',
      conversationId: 'conv-1',
      pendingRequestIds: [req.id],
      approvalConversationGenerator: mockGenerator as any,
    }));

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
  });
});

// ===========================================================================
// SECTION 6: Resolver registry integrity
// ===========================================================================

describe('routing invariant: resolver registry covers all built-in kinds', () => {
  test('tool_approval resolver is registered', () => {
    const resolver = getResolver('tool_approval');
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe('tool_approval');
  });

  test('pending_question resolver is registered', () => {
    const resolver = getResolver('pending_question');
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe('pending_question');
  });

  test('unknown kind returns undefined (no default fallback)', () => {
    expect(getResolver('nonexistent_kind')).toBeUndefined();
  });

  test('registered kinds include at least tool_approval and pending_question', () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain('tool_approval');
    expect(kinds).toContain('pending_question');
  });
});

// ===========================================================================
// SECTION 7: approve_always downgrade invariant
// ===========================================================================

describe('routing invariant: approve_always downgraded for guardian-on-behalf', () => {
  beforeEach(() => resetTables());

  test('approve_always is silently downgraded to approve_once by canonical primitive', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      toolName: 'shell',
      inputDigest: 'sha256:abc',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_always',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);

    // Status should be 'approved' (not some 'always_approved' state)
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
  });
});

// ===========================================================================
// SECTION 8: Callback routing uses applyCanonicalGuardianDecision
// ===========================================================================

describe('routing invariant: callback buttons route through canonical primitive', () => {
  beforeEach(() => resetTables());

  test('valid callback data applies decision via canonical primitive', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      toolName: 'shell',
      inputDigest: 'sha256:abc',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: '',
      callbackData: `apr:${req.id}:approve_once`,
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.type).toBe('canonical_decision_applied');
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
  });

  test('callback with reject action denies the request', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-1',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: '',
      callbackData: `apr:${req.id}:reject`,
      conversationId: 'conv-1',
    }));

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('denied');
  });

  test('callback targeting wrong conversation is rejected', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      conversationId: 'conv-other',
      guardianExternalUserId: 'guardian-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await routeGuardianReply(replyCtx({
      messageText: '',
      callbackData: `apr:${req.id}:approve_once`,
      conversationId: 'conv-1', // different conversation
    }));

    // Should NOT be consumed — conversation mismatch
    expect(result.consumed).toBe(false);
    expect(result.decisionApplied).toBe(false);

    // Request remains pending
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe('pending');
  });
});
