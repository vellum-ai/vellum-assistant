import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'tool-approval-handler-test-'));

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

import { mintGrantFromDecision, type MintGrantParams } from '../approvals/approval-primitive.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { scopedApprovalGrants } from '../memory/schema.js';
import { computeToolApprovalDigest } from '../security/tool-approval-digest.js';
import { ToolApprovalHandler } from '../tools/tool-approval-handler.js';
import type { ToolContext, ToolLifecycleEvent } from '../tools/types.js';

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
// Helpers
// ---------------------------------------------------------------------------

function mintParams(overrides: Partial<MintGrantParams> = {}): MintGrantParams {
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  return {
    assistantId: 'self',
    scopeMode: 'tool_signature',
    requestChannel: 'telegram',
    decisionChannel: 'telegram',
    expiresAt: futureExpiry,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    sessionId: 'session-1',
    conversationId: 'conv-1',
    assistantId: 'self',
    requestId: 'req-1',
    guardianActorRole: 'non-guardian',
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('ToolApprovalHandler / pre-exec gate grant check', () => {
  const handler = new ToolApprovalHandler();
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => { events.push(event); };

  beforeEach(() => {
    clearTables();
    events.length = 0;
  });

  test('untrusted actor + matching tool_signature grant -> allow', async () => {
    const toolName = 'bash';
    const input = { command: 'ls -la' };
    const digest = computeToolApprovalDigest(toolName, input);

    // Mint a grant that matches the invocation
    const mintResult = mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: digest,
      }),
    );
    expect(mintResult.ok).toBe(true);

    const context = makeContext({ guardianActorRole: 'non-guardian' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(true);
    // No permission_denied events should have been emitted
    const deniedEvents = events.filter((e) => e.type === 'permission_denied');
    expect(deniedEvents.length).toBe(0);
  });

  test('untrusted actor + no matching grant -> deny with guardian_approval_required', async () => {
    const toolName = 'bash';
    const input = { command: 'rm -rf /' };

    const context = makeContext({ guardianActorRole: 'non-guardian' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain('guardian approval');

    // A permission_denied event should have been emitted
    const deniedEvents = events.filter((e) => e.type === 'permission_denied');
    expect(deniedEvents.length).toBe(1);
  });

  test('unverified_channel actor + matching grant -> allow', async () => {
    const toolName = 'bash';
    const input = { command: 'echo hello' };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ guardianActorRole: 'unverified_channel' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(true);
  });

  test('unverified_channel actor + no grant -> deny', async () => {
    const toolName = 'bash';
    const input = { command: 'deploy' };

    const context = makeContext({ guardianActorRole: 'unverified_channel' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toContain('verified channel identity');
  });

  test('grant is one-time: second invocation with same input denied', async () => {
    const toolName = 'bash';
    const input = { command: 'ls' };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ guardianActorRole: 'non-guardian' });

    // First invocation — should consume the grant and allow
    const first = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );
    expect(first.allowed).toBe(true);

    // Second invocation — grant already consumed, should deny
    const second = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );
    expect(second.allowed).toBe(false);
  });

  test('grant with mismatched input digest -> deny', async () => {
    const toolName = 'bash';
    const grantInput = { command: 'ls' };
    const invokeInput = { command: 'rm -rf /' };
    const grantDigest = computeToolApprovalDigest(toolName, grantInput);

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: grantDigest,
      }),
    );

    const context = makeContext({ guardianActorRole: 'non-guardian' });
    const result = await handler.checkPreExecutionGates(
      toolName, invokeInput, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
  });

  test('expired grant -> deny', async () => {
    const toolName = 'bash';
    const input = { command: 'ls' };
    const digest = computeToolApprovalDigest(toolName, input);
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: digest,
        expiresAt: pastExpiry,
      }),
    );

    const context = makeContext({ guardianActorRole: 'non-guardian' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
  });

  test('guardian actor bypasses grant check entirely (no grant needed)', async () => {
    const toolName = 'bash';
    const input = { command: 'deploy' };

    // No grants minted at all
    const context = makeContext({ guardianActorRole: 'guardian' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    // Guardian should pass through — the untrusted gate is not triggered
    expect(result.allowed).toBe(true);
  });

  test('undefined actor role (desktop/trusted) bypasses grant check', async () => {
    const toolName = 'bash';
    const input = { command: 'deploy' };

    const context = makeContext({ guardianActorRole: undefined });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(true);
  });

  test('grant with matching request_id scope -> allow', async () => {
    const toolName = 'bash';
    const input = { command: 'ls' };

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'request_id',
        requestId: 'req-1',
      }),
    );

    const context = makeContext({ guardianActorRole: 'non-guardian', requestId: 'req-1' });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(true);
  });

  test('grant with context fields (conversationId) must match', async () => {
    const toolName = 'bash';
    const input = { command: 'ls' };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: 'tool_signature',
        toolName,
        inputDigest: digest,
        conversationId: 'conv-other',
      }),
    );

    // Context conversationId does not match the grant's conversationId
    const context = makeContext({
      guardianActorRole: 'non-guardian',
      conversationId: 'conv-1',
    });
    const result = await handler.checkPreExecutionGates(
      toolName, input, context, 'host', 'high', Date.now(), emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
  });
});
