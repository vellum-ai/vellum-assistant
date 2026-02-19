import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'schedule-tools-test-'));

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
import { initializeDb, getDb } from '../memory/db.js';
import type { ToolContext } from '../tools/types.js';
import { executeScheduleCreate } from '../tools/schedule/create.js';
import { executeScheduleList } from '../tools/schedule/list.js';
import { executeScheduleUpdate } from '../tools/schedule/update.js';
import { executeScheduleDelete } from '../tools/schedule/delete.js';

initializeDb();

afterAll(() => {
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

// ── schedule_create ─────────────────────────────────────────────────

describe('schedule_create tool', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('creates a schedule with valid cron expression', async () => {
    const result = await executeScheduleCreate({
      name: 'Daily standup',
      cron_expression: '0 9 * * 1-5',
      message: 'Time for standup!',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule created successfully');
    expect(result.content).toContain('Daily standup');
    expect(result.content).toContain('Every weekday at 9:00 AM');
    expect(result.content).toContain('Enabled: true');
  });

  test('creates a disabled schedule', async () => {
    const result = await executeScheduleCreate({
      name: 'Paused job',
      cron_expression: '0 12 * * *',
      message: 'Noon check',
      enabled: false,
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled: false');
  });

  test('creates a schedule with timezone', async () => {
    const result = await executeScheduleCreate({
      name: 'LA morning',
      cron_expression: '0 8 * * *',
      message: 'Good morning LA',
      timezone: 'America/Los_Angeles',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('America/Los_Angeles');
  });

  test('rejects missing name', async () => {
    const result = await executeScheduleCreate({
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('name is required');
  });

  test('rejects missing expression', async () => {
    const result = await executeScheduleCreate({
      name: 'Test',
      message: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('expression (or cron_expression) is required');
  });

  test('rejects missing message', async () => {
    const result = await executeScheduleCreate({
      name: 'Test',
      cron_expression: '0 9 * * *',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('message is required');
  });

  test('rejects invalid cron expression', async () => {
    const result = await executeScheduleCreate({
      name: 'Bad cron',
      cron_expression: 'not-a-cron',
      message: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid cron expression');
  });
});

// ── schedule_list ───────────────────────────────────────────────────

describe('schedule_list tool', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('returns empty message when no schedules exist', async () => {
    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No schedules found');
  });

  test('lists all schedules', async () => {
    await executeScheduleCreate({
      name: 'Job Alpha',
      cron_expression: '0 9 * * *',
      message: 'Alpha',
    }, ctx);
    await executeScheduleCreate({
      name: 'Job Beta',
      cron_expression: '0 17 * * *',
      message: 'Beta',
    }, ctx);

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedules (2)');
    expect(result.content).toContain('Job Alpha');
    expect(result.content).toContain('Job Beta');
  });

  test('filters to enabled only', async () => {
    await executeScheduleCreate({
      name: 'Enabled Job',
      cron_expression: '0 9 * * *',
      message: 'enabled',
    }, ctx);
    await executeScheduleCreate({
      name: 'Disabled Job',
      cron_expression: '0 17 * * *',
      message: 'disabled',
      enabled: false,
    }, ctx);

    const result = await executeScheduleList({ enabled_only: true }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled Job');
    expect(result.content).not.toContain('Disabled Job');
  });

  test('shows detail for a specific job', async () => {
    await executeScheduleCreate({
      name: 'Detail Job',
      cron_expression: '30 14 * * *',
      message: 'Afternoon check',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };

    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule: Detail Job');
    expect(result.content).toContain('Every day at 2:30 PM');
    expect(result.content).toContain('Message: Afternoon check');
    expect(result.content).toContain('Enabled: true');
    expect(result.content).toContain('No runs yet');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await executeScheduleList({ job_id: 'nonexistent' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Schedule not found');
  });
});

// ── schedule_update ─────────────────────────────────────────────────

describe('schedule_update tool', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('updates the name of a schedule', async () => {
    await executeScheduleCreate({
      name: 'Old Name',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({
      job_id: row.id,
      name: 'New Name',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule updated successfully');
    expect(result.content).toContain('New Name');
  });

  test('updates the cron expression', async () => {
    await executeScheduleCreate({
      name: 'Timing Test',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({
      job_id: row.id,
      cron_expression: '0 17 * * *',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Every day at 5:00 PM');
  });

  test('disables a schedule', async () => {
    await executeScheduleCreate({
      name: 'Disable Me',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({
      job_id: row.id,
      enabled: false,
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled: false');
    expect(result.content).toContain('n/a (disabled)');
  });

  test('rejects missing job_id', async () => {
    const result = await executeScheduleUpdate({ name: 'test' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('job_id is required');
  });

  test('rejects update with no fields', async () => {
    await executeScheduleCreate({
      name: 'No Update',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({ job_id: row.id }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No updates provided');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await executeScheduleUpdate({
      job_id: 'nonexistent',
      name: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Schedule not found');
  });

  test('rejects invalid cron expression in update', async () => {
    await executeScheduleCreate({
      name: 'Bad Update',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({
      job_id: row.id,
      cron_expression: 'invalid',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid cron expression');
  });
});

// ── RRULE support in schedule tools ─────────────────────────────────

describe('schedule_create with RRULE', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('creates a schedule with legacy cron_expression', async () => {
    const result = await executeScheduleCreate({
      name: 'Legacy cron',
      cron_expression: '0 9 * * 1-5',
      message: 'Legacy test',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule created successfully');
    expect(result.content).toContain('Syntax: cron');
    expect(result.content).toContain('Every weekday at 9:00 AM');
  });

  test('creates a schedule with RRULE syntax + expression', async () => {
    const result = await executeScheduleCreate({
      name: 'RRULE daily',
      syntax: 'rrule',
      expression: 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY',
      message: 'RRULE test',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule created successfully');
    expect(result.content).toContain('Syntax: rrule');
    expect(result.content).toContain('RRULE:FREQ=DAILY');
  });

  test('auto-detects RRULE syntax when syntax is omitted', async () => {
    const result = await executeScheduleCreate({
      name: 'Auto-detect RRULE',
      expression: 'DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO',
      message: 'Auto-detect test',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Syntax: rrule');
    expect(result.content).toContain('RRULE:FREQ=WEEKLY');
  });

  test('rejects RRULE missing DTSTART with deterministic message', async () => {
    const result = await executeScheduleCreate({
      name: 'No DTSTART',
      syntax: 'rrule',
      expression: 'RRULE:FREQ=DAILY',
      message: 'Should fail',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('DTSTART');
    expect(result.content).toContain('deterministic');
  });
});

describe('schedule_update with RRULE', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('switches a cron schedule to rrule', async () => {
    await executeScheduleCreate({
      name: 'Cron to RRULE',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleUpdate({
      job_id: row.id,
      syntax: 'rrule',
      expression: 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule updated successfully');
    expect(result.content).toContain('Syntax: rrule');
    expect(result.content).toContain('RRULE:FREQ=DAILY');
  });
});

describe('schedule_list with RRULE', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('shows syntax-aware output for cron schedules', async () => {
    await executeScheduleCreate({
      name: 'Cron Job',
      cron_expression: '0 9 * * 1-5',
      message: 'Cron test',
    }, ctx);

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('[cron]');
    expect(result.content).toContain('Every weekday at 9:00 AM');
  });

  test('shows syntax-aware output for rrule schedules', async () => {
    await executeScheduleCreate({
      name: 'RRULE Job',
      syntax: 'rrule',
      expression: 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY',
      message: 'RRULE test',
    }, ctx);

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('[rrule]');
    expect(result.content).toContain('RRULE:FREQ=DAILY');
  });

  test('shows syntax and expression in detail mode', async () => {
    await executeScheduleCreate({
      name: 'Detail RRULE',
      syntax: 'rrule',
      expression: 'DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO',
      message: 'Detail test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Syntax: rrule');
    expect(result.content).toContain('Expression:');
    expect(result.content).toContain('RRULE:FREQ=WEEKLY');
  });
});

// ── schedule_delete ─────────────────────────────────────────────────

describe('schedule_delete tool', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  test('deletes a schedule', async () => {
    await executeScheduleCreate({
      name: 'Delete Me',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await executeScheduleDelete({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule deleted');
    expect(result.content).toContain('Delete Me');

    // Verify it's actually gone
    const count = getRawDb().query('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
    expect(count.c).toBe(0);
  });

  test('rejects missing job_id', async () => {
    const result = await executeScheduleDelete({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('job_id is required');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await executeScheduleDelete({ job_id: 'nonexistent' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Schedule not found');
  });
});
