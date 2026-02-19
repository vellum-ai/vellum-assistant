import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'schedule-store-test-'));

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

import { initializeDb, getDb } from '../memory/db.js';
import {
  createSchedule,
  getSchedule,
  updateSchedule,
  claimDueSchedules,
} from '../schedule/schedule-store.js';

initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import('bun:sqlite').Database {
  return (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
}

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ── Cron backward compatibility ─────────────────────────────────────

describe('createSchedule (cron, legacy API)', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM cron_runs');
    db.run('DELETE FROM cron_jobs');
  });

  test('creates a cron schedule using only cronExpression', () => {
    const job = createSchedule({
      name: 'Morning ping',
      cronExpression: '0 9 * * *',
      message: 'good morning',
    });

    expect(job.syntax).toBe('cron');
    expect(job.expression).toBe('0 9 * * *');
    expect(job.cronExpression).toBe('0 9 * * *');
    expect(job.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(job.enabled).toBe(true);
  });

  test('persisted cron schedule is retrievable with new fields', () => {
    const job = createSchedule({
      name: 'Hourly',
      cronExpression: '0 * * * *',
      message: 'hourly check',
    });

    const retrieved = getSchedule(job.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.syntax).toBe('cron');
    expect(retrieved!.expression).toBe('0 * * * *');
    expect(retrieved!.cronExpression).toBe('0 * * * *');
  });

  test('stores schedule_syntax in the DB row', () => {
    const job = createSchedule({
      name: 'Syntax check',
      cronExpression: '*/5 * * * *',
      message: 'test',
    });

    const raw = getRawDb().query('SELECT schedule_syntax FROM cron_jobs WHERE id = ?').get(job.id) as { schedule_syntax: string } | null;
    expect(raw).not.toBeNull();
    expect(raw!.schedule_syntax).toBe('cron');
  });

  test('rejects invalid cron expression', () => {
    expect(() => createSchedule({
      name: 'Bad cron',
      cronExpression: 'not-a-cron',
      message: 'fail',
    })).toThrow();
  });
});

// ── RRULE schedule creation ──────────────────────────────────────────

describe('createSchedule (RRULE)', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM cron_runs');
    db.run('DELETE FROM cron_jobs');
  });

  test('creates an RRULE schedule with syntax + expression', () => {
    const rrule = 'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=1';
    const job = createSchedule({
      name: 'Daily RRULE',
      cronExpression: rrule,
      message: 'rrule test',
      syntax: 'rrule',
      expression: rrule,
    });

    expect(job.syntax).toBe('rrule');
    expect(job.expression).toBe(rrule);
    expect(job.cronExpression).toBe(rrule);
    expect(job.nextRunAt).toBeGreaterThan(0);
  });

  test('stores rrule syntax in DB', () => {
    const rrule = 'DTSTART:20260101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO';
    const job = createSchedule({
      name: 'Weekly RRULE',
      cronExpression: rrule,
      message: 'weekly',
      syntax: 'rrule',
      expression: rrule,
    });

    const raw = getRawDb().query('SELECT schedule_syntax, cron_expression FROM cron_jobs WHERE id = ?').get(job.id) as { schedule_syntax: string; cron_expression: string } | null;
    expect(raw).not.toBeNull();
    expect(raw!.schedule_syntax).toBe('rrule');
    expect(raw!.cron_expression).toBe(rrule);
  });

  test('rejects RRULE without DTSTART', () => {
    expect(() => createSchedule({
      name: 'No dtstart',
      cronExpression: 'RRULE:FREQ=DAILY',
      message: 'fail',
      syntax: 'rrule',
      expression: 'RRULE:FREQ=DAILY',
    })).toThrow();
  });
});

// ── updateSchedule with syntax/expression ────────────────────────────

describe('updateSchedule', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM cron_runs');
    db.run('DELETE FROM cron_jobs');
  });

  test('updating cronExpression (legacy path) still works', () => {
    const job = createSchedule({
      name: 'Update test',
      cronExpression: '0 9 * * *',
      message: 'update me',
    });

    const updated = updateSchedule(job.id, { cronExpression: '0 10 * * *' });
    expect(updated).not.toBeNull();
    expect(updated!.cronExpression).toBe('0 10 * * *');
    expect(updated!.expression).toBe('0 10 * * *');
    expect(updated!.syntax).toBe('cron');
    // nextRunAt should have been recomputed
    expect(updated!.nextRunAt).not.toBe(job.nextRunAt);
  });

  test('updating syntax + expression switches to RRULE', () => {
    const job = createSchedule({
      name: 'Switch to RRULE',
      cronExpression: '0 9 * * *',
      message: 'switching',
    });

    const rrule = 'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=2';
    const updated = updateSchedule(job.id, {
      syntax: 'rrule',
      expression: rrule,
    });

    expect(updated).not.toBeNull();
    expect(updated!.syntax).toBe('rrule');
    expect(updated!.expression).toBe(rrule);
    expect(updated!.cronExpression).toBe(rrule);
    expect(updated!.nextRunAt).toBeGreaterThan(0);

    // Confirm DB has the right syntax
    const raw = getRawDb().query('SELECT schedule_syntax FROM cron_jobs WHERE id = ?').get(job.id) as { schedule_syntax: string } | null;
    expect(raw!.schedule_syntax).toBe('rrule');
  });

  test('rejects invalid expression on update', () => {
    const job = createSchedule({
      name: 'Reject bad update',
      cronExpression: '0 9 * * *',
      message: 'nope',
    });

    expect(() => updateSchedule(job.id, {
      syntax: 'rrule',
      expression: 'RRULE:FREQ=DAILY',
    })).toThrow();
  });
});

// ── claimDueSchedules ────────────────────────────────────────────────

describe('claimDueSchedules', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM cron_runs');
    db.run('DELETE FROM cron_jobs');
  });

  test('claims due cron schedules and advances nextRunAt', () => {
    const job = createSchedule({
      name: 'Claim cron',
      cronExpression: '* * * * *',
      message: 'cron claim test',
    });

    // Force the schedule to be due
    getRawDb().run('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [Date.now() - 1000, job.id]);

    const claimed = claimDueSchedules(Date.now());
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe('cron');
    expect(claimed[0].nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });

  test('claims due RRULE schedules and advances nextRunAt', () => {
    // Use an RRULE that fires every minute (roughly), with a DTSTART in the past
    const rrule = 'DTSTART:20250101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=1';
    const job = createSchedule({
      name: 'Claim RRULE',
      cronExpression: rrule,
      message: 'rrule claim test',
      syntax: 'rrule',
      expression: rrule,
    });

    // Force the schedule to be due
    const pastTs = Date.now() - 60_000;
    getRawDb().run('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [pastTs, job.id]);

    const now = Date.now();
    const claimed = claimDueSchedules(now);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].syntax).toBe('rrule');
    // nextRunAt should be in the future (at or after now)
    expect(claimed[0].nextRunAt).toBeGreaterThanOrEqual(now);
  });

  test('does not claim schedules that are not yet due', () => {
    createSchedule({
      name: 'Not due yet',
      cronExpression: '0 9 * * *',
      message: 'future schedule',
    });

    const claimed = claimDueSchedules(0); // timestamp 0 means nothing is due
    expect(claimed.length).toBe(0);
  });

  test('optimistic lock prevents double-claiming', () => {
    const job = createSchedule({
      name: 'Double claim',
      cronExpression: '* * * * *',
      message: 'no double',
    });

    getRawDb().run('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [Date.now() - 1000, job.id]);

    const first = claimDueSchedules(Date.now());
    expect(first.length).toBe(1);

    // Second claim should find nothing since nextRunAt was advanced
    const second = claimDueSchedules(Date.now() - 500);
    expect(second.length).toBe(0);
  });
});
