import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Test setup — temp directory and mock modules
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-rotation-test-${randomBytes(4).toString('hex')}`);
const DB_PATH = join(TEST_DIR, 'assistant.db');

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => TEST_DIR,
  getDbPath: () => DB_PATH,
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  ensureDataDir: () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  },
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

import { initializeDb } from '../memory/db.js';
import {
  recordToolInvocation,
  getRecentInvocations,
  rotateToolInvocations,
} from '../memory/tool-usage-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addInvocation(ageMs: number): void {
  // Insert directly with a specific timestamp in the past
  const db = new Database(DB_PATH);
  const id = randomBytes(8).toString('hex');
  const createdAt = Date.now() - ageMs;
  db.prepare(
    `INSERT INTO tool_invocations (id, conversation_id, tool_name, input, result, decision, risk_level, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'conv-1', 'shell', '{"command":"echo hi"}', 'hi', 'allow', 'Low', 100, createdAt);
  db.close();
}

function clearTable(): void {
  const db = new Database(DB_PATH);
  db.run('DELETE FROM tool_invocations');
  db.close();
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit log rotation', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DIR, 'logs'), { recursive: true });
    initializeDb();
    // Insert a conversations row so FK-enforced ORM inserts succeed
    const db = new Database(DB_PATH);
    db.run(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'test', ${Date.now()}, ${Date.now()})`);
    db.close();
  });

  beforeEach(() => {
    clearTable();
  });

  // TEST_DIR is in os.tmpdir() — let the OS handle cleanup.
  // Deleting it here would trigger ENOENT in other test files because
  // the platform.js mock leaks getDataDir() → TEST_DIR globally.

  test('returns 0 when retentionDays is 0 (retain forever)', () => {
    addInvocation(100 * ONE_DAY_MS); // 100 days old
    const deleted = rotateToolInvocations(0);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test('returns 0 when retentionDays is negative', () => {
    addInvocation(100 * ONE_DAY_MS);
    const deleted = rotateToolInvocations(-5);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test('deletes records older than retentionDays', () => {
    addInvocation(10 * ONE_DAY_MS); // 10 days old — should be deleted with 7-day retention
    addInvocation(3 * ONE_DAY_MS);  // 3 days old — should be kept
    addInvocation(1 * ONE_DAY_MS);  // 1 day old — should be kept

    const deleted = rotateToolInvocations(7);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(2);
  });

  test('keeps all records when none exceed retention', () => {
    addInvocation(1 * ONE_DAY_MS);
    addInvocation(2 * ONE_DAY_MS);
    addInvocation(3 * ONE_DAY_MS);

    const deleted = rotateToolInvocations(30);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(3);
  });

  test('deletes all records when all exceed retention', () => {
    addInvocation(60 * ONE_DAY_MS);
    addInvocation(90 * ONE_DAY_MS);
    addInvocation(120 * ONE_DAY_MS);

    const deleted = rotateToolInvocations(30);
    expect(deleted).toBe(3);
    expect(getRecentInvocations(100).length).toBe(0);
  });

  test('returns 0 when table is empty', () => {
    const deleted = rotateToolInvocations(7);
    expect(deleted).toBe(0);
  });

  test('handles 1-day retention (deletes everything older than 24h)', () => {
    addInvocation(2 * ONE_DAY_MS);  // 2 days old — delete
    addInvocation(12 * 60 * 60 * 1000); // 12 hours old — keep

    const deleted = rotateToolInvocations(1);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test('works with recordToolInvocation (via ORM)', () => {
    // Add one via the ORM
    recordToolInvocation({
      conversationId: 'conv-1',
      toolName: 'shell',
      input: '{"command":"ls"}',
      result: 'output',
      decision: 'allow',
      riskLevel: 'Low',
      durationMs: 50,
    });

    // This record was just created, so it should not be rotated
    const deleted = rotateToolInvocations(1);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });
});
