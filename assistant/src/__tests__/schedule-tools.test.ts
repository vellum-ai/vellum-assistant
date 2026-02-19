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

// Register schedule tools
await import('../tools/schedule/create.js');
await import('../tools/schedule/list.js');
await import('../tools/schedule/update.js');
await import('../tools/schedule/delete.js');

import { getTool } from '../tools/registry.js';

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

  const tool = getTool('schedule_create')!;

  test('creates a schedule with valid cron expression', async () => {
    const result = await tool.execute({
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
    const result = await tool.execute({
      name: 'Paused job',
      cron_expression: '0 12 * * *',
      message: 'Noon check',
      enabled: false,
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled: false');
  });

  test('creates a schedule with timezone', async () => {
    const result = await tool.execute({
      name: 'LA morning',
      cron_expression: '0 8 * * *',
      message: 'Good morning LA',
      timezone: 'America/Los_Angeles',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('America/Los_Angeles');
  });

  test('rejects missing name', async () => {
    const result = await tool.execute({
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('name is required');
  });

  test('rejects missing cron_expression', async () => {
    const result = await tool.execute({
      name: 'Test',
      message: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('cron_expression is required');
  });

  test('rejects missing message', async () => {
    const result = await tool.execute({
      name: 'Test',
      cron_expression: '0 9 * * *',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('message is required');
  });

  test('rejects invalid cron expression', async () => {
    const result = await tool.execute({
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

  const createTool = getTool('schedule_create')!;
  const listTool = getTool('schedule_list')!;

  test('returns empty message when no schedules exist', async () => {
    const result = await listTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No schedules found');
  });

  test('lists all schedules', async () => {
    await createTool.execute({
      name: 'Job Alpha',
      cron_expression: '0 9 * * *',
      message: 'Alpha',
    }, ctx);
    await createTool.execute({
      name: 'Job Beta',
      cron_expression: '0 17 * * *',
      message: 'Beta',
    }, ctx);

    const result = await listTool.execute({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedules (2)');
    expect(result.content).toContain('Job Alpha');
    expect(result.content).toContain('Job Beta');
  });

  test('filters to enabled only', async () => {
    await createTool.execute({
      name: 'Enabled Job',
      cron_expression: '0 9 * * *',
      message: 'enabled',
    }, ctx);
    await createTool.execute({
      name: 'Disabled Job',
      cron_expression: '0 17 * * *',
      message: 'disabled',
      enabled: false,
    }, ctx);

    const result = await listTool.execute({ enabled_only: true }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled Job');
    expect(result.content).not.toContain('Disabled Job');
  });

  test('shows detail for a specific job', async () => {
    await createTool.execute({
      name: 'Detail Job',
      cron_expression: '30 14 * * *',
      message: 'Afternoon check',
    }, ctx);

    // Get the job ID from the DB
    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };

    const result = await listTool.execute({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule: Detail Job');
    expect(result.content).toContain('Every day at 2:30 PM');
    expect(result.content).toContain('Message: Afternoon check');
    expect(result.content).toContain('Enabled: true');
    expect(result.content).toContain('No runs yet');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await listTool.execute({ job_id: 'nonexistent' }, ctx);

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

  const createTool = getTool('schedule_create')!;
  const updateTool = getTool('schedule_update')!;

  test('updates the name of a schedule', async () => {
    await createTool.execute({
      name: 'Old Name',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await updateTool.execute({
      job_id: row.id,
      name: 'New Name',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule updated successfully');
    expect(result.content).toContain('New Name');
  });

  test('updates the cron expression', async () => {
    await createTool.execute({
      name: 'Timing Test',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await updateTool.execute({
      job_id: row.id,
      cron_expression: '0 17 * * *',
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Every day at 5:00 PM');
  });

  test('disables a schedule', async () => {
    await createTool.execute({
      name: 'Disable Me',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await updateTool.execute({
      job_id: row.id,
      enabled: false,
    }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enabled: false');
    expect(result.content).toContain('n/a (disabled)');
  });

  test('rejects missing job_id', async () => {
    const result = await updateTool.execute({ name: 'test' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('job_id is required');
  });

  test('rejects update with no fields', async () => {
    await createTool.execute({
      name: 'No Update',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await updateTool.execute({ job_id: row.id }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No updates provided');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await updateTool.execute({
      job_id: 'nonexistent',
      name: 'test',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Schedule not found');
  });

  test('rejects invalid cron expression in update', async () => {
    await createTool.execute({
      name: 'Bad Update',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await updateTool.execute({
      job_id: row.id,
      cron_expression: 'invalid',
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid cron expression');
  });
});

// ── schedule_delete ─────────────────────────────────────────────────

describe('schedule_delete tool', () => {
  beforeEach(() => {
    getRawDb().run('DELETE FROM cron_runs');
    getRawDb().run('DELETE FROM cron_jobs');
  });

  const createTool = getTool('schedule_create')!;
  const deleteTool = getTool('schedule_delete')!;

  test('deletes a schedule', async () => {
    await createTool.execute({
      name: 'Delete Me',
      cron_expression: '0 9 * * *',
      message: 'test',
    }, ctx);

    const row = getRawDb().query('SELECT id FROM cron_jobs LIMIT 1').get() as { id: string };
    const result = await deleteTool.execute({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Schedule deleted');
    expect(result.content).toContain('Delete Me');

    // Verify it's actually gone
    const count = getRawDb().query('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
    expect(count.c).toBe(0);
  });

  test('rejects missing job_id', async () => {
    const result = await deleteTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('job_id is required');
  });

  test('returns error for nonexistent job_id', async () => {
    const result = await deleteTool.execute({ job_id: 'nonexistent' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Schedule not found');
  });
});
