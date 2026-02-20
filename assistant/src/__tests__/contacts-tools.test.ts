import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'contacts-tools-test-'));

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
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({ memory: {} }),
}));

import type { Database } from 'bun:sqlite';
import { initializeDb, getDb, resetDb } from '../memory/db.js';
import type { ToolContext } from '../tools/types.js';
import { executeContactUpsert } from '../tools/contacts/contact-upsert.js';
import { executeContactSearch } from '../tools/contacts/contact-search.js';
import { executeContactMerge } from '../tools/contacts/contact-merge.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: '/tmp',
  sessionId: 'test-session',
  conversationId: 'test-conversation',
};

function clearContacts(): void {
  getRawDb().run('DELETE FROM contact_channels');
  getRawDb().run('DELETE FROM contacts');
}

// ── contact_upsert ──────────────────────────────────────────────────

describe('contact_upsert tool', () => {
  beforeEach(clearContacts);

  test('creates a new contact with display name only', async () => {
    const result = await executeContactUpsert({ display_name: 'Alice' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Created contact');
    expect(result.content).toContain('Alice');
    expect(result.content).toContain('Importance: 0.50');
  });

  test('creates a contact with all fields', async () => {
    const result = await executeContactUpsert({
      display_name: 'Bob',
      relationship: 'colleague',
      importance: 0.8,
      response_expectation: 'within_hours',
      preferred_tone: 'professional',
      channels: [
        { type: 'email', address: 'bob@example.com', is_primary: true },
        { type: 'slack', address: '@bob' },
      ],
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Bob');
    expect(result.content).toContain('colleague');
    expect(result.content).toContain('0.80');
    expect(result.content).toContain('within_hours');
    expect(result.content).toContain('professional');
    expect(result.content).toContain('email: bob@example.com');
    expect(result.content).toContain('slack: @bob');
  });

  test('updates an existing contact by ID', async () => {
    const createResult = await executeContactUpsert({ display_name: 'Charlie' }, ctx);
    expect(createResult.isError).toBe(false);

    // Extract ID from output
    const idMatch = createResult.content.match(/Contact (\S+)/);
    expect(idMatch).not.toBeNull();
    const contactId = idMatch![1];

    const updateResult = await executeContactUpsert({
      id: contactId,
      display_name: 'Charlie Updated',
      importance: 0.9,
    }, ctx);

    expect(updateResult.isError).toBe(false);
    expect(updateResult.content).toContain('Updated contact');
    expect(updateResult.content).toContain('Charlie Updated');
    expect(updateResult.content).toContain('0.90');
  });

  test('auto-matches by channel address on create', async () => {
    // Create a contact with an email
    await executeContactUpsert({
      display_name: 'Diana',
      channels: [{ type: 'email', address: 'diana@example.com' }],
    }, ctx);

    // Upsert with same email but different display name
    const result = await executeContactUpsert({
      display_name: 'Diana Updated',
      channels: [{ type: 'email', address: 'diana@example.com' }],
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Updated contact');
    expect(result.content).toContain('Diana Updated');

    // Should still be just 1 contact
    const count = getRawDb().query('SELECT COUNT(*) as c FROM contacts').get() as { c: number };
    expect(count.c).toBe(1);
  });

  test('rejects missing display_name', async () => {
    const result = await executeContactUpsert({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('display_name is required');
  });

  test('rejects empty display_name', async () => {
    const result = await executeContactUpsert({ display_name: '   ' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('display_name is required');
  });

  test('rejects importance out of range', async () => {
    const result = await executeContactUpsert({
      display_name: 'Test',
      importance: 1.5,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('importance must be a number between 0 and 1');
  });

  test('rejects negative importance', async () => {
    const result = await executeContactUpsert({
      display_name: 'Test',
      importance: -0.1,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('importance must be a number between 0 and 1');
  });
});

// ── contact_search ──────────────────────────────────────────────────

describe('contact_search tool', () => {
  beforeEach(clearContacts);

  test('searches by display name', async () => {
    await executeContactUpsert({ display_name: 'Alice Smith' }, ctx);
    await executeContactUpsert({ display_name: 'Bob Jones' }, ctx);

    const result = await executeContactSearch({ query: 'Alice' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Alice Smith');
    expect(result.content).not.toContain('Bob Jones');
  });

  test('searches by channel address', async () => {
    await executeContactUpsert({
      display_name: 'Charlie',
      channels: [{ type: 'email', address: 'charlie@example.com' }],
    }, ctx);

    const result = await executeContactSearch({ channel_address: 'charlie@example' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Charlie');
  });

  test('searches by relationship', async () => {
    await executeContactUpsert({ display_name: 'Diana', relationship: 'friend' }, ctx);
    await executeContactUpsert({ display_name: 'Eve', relationship: 'colleague' }, ctx);

    const result = await executeContactSearch({ relationship: 'friend' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Diana');
    expect(result.content).not.toContain('Eve');
  });

  test('returns no results message when nothing matches', async () => {
    await executeContactUpsert({ display_name: 'Existing' }, ctx);

    const result = await executeContactSearch({ query: 'Nonexistent' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No contacts found');
  });

  test('rejects search with no criteria', async () => {
    const result = await executeContactSearch({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('At least one search criterion is required');
  });

  test('searches by channel address with type filter', async () => {
    await executeContactUpsert({
      display_name: 'Frank',
      channels: [
        { type: 'email', address: 'frank@example.com' },
        { type: 'slack', address: 'frank@example.com' },
      ],
    }, ctx);

    const result = await executeContactSearch({
      channel_address: 'frank@example',
      channel_type: 'slack',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Frank');
  });
});

// ── contact_merge ───────────────────────────────────────────────────

describe('contact_merge tool', () => {
  beforeEach(clearContacts);

  function extractContactId(result: { content: string }): string {
    const match = result.content.match(/Contact (\S+)/);
    expect(match).not.toBeNull();
    return match![1];
  }

  test('merges two contacts', async () => {
    const r1 = await executeContactUpsert({
      display_name: 'Alice (Email)',
      importance: 0.7,
      channels: [{ type: 'email', address: 'alice@example.com' }],
    }, ctx);
    const r2 = await executeContactUpsert({
      display_name: 'Alice (Slack)',
      importance: 0.9,
      channels: [{ type: 'slack', address: '@alice' }],
    }, ctx);

    const keepId = extractContactId(r1);
    const mergeId = extractContactId(r2);

    const result = await executeContactMerge({
      keep_id: keepId,
      merge_id: mergeId,
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Merged');
    expect(result.content).toContain('Importance: 0.90'); // takes higher importance
    expect(result.content).toContain('email: alice@example.com');
    expect(result.content).toContain('slack: @alice');

    // Verify donor is deleted
    const count = getRawDb().query('SELECT COUNT(*) as c FROM contacts').get() as { c: number };
    expect(count.c).toBe(1);
  });

  test('rejects missing keep_id', async () => {
    const result = await executeContactMerge({ merge_id: 'some-id' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('keep_id is required');
  });

  test('rejects missing merge_id', async () => {
    const result = await executeContactMerge({ keep_id: 'some-id' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('merge_id is required');
  });

  test('returns error for nonexistent keep_id', async () => {
    const r = await executeContactUpsert({ display_name: 'Exists' }, ctx);
    const existingId = extractContactId(r);

    const result = await executeContactMerge({
      keep_id: 'nonexistent',
      merge_id: existingId,
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('returns error for nonexistent merge_id', async () => {
    const r = await executeContactUpsert({ display_name: 'Exists' }, ctx);
    const existingId = extractContactId(r);

    const result = await executeContactMerge({
      keep_id: existingId,
      merge_id: 'nonexistent',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });
});
