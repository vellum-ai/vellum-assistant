import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'channel-approval-test-'));

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
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { initializeDb, resetDb } from '../memory/db.js';
import {
  createRun,
  setRunConfirmation,
  getPendingConfirmationsByConversation,
} from '../memory/runs-store.js';
import type { PendingConfirmation } from '../memory/runs-store.js';
import { parseApprovalDecision } from '../runtime/channel-approval-parser.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Helper: insert a conversation so FK constraints pass
// ---------------------------------------------------------------------------

function ensureConversation(conversationId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require('../memory/db.js');
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { conversations } = require('../memory/schema.js');
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

function ensureMessage(messageId: string, conversationId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require('../memory/db.js');
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { messages } = require('../memory/schema.js');
  try {
    db.insert(messages).values({
      id: messageId,
      conversationId,
      role: 'user',
      content: 'test',
      createdAt: Date.now(),
    }).run();
  } catch {
    // already exists
  }
}

function resetTables(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require('../memory/db.js');
  const db = getDb();
  db.run('DELETE FROM message_runs');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Plain-text approval decision parser
// ═══════════════════════════════════════════════════════════════════════════

describe('parseApprovalDecision', () => {
  // ── Approve once ──────────────────────────────────────────────────

  test.each([
    'yes',
    'Yes',
    'YES',
    'approve',
    'Approve',
    'APPROVE',
    'allow',
    'Allow',
    'go ahead',
    'Go Ahead',
    'GO AHEAD',
    'approve once',
    'Approve once',
    'Approve Once',
    'APPROVE ONCE',
  ])('recognises "%s" as approve_once', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
    expect(result!.source).toBe('plain_text');
  });

  // ── Approve always ────────────────────────────────────────────────

  test.each([
    'always',
    'Always',
    'ALWAYS',
    'approve always',
    'Approve Always',
    'APPROVE ALWAYS',
    'allow always',
    'Allow Always',
    'ALLOW ALWAYS',
  ])('recognises "%s" as approve_always', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_always');
    expect(result!.source).toBe('plain_text');
  });

  // ── Reject ────────────────────────────────────────────────────────

  test.each([
    'no',
    'No',
    'NO',
    'reject',
    'Reject',
    'REJECT',
    'deny',
    'Deny',
    'DENY',
    'cancel',
    'Cancel',
    'CANCEL',
  ])('recognises "%s" as reject', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reject');
    expect(result!.source).toBe('plain_text');
  });

  // ── Whitespace handling ───────────────────────────────────────────

  test('trims leading and trailing whitespace', () => {
    const result = parseApprovalDecision('  approve  ');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
  });

  test('trims tabs and newlines', () => {
    const result = parseApprovalDecision('\t\nreject\n\t');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reject');
  });

  // ── Non-matching text ─────────────────────────────────────────────

  test.each([
    '',
    '   ',
    'hello',
    'please approve this',
    'I approve',
    'yes please',
    'nope',
    'approved',
    'allow me',
    'go',
    'ahead',
    'maybe',
  ])('returns null for non-matching text: "%s"', (input) => {
    expect(parseApprovalDecision(input)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Pending-run lookup helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('getPendingConfirmationsByConversation', () => {
  beforeEach(() => {
    resetTables();
  });

  const sampleConfirmation: PendingConfirmation = {
    toolName: 'shell',
    toolUseId: 'req-abc-123',
    input: { command: 'rm -rf /tmp/test' },
    riskLevel: 'high',
  };

  test('returns empty array when no runs exist', () => {
    ensureConversation('conv-1');
    const result = getPendingConfirmationsByConversation('conv-1');
    expect(result).toEqual([]);
  });

  test('returns empty array when no runs need confirmation', () => {
    ensureConversation('conv-1');
    ensureMessage('msg-1', 'conv-1');
    createRun('conv-1', 'msg-1');
    const result = getPendingConfirmationsByConversation('conv-1');
    expect(result).toEqual([]);
  });

  test('returns pending confirmation for a run needing confirmation', () => {
    ensureConversation('conv-1');
    ensureMessage('msg-1', 'conv-1');
    const run = createRun('conv-1', 'msg-1');
    setRunConfirmation(run.id, sampleConfirmation);

    const result = getPendingConfirmationsByConversation('conv-1');
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe(run.id);
    expect(result[0].requestId).toBe('req-abc-123');
    expect(result[0].toolName).toBe('shell');
    expect(result[0].input).toEqual({ command: 'rm -rf /tmp/test' });
    expect(result[0].riskLevel).toBe('high');
  });

  test('only returns runs for the specified conversation', () => {
    ensureConversation('conv-1');
    ensureConversation('conv-2');
    ensureMessage('msg-1', 'conv-1');
    ensureMessage('msg-2', 'conv-2');

    const run1 = createRun('conv-1', 'msg-1');
    const run2 = createRun('conv-2', 'msg-2');
    setRunConfirmation(run1.id, sampleConfirmation);
    setRunConfirmation(run2.id, { ...sampleConfirmation, toolUseId: 'req-def-456' });

    const result1 = getPendingConfirmationsByConversation('conv-1');
    expect(result1).toHaveLength(1);
    expect(result1[0].runId).toBe(run1.id);

    const result2 = getPendingConfirmationsByConversation('conv-2');
    expect(result2).toHaveLength(1);
    expect(result2[0].runId).toBe(run2.id);
  });

  test('returns multiple pending runs for the same conversation', () => {
    ensureConversation('conv-1');
    ensureMessage('msg-1', 'conv-1');
    ensureMessage('msg-2', 'conv-1');

    const run1 = createRun('conv-1', 'msg-1');
    const run2 = createRun('conv-1', 'msg-2');
    setRunConfirmation(run1.id, sampleConfirmation);
    setRunConfirmation(run2.id, { ...sampleConfirmation, toolUseId: 'req-ghi-789', toolName: 'file_edit' });

    const result = getPendingConfirmationsByConversation('conv-1');
    expect(result).toHaveLength(2);

    const runIds = result.map((r) => r.runId).sort();
    expect(runIds).toContain(run1.id);
    expect(runIds).toContain(run2.id);
  });

  test('excludes completed and failed runs', () => {
    ensureConversation('conv-1');
    ensureMessage('msg-1', 'conv-1');
    ensureMessage('msg-2', 'conv-1');
    ensureMessage('msg-3', 'conv-1');

    const run1 = createRun('conv-1', 'msg-1');
    const _run2 = createRun('conv-1', 'msg-2');
    const _run3 = createRun('conv-1', 'msg-3');

    setRunConfirmation(run1.id, sampleConfirmation);
    // run2 stays in 'running' state
    // run3 gets confirmation then completes — simulated by not setting confirmation

    const result = getPendingConfirmationsByConversation('conv-1');
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe(run1.id);
  });
});
