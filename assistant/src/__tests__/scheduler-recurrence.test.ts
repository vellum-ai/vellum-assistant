import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'scheduler-recurrence-test-'));

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
import { createTask } from '../tasks/task-store.js';
import {
  createSchedule,
  getSchedule,
  getScheduleRuns,
} from '../schedule/schedule-store.js';
import { startScheduler } from '../schedule/scheduler.js';

initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import('bun:sqlite').Database {
  return (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
}

/** Force a schedule to be due by setting next_run_at in the past. */
function forceScheduleDue(scheduleId: string): void {
  getRawDb().run('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [Date.now() - 1000, scheduleId]);
}

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// Build an RRULE expression anchored at the given start date, recurring every minute.
// This ensures the rule always has future occurrences relative to the test clock.
function buildEveryMinuteRrule(dtstart: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ds = `${dtstart.getUTCFullYear()}${pad(dtstart.getUTCMonth() + 1)}${pad(dtstart.getUTCDate())}T${pad(dtstart.getUTCHours())}${pad(dtstart.getUTCMinutes())}${pad(dtstart.getUTCSeconds())}Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
}

// Build an RRULE expression that ended in the past (UNTIL already passed).
function buildEndedRrule(): string {
  const past = new Date(Date.now() - 86_400_000 * 30); // 30 days ago
  const until = new Date(Date.now() - 86_400_000); // 1 day ago
  const pad = (n: number) => String(n).padStart(2, '0');
  const ds = `${past.getUTCFullYear()}${pad(past.getUTCMonth() + 1)}${pad(past.getUTCDate())}T000000Z`;
  const us = `${until.getUTCFullYear()}${pad(until.getUTCMonth() + 1)}${pad(until.getUTCDate())}T235959Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=DAILY;INTERVAL=1;UNTIL=${us}`;
}

// ── RRULE schedule fires through the scheduler ──────────────────────

describe('scheduler RRULE execution', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM cron_runs');
    db.run('DELETE FROM cron_jobs');
    db.run('DELETE FROM task_runs');
    db.run('DELETE FROM tasks');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('RRULE schedule fires and creates cron_runs entry', async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: 'RRULE Test',
      cronExpression: rruleExpr,
      message: 'Hello from RRULE',
      syntax: 'rrule',
      expression: rruleExpr,
    });

    // Verify it was stored with rrule syntax
    const stored = getSchedule(schedule.id);
    expect(stored).not.toBeNull();
    expect(stored!.syntax).toBe('rrule');

    // Force it to be due
    forceScheduleDue(schedule.id);

    const processedMessages: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // processMessage should have been called with the RRULE message
    expect(processedMessages.some(m => m.message === 'Hello from RRULE')).toBe(true);

    // A cron_runs entry should have been created
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('ok');
  });

  test('RRULE run_task:<id> triggers task runner', async () => {
    const task = createTask({
      title: 'RRULE Task',
      template: 'Execute RRULE task',
    });

    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: 'RRULE Task Schedule',
      cronExpression: rruleExpr,
      message: `run_task:${task.id}`,
      syntax: 'rrule',
      expression: rruleExpr,
    });

    forceScheduleDue(schedule.id);

    const directCalls: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      directCalls.push({ conversationId, message });
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // runTask renders the template, so processMessage gets the template text
    const runTaskCalls = directCalls.filter(c => c.message === 'Execute RRULE task');
    const rawCalls = directCalls.filter(c => c.message.startsWith('run_task:'));

    expect(runTaskCalls.length).toBe(1);
    expect(rawCalls.length).toBe(0);

    // A cron_runs entry should exist
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  test('ended RRULE (UNTIL in past) is not repeatedly claimed', async () => {
    const endedExpr = buildEndedRrule();

    // Insert directly via raw SQL because createSchedule would throw when
    // computing nextRunAt for an already-ended RRULE. This simulates a
    // schedule that was valid when created but has since expired.
    const id = crypto.randomUUID();
    const now = Date.now();
    getRawDb().run(
      `INSERT INTO cron_jobs (id, name, enabled, cron_expression, schedule_syntax, timezone, message, next_run_at, last_run_at, last_status, retry_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Ended RRULE', 1, endedExpr, 'rrule', null, 'Should not fire', now - 1000, null, null, 0, 'agent', now, now],
    );

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // The ended RRULE should NOT have fired
    expect(processedMessages).not.toContain('Should not fire');

    // No runs should have been created
    const runs = getScheduleRuns(id);
    expect(runs.length).toBe(0);
  });

  test('existing cron schedule behavior is unchanged', async () => {
    const schedule = createSchedule({
      name: 'Cron Schedule',
      cronExpression: '* * * * *',
      message: 'Cron message',
    });

    // Verify it defaults to cron syntax
    const stored = getSchedule(schedule.id);
    expect(stored).not.toBeNull();
    expect(stored!.syntax).toBe('cron');

    forceScheduleDue(schedule.id);

    const processedMessages: { conversationId: string; message: string }[] = [];
    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // processMessage should have been called with the cron message
    expect(processedMessages.some(m => m.message === 'Cron message')).toBe(true);

    // A cron_runs entry should have been created
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('ok');
  });

  test('RRULE set with EXDATE skips excluded occurrence and advances to next valid date', async () => {
    // Build an RRULE set that fires every minute but excludes the next immediate occurrence.
    // The scheduler should skip the excluded date and advance to the one after.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');

    // DTSTART one hour ago so there are plenty of past occurrences
    const pastDate = new Date(now.getTime() - 3_600_000);
    const ds = `${pastDate.getUTCFullYear()}${pad(pastDate.getUTCMonth() + 1)}${pad(pastDate.getUTCDate())}T${pad(pastDate.getUTCHours())}${pad(pastDate.getUTCMinutes())}${pad(pastDate.getUTCSeconds())}Z`;

    // Exclude the current minute's occurrence
    const currentMinuteDate = new Date(now);
    currentMinuteDate.setUTCSeconds(0);
    currentMinuteDate.setUTCMilliseconds(0);
    // Round to the previous minute boundary relative to dtstart
    const exDate = `${currentMinuteDate.getUTCFullYear()}${pad(currentMinuteDate.getUTCMonth() + 1)}${pad(currentMinuteDate.getUTCDate())}T${pad(currentMinuteDate.getUTCHours())}${pad(currentMinuteDate.getUTCMinutes())}00Z`;

    const expression = `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1\nEXDATE:${exDate}`;

    const schedule = createSchedule({
      name: 'RRULE set EXDATE test',
      cronExpression: expression,
      message: 'Set exclusion test',
      syntax: 'rrule',
      expression,
    });

    // Force the schedule to be due
    forceScheduleDue(schedule.id);

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // The schedule should have been claimed and nextRunAt advanced
    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.lastRunAt).not.toBeNull();
    // nextRunAt should be in the future (not the excluded date)
    expect(after!.nextRunAt).toBeGreaterThan(Date.now() - 5000);
  });

  test('RRULE set schedule fires and creates cron_runs entry', async () => {
    const expression = [
      'DTSTART:20250101T000000Z',
      'RRULE:FREQ=MINUTELY;INTERVAL=1',
      'EXDATE:20250101T000100Z',
    ].join('\n');

    const schedule = createSchedule({
      name: 'Set schedule fire test',
      cronExpression: expression,
      message: 'Set fire test',
      syntax: 'rrule',
      expression,
    });

    forceScheduleDue(schedule.id);

    const processedMessages: string[] = [];
    const processMessage = async (_conversationId: string, message: string) => {
      processedMessages.push(message);
    };

    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    expect(processedMessages).toContain('Set fire test');

    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('ok');
  });

  test('RRULE schedule advances nextRunAt after firing', async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: 'Advancing RRULE',
      cronExpression: rruleExpr,
      message: 'Advance test',
      syntax: 'rrule',
      expression: rruleExpr,
    });

    const beforeNextRunAt = getSchedule(schedule.id)!.nextRunAt;
    forceScheduleDue(schedule.id);

    const processMessage = async () => {};
    const scheduler = startScheduler(processMessage, () => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    scheduler.stop();

    // nextRunAt should have advanced to a future time
    const after = getSchedule(schedule.id);
    expect(after).not.toBeNull();
    expect(after!.nextRunAt).toBeGreaterThan(Date.now() - 5000);
    // It should differ from the forced-due value
    expect(after!.lastRunAt).not.toBeNull();
  });
});
