import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { executePomodoro, timers, rehydrateTimers, MAX_DURATION_MINUTES } from '../tools/timer/pomodoro.js';
import { initializeDb } from '../memory/db.js';
import { getDb } from '../memory/db.js';
import { pomodoroTimers } from '../memory/schema.js';
import { eq } from 'drizzle-orm';

initializeDb();

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const ctxA = { sessionId: SESSION_A };
const ctxB = { sessionId: SESSION_B };

/** Helper to get the per-session timer map (or an empty map if none). */
function getSessionTimers(sessionId: string) {
  return timers.get(sessionId) ?? new Map();
}

/** Clear all timer rows from the database. */
function clearTimerDb() {
  const db = getDb();
  db.delete(pomodoroTimers).run();
}

describe('pomodoro tool', () => {
  beforeEach(() => {
    timers.clear();
    clearTimerDb();
  });

  afterEach(() => {
    // Clear any lingering timeouts
    for (const sessionMap of timers.values()) {
      for (const timer of sessionMap.values()) {
        if (timer.timeoutHandle) {
          clearTimeout(timer.timeoutHandle);
        }
      }
    }
    timers.clear();
    clearTimerDb();
  });

  // ── action validation ────────────────────────────────────────────

  test('rejects missing action', () => {
    const result = executePomodoro({}, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('action is required');
  });

  test('rejects unknown action', () => {
    const result = executePomodoro({ action: 'destroy' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action');
    expect(result.content).toContain('destroy');
  });

  // ── start ────────────────────────────────────────────────────────

  test('start creates a timer with default duration', () => {
    const result = executePomodoro({ action: 'start' }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('started');
    expect(result.content).toContain('25 minutes');
    expect(result.content).toContain('Pomodoro');

    const sessionTimers = getSessionTimers(SESSION_A);
    expect(sessionTimers.size).toBe(1);

    const timer = sessionTimers.values().next().value!;
    expect(timer.status).toBe('running');
    expect(timer.durationMinutes).toBe(25);
    expect(timer.label).toBe('Pomodoro');
  });

  test('start creates a timer with custom duration and label', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 10, label: 'Deep Work' }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deep Work');
    expect(result.content).toContain('10 minutes');

    const timer = getSessionTimers(SESSION_A).values().next().value!;
    expect(timer.durationMinutes).toBe(10);
    expect(timer.label).toBe('Deep Work');
  });

  test('start uses default duration for invalid values', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: -5 }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('25 minutes');
  });

  test('start generates unique timer IDs', () => {
    executePomodoro({ action: 'start' }, ctxA);
    executePomodoro({ action: 'start' }, ctxA);

    const sessionTimers = getSessionTimers(SESSION_A);
    expect(sessionTimers.size).toBe(2);
    const ids = Array.from(sessionTimers.keys());
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('start persists timer to database', () => {
    executePomodoro({ action: 'start', label: 'Persisted' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    const db = getDb();
    const row = db.select().from(pomodoroTimers).where(eq(pomodoroTimers.id, id)).get();
    expect(row).toBeDefined();
    expect(row!.label).toBe('Persisted');
    expect(row!.status).toBe('running');
    expect(row!.sessionId).toBe(SESSION_A);
  });

  // ── duration overflow ─────────────────────────────────────────────

  test('start rejects duration exceeding maximum', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 1441 }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds maximum');
    expect(result.content).toContain(String(MAX_DURATION_MINUTES));
    expect(getSessionTimers(SESSION_A).size).toBe(0);
  });

  test('start accepts duration at exactly the maximum', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: MAX_DURATION_MINUTES }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('started');
    expect(getSessionTimers(SESSION_A).size).toBe(1);
  });

  test('start rejects very large duration that would overflow setTimeout', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 100000 }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds maximum');
  });

  // ── session isolation ─────────────────────────────────────────────

  test('timers are isolated between sessions', () => {
    // Create a timer in session A
    executePomodoro({ action: 'start', label: 'Session A Timer' }, ctxA);
    const timerIdA = getSessionTimers(SESSION_A).keys().next().value!;

    // Create a timer in session B
    executePomodoro({ action: 'start', label: 'Session B Timer' }, ctxB);

    // Session A list should only show session A timer
    const listA = executePomodoro({ action: 'list' }, ctxA);
    expect(listA.content).toContain('Session A Timer');
    expect(listA.content).not.toContain('Session B Timer');

    // Session B list should only show session B timer
    const listB = executePomodoro({ action: 'list' }, ctxB);
    expect(listB.content).toContain('Session B Timer');
    expect(listB.content).not.toContain('Session A Timer');

    // Session B cannot pause session A's timer
    const pauseResult = executePomodoro({ action: 'pause', timer_id: timerIdA }, ctxB);
    expect(pauseResult.isError).toBe(true);
    expect(pauseResult.content).toContain('not found');

    // Session A can pause its own timer
    const pauseOwnResult = executePomodoro({ action: 'pause', timer_id: timerIdA }, ctxA);
    expect(pauseOwnResult.isError).toBe(false);
  });

  test('session B cannot cancel session A timer', () => {
    executePomodoro({ action: 'start', label: 'Private Timer' }, ctxA);
    const timerIdA = getSessionTimers(SESSION_A).keys().next().value!;

    const cancelResult = executePomodoro({ action: 'cancel', timer_id: timerIdA }, ctxB);
    expect(cancelResult.isError).toBe(true);
    expect(cancelResult.content).toContain('not found');
  });

  test('session B cannot get status of session A timer', () => {
    executePomodoro({ action: 'start', label: 'Private Timer' }, ctxA);
    const timerIdA = getSessionTimers(SESSION_A).keys().next().value!;

    const statusResult = executePomodoro({ action: 'status', timer_id: timerIdA }, ctxB);
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content).toContain('not found');
  });

  // ── pause ────────────────────────────────────────────────────────

  test('pause requires timer_id', () => {
    const result = executePomodoro({ action: 'pause' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('pause rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'pause', timer_id: 'nonexist' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('pause stops a running timer', () => {
    executePomodoro({ action: 'start', label: 'Test' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    const result = executePomodoro({ action: 'pause', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('paused');

    const timer = getSessionTimers(SESSION_A).get(id)!;
    expect(timer.status).toBe('paused');
    expect(timer.remainingMs).toBeGreaterThan(0);
    expect(timer.timeoutHandle).toBeUndefined();
  });

  test('pause persists status to database', () => {
    executePomodoro({ action: 'start', label: 'PauseMe' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    const db = getDb();
    const row = db.select().from(pomodoroTimers).where(eq(pomodoroTimers.id, id)).get();
    expect(row!.status).toBe('paused');
    expect(row!.remainingMs).toBeGreaterThan(0);
  });

  test('pause rejects already paused timer', () => {
    executePomodoro({ action: 'start' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    const result = executePomodoro({ action: 'pause', timer_id: id }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not running');
  });

  // ── resume ───────────────────────────────────────────────────────

  test('resume requires timer_id', () => {
    const result = executePomodoro({ action: 'resume' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('resume rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'resume', timer_id: 'nonexist' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('resume restarts a paused timer', () => {
    executePomodoro({ action: 'start', label: 'Test' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    const result = executePomodoro({ action: 'resume', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('resumed');

    const timer = getSessionTimers(SESSION_A).get(id)!;
    expect(timer.status).toBe('running');
    expect(timer.timeoutHandle).toBeDefined();
  });

  test('resume rejects running timer', () => {
    executePomodoro({ action: 'start' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    const result = executePomodoro({ action: 'resume', timer_id: id }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not paused');
  });

  // ── cancel ───────────────────────────────────────────────────────

  test('cancel requires timer_id', () => {
    const result = executePomodoro({ action: 'cancel' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('cancel rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'cancel', timer_id: 'nonexist' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('cancel stops a running timer', () => {
    executePomodoro({ action: 'start', label: 'Cancel me' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    const result = executePomodoro({ action: 'cancel', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('cancelled');

    const timer = getSessionTimers(SESSION_A).get(id)!;
    expect(timer.status).toBe('cancelled');
    expect(timer.timeoutHandle).toBeUndefined();
  });

  test('cancel stops a paused timer', () => {
    executePomodoro({ action: 'start' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    const result = executePomodoro({ action: 'cancel', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('cancelled');
  });

  test('cancel persists status to database', () => {
    executePomodoro({ action: 'start', label: 'CancelMe' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'cancel', timer_id: id }, ctxA);

    const db = getDb();
    const row = db.select().from(pomodoroTimers).where(eq(pomodoroTimers.id, id)).get();
    expect(row!.status).toBe('cancelled');
  });

  test('cancel rejects already cancelled timer', () => {
    executePomodoro({ action: 'start' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'cancel', timer_id: id }, ctxA);

    const result = executePomodoro({ action: 'cancel', timer_id: id }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already cancelled');
  });

  test('cancel rejects completed timer', () => {
    executePomodoro({ action: 'start' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    // Manually mark as completed for testing
    const timer = getSessionTimers(SESSION_A).get(id)!;
    clearTimeout(timer.timeoutHandle!);
    timer.status = 'completed';
    timer.timeoutHandle = undefined;

    const result = executePomodoro({ action: 'cancel', timer_id: id }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already completed');
  });

  // ── status ───────────────────────────────────────────────────────

  test('status requires timer_id', () => {
    const result = executePomodoro({ action: 'status' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('status rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'status', timer_id: 'nonexist' }, ctxA);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('status returns timer details for running timer', () => {
    executePomodoro({ action: 'start', label: 'Focus', duration_minutes: 25 }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    const result = executePomodoro({ action: 'status', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Focus');
    expect(result.content).toContain(id);
    expect(result.content).toContain('Running');
    expect(result.content).toContain('25 minutes');
    expect(result.content).toContain('Progress:');
  });

  test('status returns timer details for paused timer', () => {
    executePomodoro({ action: 'start', label: 'Paused test' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    const result = executePomodoro({ action: 'status', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Paused');
  });

  // ── list ─────────────────────────────────────────────────────────

  test('list returns message when no timers exist', () => {
    const result = executePomodoro({ action: 'list' }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No timers found');
  });

  test('list returns all timers', () => {
    executePomodoro({ action: 'start', label: 'Timer A' }, ctxA);
    executePomodoro({ action: 'start', label: 'Timer B' }, ctxA);

    const result = executePomodoro({ action: 'list' }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Timer A');
    expect(result.content).toContain('Timer B');
  });

  // ── timer expiration (fake timers) ───────────────────────────────

  test('timer completes after duration elapses', async () => {
    // Use a very short duration and manually fire the timeout
    executePomodoro({ action: 'start', label: 'Quick', duration_minutes: 0.001 }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    const timer = getSessionTimers(SESSION_A).get(id)!;

    expect(timer.status).toBe('running');

    // Wait slightly longer than the timer duration (0.001 min = 60ms)
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(timer.status).toBe('completed');
    expect(timer.completedAt).toBeDefined();
    expect(timer.remainingMs).toBe(0);
    expect(timer.timeoutHandle).toBeUndefined();

    // Verify completion was persisted
    const db = getDb();
    const row = db.select().from(pomodoroTimers).where(eq(pomodoroTimers.id, id)).get();
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).toBeDefined();
  });

  test('completed timer shows 100% progress', async () => {
    executePomodoro({ action: 'start', label: 'Done', duration_minutes: 0.001 }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = executePomodoro({ action: 'status', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Completed');
    expect(result.content).toContain('Progress: 100%');
    expect(result.content).toContain('Completed at:');
  });

  // ── pause/resume preserves remaining time ────────────────────────

  test('pause and resume preserves remaining time correctly', async () => {
    executePomodoro({ action: 'start', label: 'Preserve', duration_minutes: 1 }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    // Wait a small amount of time
    await new Promise((resolve) => setTimeout(resolve, 50));

    executePomodoro({ action: 'pause', timer_id: id }, ctxA);
    const pausedTimer = getSessionTimers(SESSION_A).get(id)!;
    const remainingAtPause = pausedTimer.remainingMs;

    // remaining should be less than full duration (60000ms) but close
    expect(remainingAtPause).toBeLessThan(60000);
    expect(remainingAtPause).toBeGreaterThan(59000);

    executePomodoro({ action: 'resume', timer_id: id }, ctxA);
    const resumedTimer = getSessionTimers(SESSION_A).get(id)!;
    expect(resumedTimer.status).toBe('running');
  });

  // ── edge cases ───────────────────────────────────────────────────

  test('multiple operations on same timer work correctly', () => {
    executePomodoro({ action: 'start', label: 'Multi' }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;

    // Pause
    let result = executePomodoro({ action: 'pause', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);

    // Resume
    result = executePomodoro({ action: 'resume', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);

    // Pause again
    result = executePomodoro({ action: 'pause', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);

    // Cancel
    result = executePomodoro({ action: 'cancel', timer_id: id }, ctxA);
    expect(result.isError).toBe(false);

    const timer = getSessionTimers(SESSION_A).get(id)!;
    expect(timer.status).toBe('cancelled');
  });

  test('start returns expected end time', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 30 }, ctxA);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Expected end:');
  });

  // ── rehydration ──────────────────────────────────────────────────

  test('rehydrateTimers restores paused timers from database', () => {
    // Create and pause a timer
    executePomodoro({ action: 'start', label: 'Paused Across Restart', duration_minutes: 10 }, ctxA);
    const id = getSessionTimers(SESSION_A).keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id }, ctxA);

    // Simulate daemon restart: clear in-memory state
    for (const sessionMap of timers.values()) {
      for (const timer of sessionMap.values()) {
        if (timer.timeoutHandle) clearTimeout(timer.timeoutHandle);
      }
    }
    timers.clear();
    expect(getSessionTimers(SESSION_A).size).toBe(0);

    // Rehydrate
    const count = rehydrateTimers();
    expect(count).toBe(1);

    // Timer should be back in memory
    const rehydrated = getSessionTimers(SESSION_A).get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated!.status).toBe('paused');
    expect(rehydrated!.label).toBe('Paused Across Restart');
    expect(rehydrated!.timeoutHandle).toBeUndefined();
  });

  test('rehydrateTimers marks expired running timers as completed', () => {
    // Insert a timer directly into DB that should have already expired
    const db = getDb();
    const now = Date.now();
    const expiredId = 'expired1';
    db.insert(pomodoroTimers).values({
      id: expiredId,
      sessionId: SESSION_A,
      label: 'Already Expired',
      durationMinutes: 1,
      startedAt: now - 120_000, // started 2 min ago (1-min timer)
      remainingMs: 60_000,
      status: 'running',
      completedAt: null,
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
    }).run();

    const count = rehydrateTimers();
    expect(count).toBe(1);

    const timer = getSessionTimers(SESSION_A).get(expiredId);
    expect(timer).toBeDefined();
    expect(timer!.status).toBe('completed');
    expect(timer!.completedAt).toBeDefined();
    expect(timer!.remainingMs).toBe(0);

    // DB should also reflect completion
    const row = db.select().from(pomodoroTimers).where(eq(pomodoroTimers.id, expiredId)).get();
    expect(row!.status).toBe('completed');
  });

  test('rehydrateTimers resumes running timers with remaining time', () => {
    // Insert a timer directly into DB that still has time left
    const db = getDb();
    const now = Date.now();
    const activeId = 'active1';
    db.insert(pomodoroTimers).values({
      id: activeId,
      sessionId: SESSION_A,
      label: 'Still Running',
      durationMinutes: 10,
      startedAt: now - 60_000, // started 1 min ago (10-min timer)
      remainingMs: 600_000,
      status: 'running',
      completedAt: null,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    }).run();

    const count = rehydrateTimers();
    expect(count).toBe(1);

    const timer = getSessionTimers(SESSION_A).get(activeId);
    expect(timer).toBeDefined();
    expect(timer!.status).toBe('running');
    expect(timer!.timeoutHandle).toBeDefined();
    // Should have ~9 min remaining
    expect(timer!.remainingMs).toBeGreaterThan(500_000);
    expect(timer!.remainingMs).toBeLessThanOrEqual(540_000);
  });

  test('rehydrateTimers skips completed/cancelled timers', () => {
    const db = getDb();
    const now = Date.now();
    db.insert(pomodoroTimers).values({
      id: 'done1',
      sessionId: SESSION_A,
      label: 'Done',
      durationMinutes: 5,
      startedAt: now - 300_000,
      remainingMs: 0,
      status: 'completed',
      completedAt: now,
      createdAt: now - 300_000,
      updatedAt: now,
    }).run();

    const count = rehydrateTimers();
    expect(count).toBe(0);
    expect(getSessionTimers(SESSION_A).size).toBe(0);
  });
});
