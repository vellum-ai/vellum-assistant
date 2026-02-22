import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'channel-approvals-test-'));

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

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import {
  createRun,
  setRunConfirmation,
} from '../memory/runs-store.js';
import type { PendingConfirmation, PendingRunInfo } from '../memory/runs-store.js';
import type { RunOrchestrator } from '../runtime/run-orchestrator.js';
import {
  getChannelApprovalPrompt,
  buildApprovalUIMetadata,
  handleChannelDecision,
  buildReminderPrompt,
} from '../runtime/channel-approvals.js';
import type { ApprovalDecisionResult, ChannelApprovalPrompt } from '../runtime/channel-approval-types.js';
import * as trustStore from '../permissions/trust-store.js';

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
  } as unknown as RunOrchestrator;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. getChannelApprovalPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe('getChannelApprovalPrompt', () => {
  beforeEach(() => {
    resetTables();
  });

  test('returns null when no pending runs exist', () => {
    ensureConversation('conv-1');
    const result = getChannelApprovalPrompt('conv-1');
    expect(result).toBeNull();
  });

  test('returns null when runs exist but none need confirmation', () => {
    ensureConversation('conv-1');
    createRun('conv-1', 'msg-1');
    const result = getChannelApprovalPrompt('conv-1');
    expect(result).toBeNull();
  });

  test('returns a prompt when a run needs confirmation', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const result = getChannelApprovalPrompt('conv-1');
    expect(result).not.toBeNull();
    expect(result!.promptText).toContain('shell');
    expect(result!.actions).toHaveLength(3);
    expect(result!.actions.map((a) => a.id)).toEqual([
      'approve_once',
      'approve_always',
      'reject',
    ]);
    expect(result!.plainTextFallback).toContain('yes');
    expect(result!.plainTextFallback).toContain('always');
    expect(result!.plainTextFallback).toContain('no');
  });

  test('uses the first pending run when multiple exist', () => {
    ensureConversation('conv-1');
    const run1 = createRun('conv-1', 'msg-1');
    const run2 = createRun('conv-1', 'msg-2');
    setRunConfirmation(run1.id, sampleConfirmation);
    setRunConfirmation(run2.id, {
      ...sampleConfirmation,
      toolName: 'file_edit',
      toolUseId: 'req-def-456',
    });

    const result = getChannelApprovalPrompt('conv-1');
    expect(result).not.toBeNull();
    // Should contain one of the tool names (the first pending run)
    expect(result!.promptText).toMatch(/shell|file_edit/);
  });

  test('excludes approve_always action when persistentDecisionsAllowed is false', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      ...sampleConfirmation,
      persistentDecisionsAllowed: false,
    });

    const result = getChannelApprovalPrompt('conv-1');
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual(['approve_once', 'reject']);
    expect(result!.plainTextFallback).not.toContain('always');
  });

  test('includes approve_always when persistentDecisionsAllowed is undefined', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      ...sampleConfirmation,
      // persistentDecisionsAllowed not set — defaults to allowed
    });

    const result = getChannelApprovalPrompt('conv-1');
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual([
      'approve_once',
      'approve_always',
      'reject',
    ]);
    expect(result!.plainTextFallback).toContain('always');
  });

  test('includes approve_always when persistentDecisionsAllowed is true', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      ...sampleConfirmation,
      persistentDecisionsAllowed: true,
    });

    const result = getChannelApprovalPrompt('conv-1');
    expect(result).not.toBeNull();
    expect(result!.actions.map((a) => a.id)).toEqual([
      'approve_once',
      'approve_always',
      'reject',
    ]);
  });

  test('does not return prompts for other conversations', () => {
    ensureConversation('conv-1');
    ensureConversation('conv-2');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const result = getChannelApprovalPrompt('conv-2');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. buildApprovalUIMetadata
// ═══════════════════════════════════════════════════════════════════════════

describe('buildApprovalUIMetadata', () => {
  test('maps prompt and run info to UI metadata', () => {
    const prompt: ChannelApprovalPrompt = {
      promptText: 'Allow shell?',
      actions: [
        { id: 'approve_once', label: 'Approve once' },
        { id: 'reject', label: 'Reject' },
      ],
      plainTextFallback: 'Reply yes or no.',
    };

    const runInfo: PendingRunInfo = {
      runId: 'run-123',
      requestId: 'req-abc',
      toolName: 'shell',
      input: { command: 'ls' },
      riskLevel: 'low',
    };

    const metadata = buildApprovalUIMetadata(prompt, runInfo);
    expect(metadata.runId).toBe('run-123');
    expect(metadata.requestId).toBe('req-abc');
    expect(metadata.actions).toEqual(prompt.actions);
    expect(metadata.plainTextFallback).toBe('Reply yes or no.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. handleChannelDecision
// ═══════════════════════════════════════════════════════════════════════════

describe('handleChannelDecision', () => {
  beforeEach(() => {
    resetTables();
  });

  test('returns applied: false when no pending runs exist', () => {
    ensureConversation('conv-1');
    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_once',
      source: 'plain_text',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);
    expect(result.applied).toBe(false);
    expect(result.runId).toBeUndefined();
  });

  test('approves once via orchestrator.submitDecision with "allow"', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_once',
      source: 'plain_text',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);
    expect(result.applied).toBe(true);
    expect(result.runId).toBe(run.id);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');
  });

  test('rejects via orchestrator.submitDecision with "deny"', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'reject',
      source: 'telegram_button',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);
    expect(result.applied).toBe(true);
    expect(result.runId).toBe(run.id);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'deny');
  });

  test('approve_always adds a trust rule and submits "allow"', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      ...sampleConfirmation,
      executionTarget: 'sandbox',
      allowlistOptions: [{ label: 'rm pattern', pattern: 'rm -rf *' }],
      scopeOptions: [{ label: 'project dir', scope: '/tmp/project' }],
    });

    const addRuleSpy = spyOn(trustStore, 'addRule');
    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_always',
      source: 'plain_text',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);
    expect(result.applied).toBe(true);
    expect(result.runId).toBe(run.id);

    // Trust rule added with first allowlist and scope option
    expect(addRuleSpy).toHaveBeenCalledWith(
      'shell',
      'rm -rf *',
      '/tmp/project',
      'allow',
      100,
      { executionTarget: 'sandbox' },
    );

    // The run is still approved with a simple "allow"
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    addRuleSpy.mockRestore();
  });

  test('approve_always does not persist rule when no allowlist/scope options are available', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      toolName: 'bash',
      toolUseId: 'req-no-opts',
      input: { command: 'echo hi' },
      riskLevel: 'low',
      // No allowlistOptions or scopeOptions — should not create blanket rule
    });

    const addRuleSpy = spyOn(trustStore, 'addRule');
    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_always',
      source: 'telegram_button',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);

    // Rule should NOT be persisted — no blanket "**"/"everywhere" fallback
    expect(addRuleSpy).not.toHaveBeenCalled();

    // The decision should still be applied as a one-time approval
    expect(result.applied).toBe(true);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    addRuleSpy.mockRestore();
  });

  test('approve_always does not persist rule when allowlist/scope are empty arrays', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      toolName: 'bash',
      toolUseId: 'req-empty-opts',
      input: { command: 'echo hi' },
      riskLevel: 'low',
      allowlistOptions: [],
      scopeOptions: [],
    });

    const addRuleSpy = spyOn(trustStore, 'addRule');
    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_always',
      source: 'telegram_button',
    };

    handleChannelDecision('conv-1', decision, orchestrator);

    // Empty arrays should not trigger rule persistence
    expect(addRuleSpy).not.toHaveBeenCalled();
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    addRuleSpy.mockRestore();
  });

  test('approve_always does not persist rule when persistentDecisionsAllowed is false', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, {
      ...sampleConfirmation,
      persistentDecisionsAllowed: false,
    });

    const addRuleSpy = spyOn(trustStore, 'addRule');
    const orchestrator = makeMockOrchestrator();
    const decision: ApprovalDecisionResult = {
      action: 'approve_always',
      source: 'telegram_button',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);

    // Persistence blocked — rule must not be created
    expect(addRuleSpy).not.toHaveBeenCalled();

    // The current invocation should still be approved (one-time allow)
    expect(result.applied).toBe(true);
    expect(orchestrator.submitDecision).toHaveBeenCalledWith(run.id, 'allow');

    addRuleSpy.mockRestore();
  });

  test('returns applied: false when orchestrator cannot apply decision', () => {
    ensureConversation('conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const orchestrator = makeMockOrchestrator('no_pending_decision');
    const decision: ApprovalDecisionResult = {
      action: 'approve_once',
      source: 'plain_text',
    };

    const result = handleChannelDecision('conv-1', decision, orchestrator);
    expect(result.applied).toBe(false);
    expect(result.runId).toBe(run.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. buildReminderPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe('buildReminderPrompt', () => {
  test('prefixes promptText with a reminder', () => {
    const original: ChannelApprovalPrompt = {
      promptText: 'Allow shell?',
      actions: [
        { id: 'approve_once', label: 'Approve once' },
        { id: 'reject', label: 'Reject' },
      ],
      plainTextFallback: 'Reply yes or no.',
    };

    const reminder = buildReminderPrompt(original);
    expect(reminder.promptText).toContain("I'm still waiting");
    expect(reminder.promptText).toContain('Allow shell?');
  });

  test('preserves the original actions', () => {
    const original: ChannelApprovalPrompt = {
      promptText: 'Approve file_edit?',
      actions: [
        { id: 'approve_once', label: 'Approve once' },
        { id: 'approve_always', label: 'Approve always' },
        { id: 'reject', label: 'Reject' },
      ],
      plainTextFallback: 'Reply yes, always, or no.',
    };

    const reminder = buildReminderPrompt(original);
    expect(reminder.actions).toEqual(original.actions);
  });

  test('prefixes plainTextFallback with a reminder', () => {
    const original: ChannelApprovalPrompt = {
      promptText: 'Allow bash?',
      actions: [],
      plainTextFallback: 'Reply yes or no.',
    };

    const reminder = buildReminderPrompt(original);
    expect(reminder.plainTextFallback).toContain("I'm still waiting");
    expect(reminder.plainTextFallback).toContain('Reply yes or no.');
  });

  test('does not mutate the original prompt', () => {
    const original: ChannelApprovalPrompt = {
      promptText: 'Allow grep?',
      actions: [{ id: 'approve_once', label: 'Approve once' }],
      plainTextFallback: 'Reply yes.',
    };

    const originalText = original.promptText;
    buildReminderPrompt(original);
    expect(original.promptText).toBe(originalText);
  });
});
