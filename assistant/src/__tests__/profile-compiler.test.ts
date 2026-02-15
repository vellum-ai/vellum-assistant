import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'profile-compiler-test-'));

let profileEnabled = false;
let profileMaxInjectTokens = 800;

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

import { DEFAULT_CONFIG } from '../config/defaults.js';

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      profile: {
        enabled: profileEnabled,
        maxInjectTokens: profileMaxInjectTokens,
      },
    },
  }),
}));

import { estimateTextTokens } from '../context/token-estimator.js';
import { getDb, initializeDb } from '../memory/db.js';
import { compileDynamicProfile } from '../memory/profile-compiler.js';
import { memoryItems } from '../memory/schema.js';

initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM memory_item_sources');
  db.run('DELETE FROM memory_items');
}

function insertItem(input: {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  verificationState: string;
  status?: string;
  invalidAt?: number | null;
  scopeId?: string;
  importance?: number;
}) {
  const now = Date.now();
  const db = getDb();
  db.insert(memoryItems).values({
    id: input.id,
    kind: input.kind,
    subject: input.subject,
    statement: input.statement,
    status: input.status ?? 'active',
    confidence: 0.8,
    importance: input.importance ?? 0.6,
    fingerprint: `fp-${input.id}`,
    verificationState: input.verificationState,
    scopeId: input.scopeId ?? 'default',
    firstSeenAt: now - 1000,
    lastSeenAt: now,
    validFrom: now - 1000,
    invalidAt: input.invalidAt ?? null,
  }).run();
}

describe('profile-compiler', () => {
  beforeEach(() => {
    resetTables();
    profileEnabled = false;
    profileMaxInjectTokens = 800;
  });

  test('returns empty profile when feature is disabled', () => {
    insertItem({
      id: 'profile-disabled-1',
      kind: 'profile',
      subject: 'timezone',
      statement: 'User timezone is PST.',
      verificationState: 'user_confirmed',
    });

    const compiled = compileDynamicProfile();
    expect(compiled.text).toBe('');
    expect(compiled.selectedCount).toBe(0);
    expect(compiled.tokenEstimate).toBe(0);
  });

  test('selects active trusted memories and prefers stronger verification states', () => {
    profileEnabled = true;

    insertItem({
      id: 'profile-strong',
      kind: 'preference',
      subject: 'package manager',
      statement: 'Use pnpm for workspace installs.',
      verificationState: 'user_confirmed',
      importance: 0.9,
    });
    insertItem({
      id: 'profile-weak',
      kind: 'preference',
      subject: 'package manager',
      statement: 'Use npm for workspace installs.',
      verificationState: 'assistant_inferred',
      importance: 0.7,
    });
    insertItem({
      id: 'profile-reported',
      kind: 'profile',
      subject: 'timezone',
      statement: 'Timezone is America/Los_Angeles.',
      verificationState: 'user_reported',
      importance: 0.8,
    });
    insertItem({
      id: 'profile-superseded',
      kind: 'profile',
      subject: 'location',
      statement: 'Location is Seattle.',
      verificationState: 'user_confirmed',
      status: 'superseded',
    });
    insertItem({
      id: 'profile-invalid',
      kind: 'profile',
      subject: 'editor',
      statement: 'Primary editor is Neovim.',
      verificationState: 'user_confirmed',
      invalidAt: Date.now(),
    });
    insertItem({
      id: 'profile-untrusted',
      kind: 'profile',
      subject: 'phone',
      statement: 'Phone number is 555-0100.',
      verificationState: 'legacy_import',
    });
    insertItem({
      id: 'profile-project',
      kind: 'project',
      subject: 'repo',
      statement: 'Project uses TypeScript.',
      verificationState: 'user_confirmed',
    });

    const compiled = compileDynamicProfile();
    expect(compiled.selectedCount).toBe(2);
    expect(compiled.text).toContain('package manager: Use pnpm');
    expect(compiled.text).toContain('timezone: Timezone is America/Los_Angeles');
    expect(compiled.text).not.toContain('Use npm');
    expect(compiled.text).not.toContain('Location is Seattle');
    expect(compiled.text).not.toContain('Project uses TypeScript');
  });

  test('enforces strict token cap', () => {
    profileEnabled = true;
    profileMaxInjectTokens = 500;

    insertItem({
      id: 'profile-budget-1',
      kind: 'profile',
      subject: 'timezone',
      statement: 'Timezone is Pacific time with daylight savings observed.',
      verificationState: 'user_confirmed',
      importance: 0.9,
    });
    insertItem({
      id: 'profile-budget-2',
      kind: 'preference',
      subject: 'coding style',
      statement: 'Prefers explicit types and no wildcard exports.',
      verificationState: 'user_confirmed',
      importance: 0.8,
    });
    insertItem({
      id: 'profile-budget-3',
      kind: 'constraint',
      subject: 'deployment',
      statement: 'Never deploy on Friday afternoons.',
      verificationState: 'user_confirmed',
      importance: 0.7,
    });

    const full = compileDynamicProfile({ maxInjectTokensOverride: 500 });
    expect(full.selectedCount).toBeGreaterThan(1);

    const tightBudget = Math.max(1, full.tokenEstimate - 5);
    const limited = compileDynamicProfile({ maxInjectTokensOverride: tightBudget });

    expect(limited.tokenEstimate).toBeLessThanOrEqual(tightBudget);
    expect(estimateTextTokens(limited.text)).toBeLessThanOrEqual(tightBudget);
    expect(limited.selectedCount).toBeLessThan(full.selectedCount);
  });

  test('uses lower-ranked fallback for same subject when top candidate exceeds budget', () => {
    profileEnabled = true;

    insertItem({
      id: 'profile-long-primary',
      kind: 'profile',
      subject: 'deployment policy',
      statement: 'Prefer geographically isolated blue-green rollout windows with mandatory canary burn-in and staged health-check gates before each region is promoted.',
      verificationState: 'user_confirmed',
      importance: 0.95,
    });
    insertItem({
      id: 'profile-short-fallback',
      kind: 'profile',
      subject: 'deployment policy',
      statement: 'Deploy only on weekdays.',
      verificationState: 'user_confirmed',
      importance: 0.7,
    });

    const budget = estimateTextTokens('[Dynamic User Profile]\n- deployment policy: Deploy only on weekdays.') + 2;
    const compiled = compileDynamicProfile({ maxInjectTokensOverride: budget });

    expect(compiled.tokenEstimate).toBeLessThanOrEqual(budget);
    expect(compiled.text).toContain('deployment policy: Deploy only on weekdays.');
    expect(compiled.text).not.toContain('geographically isolated blue-green rollout');
  });
});
