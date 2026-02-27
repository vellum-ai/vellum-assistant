import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'approval-primitive-test-'));

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
import { scopedApprovalGrants } from '../memory/schema.js';
import {
  mintGrantFromDecision,
  consumeGrantForInvocation,
  type MintGrantParams,
} from '../approvals/approval-primitive.js';
import { computeToolApprovalDigest } from '../security/tool-approval-digest.js';

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
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
// Helper to build mint params with sensible defaults
// ---------------------------------------------------------------------------

function mintParams(overrides: Partial<MintGrantParams> = {}): MintGrantParams {
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  return {
    assistantId: 'self',
    scopeMode: 'request_id',
    requestChannel: 'telegram',
    decisionChannel: 'telegram',
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// MINT TESTS
// ===========================================================================

describe('approval-primitive / mintGrantFromDecision', () => {
  beforeEach(() => clearTables());

  test('mints a request_id scoped grant successfully', () => {
    const result = mintGrantFromDecision(
      mintParams({ scopeMode: 'request_id', requestId: 'req-1' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe('active');
    expect(result.grant.requestId).toBe('req-1');
    expect(result.grant.scopeMode).toBe('request_id');
  });

  test('mints a tool_signature scoped grant successfully', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'ls' });
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.toolName).toBe('shell');
    expect(result.grant.inputDigest).toBe(digest);
    expect(result.grant.scopeMode).toBe('tool_signature');
  });

  test('rejects request_id scope when requestId is missing', () => {
    const result = mintGrantFromDecision(
      mintParams({ scopeMode: 'request_id', requestId: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_request_id');
  });

  test('rejects tool_signature scope when toolName is missing', () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: null,
        inputDigest: 'abc123',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_tool_fields');
  });

  test('rejects tool_signature scope when inputDigest is missing', () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: null,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_tool_fields');
  });

  test('mints grant with full scope context fields', () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: 'request_id',
        requestId: 'req-full',
        conversationId: 'conv-1',
        callSessionId: 'call-1',
        requesterExternalUserId: 'user-1',
        guardianExternalUserId: 'guardian-1',
        executionChannel: 'voice',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.conversationId).toBe('conv-1');
    expect(result.grant.callSessionId).toBe('call-1');
    expect(result.grant.requesterExternalUserId).toBe('user-1');
    expect(result.grant.guardianExternalUserId).toBe('guardian-1');
    expect(result.grant.executionChannel).toBe('voice');
  });
});

// ===========================================================================
// CONSUME TESTS
// ===========================================================================

describe('approval-primitive / consumeGrantForInvocation', () => {
  beforeEach(() => clearTables());

  test('consumes a request_id grant when requestId matches', () => {
    mintGrantFromDecision(mintParams({ scopeMode: 'request_id', requestId: 'req-100' }));

    const result = consumeGrantForInvocation({
      requestId: 'req-100',
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', { command: 'ls' }),
      consumingRequestId: 'consumer-1',
      assistantId: 'self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe('consumed');
    expect(result.grant.consumedByRequestId).toBe('consumer-1');
  });

  test('consumes a tool_signature grant when tool+input matches', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'ls' });
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
      }),
    );

    const result = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-2',
      assistantId: 'self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe('consumed');
  });

  test('falls back to tool_signature when request_id does not match', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'ls' });
    // Mint a tool_signature grant (not request_id)
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
      }),
    );

    const result = consumeGrantForInvocation({
      requestId: 'nonexistent-req',
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-3',
      assistantId: 'self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.scopeMode).toBe('tool_signature');
  });

  // ---------------------------------------------------------------------------
  // Consume miss scenarios
  // ---------------------------------------------------------------------------

  test('miss: no grants exist at all', () => {
    const result = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', { command: 'ls' }),
      consumingRequestId: 'consumer-miss',
      assistantId: 'self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });

  test('miss: tool name mismatch', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'ls' });
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
      }),
    );

    const result = consumeGrantForInvocation({
      toolName: 'file_write',
      inputDigest: digest,
      consumingRequestId: 'consumer-mismatch-tool',
      assistantId: 'self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });

  test('miss: input digest mismatch', () => {
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: computeToolApprovalDigest('shell', { command: 'ls' }),
      }),
    );

    const result = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', { command: 'rm -rf /' }),
      consumingRequestId: 'consumer-mismatch-input',
      assistantId: 'self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });

  test('miss: assistant ID mismatch', () => {
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'request_id',
        requestId: 'req-assist',
        assistantId: 'assistant-A',
      }),
    );

    const result = consumeGrantForInvocation({
      requestId: 'req-assist',
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', {}),
      consumingRequestId: 'consumer-assist-mismatch',
      assistantId: 'assistant-B',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });

  test('miss: grant expired', () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'request_id',
        requestId: 'req-expired',
        expiresAt: pastExpiry,
      }),
    );

    const result = consumeGrantForInvocation({
      requestId: 'req-expired',
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', {}),
      consumingRequestId: 'consumer-expired',
      assistantId: 'self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });

  // ---------------------------------------------------------------------------
  // One-time consume semantics
  // ---------------------------------------------------------------------------

  test('one-time consume: second consume of the same grant fails', () => {
    mintGrantFromDecision(
      mintParams({ scopeMode: 'request_id', requestId: 'req-once' }),
    );

    const first = consumeGrantForInvocation({
      requestId: 'req-once',
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', {}),
      consumingRequestId: 'consumer-first',
      assistantId: 'self',
    });
    expect(first.ok).toBe(true);

    const second = consumeGrantForInvocation({
      requestId: 'req-once',
      toolName: 'shell',
      inputDigest: computeToolApprovalDigest('shell', {}),
      consumingRequestId: 'consumer-second',
      assistantId: 'self',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('no_match');
  });

  test('one-time consume: tool_signature grant is consumed only once', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'deploy' });
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
      }),
    );

    const first = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-sig-first',
      assistantId: 'self',
    });
    expect(first.ok).toBe(true);

    const second = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-sig-second',
      assistantId: 'self',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('no_match');
  });

  // ---------------------------------------------------------------------------
  // Context-scoped consume
  // ---------------------------------------------------------------------------

  test('consumes tool_signature grant with matching conversation context', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'test' });
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
        conversationId: 'conv-ctx',
        callSessionId: 'call-ctx',
      }),
    );

    const result = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-ctx',
      assistantId: 'self',
      conversationId: 'conv-ctx',
      callSessionId: 'call-ctx',
    });

    expect(result.ok).toBe(true);
  });

  test('miss: conversation context mismatch on tool_signature grant', () => {
    const digest = computeToolApprovalDigest('shell', { command: 'test' });
    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName: 'shell',
        inputDigest: digest,
        conversationId: 'conv-A',
      }),
    );

    const result = consumeGrantForInvocation({
      toolName: 'shell',
      inputDigest: digest,
      consumingRequestId: 'consumer-ctx-mismatch',
      assistantId: 'self',
      conversationId: 'conv-B',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
  });
});
