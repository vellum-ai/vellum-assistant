import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { executePomodoro, timers } from '../tools/timer/pomodoro.js';

describe('pomodoro tool', () => {
  beforeEach(() => {
    timers.clear();
  });

  afterEach(() => {
    // Clear any lingering timeouts
    for (const timer of timers.values()) {
      if (timer.timeoutHandle) {
        clearTimeout(timer.timeoutHandle);
      }
    }
    timers.clear();
  });

  // ── action validation ────────────────────────────────────────────

  test('rejects missing action', () => {
    const result = executePomodoro({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('action is required');
  });

  test('rejects unknown action', () => {
    const result = executePomodoro({ action: 'destroy' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action');
    expect(result.content).toContain('destroy');
  });

  // ── start ────────────────────────────────────────────────────────

  test('start creates a timer with default duration', () => {
    const result = executePomodoro({ action: 'start' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('started');
    expect(result.content).toContain('25 minutes');
    expect(result.content).toContain('Pomodoro');
    expect(timers.size).toBe(1);

    const timer = timers.values().next().value!;
    expect(timer.status).toBe('running');
    expect(timer.durationMinutes).toBe(25);
    expect(timer.label).toBe('Pomodoro');
  });

  test('start creates a timer with custom duration and label', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 10, label: 'Deep Work' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deep Work');
    expect(result.content).toContain('10 minutes');

    const timer = timers.values().next().value!;
    expect(timer.durationMinutes).toBe(10);
    expect(timer.label).toBe('Deep Work');
  });

  test('start uses default duration for invalid values', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: -5 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('25 minutes');
  });

  test('start generates unique timer IDs', () => {
    executePomodoro({ action: 'start' });
    executePomodoro({ action: 'start' });
    expect(timers.size).toBe(2);
    const ids = Array.from(timers.keys());
    expect(ids[0]).not.toBe(ids[1]);
  });

  // ── pause ────────────────────────────────────────────────────────

  test('pause requires timer_id', () => {
    const result = executePomodoro({ action: 'pause' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('pause rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'pause', timer_id: 'nonexist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('pause stops a running timer', () => {
    executePomodoro({ action: 'start', label: 'Test' });
    const id = timers.keys().next().value!;

    const result = executePomodoro({ action: 'pause', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('paused');

    const timer = timers.get(id)!;
    expect(timer.status).toBe('paused');
    expect(timer.remainingMs).toBeGreaterThan(0);
    expect(timer.timeoutHandle).toBeUndefined();
  });

  test('pause rejects already paused timer', () => {
    executePomodoro({ action: 'start' });
    const id = timers.keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id });

    const result = executePomodoro({ action: 'pause', timer_id: id });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not running');
  });

  // ── resume ───────────────────────────────────────────────────────

  test('resume requires timer_id', () => {
    const result = executePomodoro({ action: 'resume' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('resume rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'resume', timer_id: 'nonexist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('resume restarts a paused timer', () => {
    executePomodoro({ action: 'start', label: 'Test' });
    const id = timers.keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id });

    const result = executePomodoro({ action: 'resume', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('resumed');

    const timer = timers.get(id)!;
    expect(timer.status).toBe('running');
    expect(timer.timeoutHandle).toBeDefined();
  });

  test('resume rejects running timer', () => {
    executePomodoro({ action: 'start' });
    const id = timers.keys().next().value!;

    const result = executePomodoro({ action: 'resume', timer_id: id });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not paused');
  });

  // ── cancel ───────────────────────────────────────────────────────

  test('cancel requires timer_id', () => {
    const result = executePomodoro({ action: 'cancel' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('cancel rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'cancel', timer_id: 'nonexist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('cancel stops a running timer', () => {
    executePomodoro({ action: 'start', label: 'Cancel me' });
    const id = timers.keys().next().value!;

    const result = executePomodoro({ action: 'cancel', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('cancelled');

    const timer = timers.get(id)!;
    expect(timer.status).toBe('cancelled');
    expect(timer.timeoutHandle).toBeUndefined();
  });

  test('cancel stops a paused timer', () => {
    executePomodoro({ action: 'start' });
    const id = timers.keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id });

    const result = executePomodoro({ action: 'cancel', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('cancelled');
  });

  test('cancel rejects already cancelled timer', () => {
    executePomodoro({ action: 'start' });
    const id = timers.keys().next().value!;
    executePomodoro({ action: 'cancel', timer_id: id });

    const result = executePomodoro({ action: 'cancel', timer_id: id });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already cancelled');
  });

  test('cancel rejects completed timer', () => {
    executePomodoro({ action: 'start' });
    const id = timers.keys().next().value!;
    // Manually mark as completed for testing
    const timer = timers.get(id)!;
    clearTimeout(timer.timeoutHandle!);
    timer.status = 'completed';
    timer.timeoutHandle = undefined;

    const result = executePomodoro({ action: 'cancel', timer_id: id });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already completed');
  });

  // ── status ───────────────────────────────────────────────────────

  test('status requires timer_id', () => {
    const result = executePomodoro({ action: 'status' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timer_id is required');
  });

  test('status rejects non-existent timer', () => {
    const result = executePomodoro({ action: 'status', timer_id: 'nonexist' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('status returns timer details for running timer', () => {
    executePomodoro({ action: 'start', label: 'Focus', duration_minutes: 25 });
    const id = timers.keys().next().value!;

    const result = executePomodoro({ action: 'status', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Focus');
    expect(result.content).toContain(id);
    expect(result.content).toContain('Running');
    expect(result.content).toContain('25 minutes');
    expect(result.content).toContain('Progress:');
  });

  test('status returns timer details for paused timer', () => {
    executePomodoro({ action: 'start', label: 'Paused test' });
    const id = timers.keys().next().value!;
    executePomodoro({ action: 'pause', timer_id: id });

    const result = executePomodoro({ action: 'status', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Paused');
  });

  // ── list ─────────────────────────────────────────────────────────

  test('list returns message when no timers exist', () => {
    const result = executePomodoro({ action: 'list' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No timers found');
  });

  test('list returns all timers', () => {
    executePomodoro({ action: 'start', label: 'Timer A' });
    executePomodoro({ action: 'start', label: 'Timer B' });

    const result = executePomodoro({ action: 'list' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Timer A');
    expect(result.content).toContain('Timer B');
  });

  // ── timer expiration (fake timers) ───────────────────────────────

  test('timer completes after duration elapses', async () => {
    // Use a very short duration and manually fire the timeout
    executePomodoro({ action: 'start', label: 'Quick', duration_minutes: 0.001 });
    const id = timers.keys().next().value!;
    const timer = timers.get(id)!;

    expect(timer.status).toBe('running');

    // Wait slightly longer than the timer duration (0.001 min = 60ms)
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(timer.status).toBe('completed');
    expect(timer.completedAt).toBeDefined();
    expect(timer.remainingMs).toBe(0);
    expect(timer.timeoutHandle).toBeUndefined();
  });

  test('completed timer shows 100% progress', async () => {
    executePomodoro({ action: 'start', label: 'Done', duration_minutes: 0.001 });
    const id = timers.keys().next().value!;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = executePomodoro({ action: 'status', timer_id: id });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Completed');
    expect(result.content).toContain('Progress: 100%');
    expect(result.content).toContain('Completed at:');
  });

  // ── pause/resume preserves remaining time ────────────────────────

  test('pause and resume preserves remaining time correctly', async () => {
    executePomodoro({ action: 'start', label: 'Preserve', duration_minutes: 1 });
    const id = timers.keys().next().value!;

    // Wait a small amount of time
    await new Promise((resolve) => setTimeout(resolve, 50));

    executePomodoro({ action: 'pause', timer_id: id });
    const pausedTimer = timers.get(id)!;
    const remainingAtPause = pausedTimer.remainingMs;

    // remaining should be less than full duration (60000ms) but close
    expect(remainingAtPause).toBeLessThan(60000);
    expect(remainingAtPause).toBeGreaterThan(59000);

    executePomodoro({ action: 'resume', timer_id: id });
    const resumedTimer = timers.get(id)!;
    expect(resumedTimer.status).toBe('running');
  });

  // ── edge cases ───────────────────────────────────────────────────

  test('multiple operations on same timer work correctly', () => {
    executePomodoro({ action: 'start', label: 'Multi' });
    const id = timers.keys().next().value!;

    // Pause
    let result = executePomodoro({ action: 'pause', timer_id: id });
    expect(result.isError).toBe(false);

    // Resume
    result = executePomodoro({ action: 'resume', timer_id: id });
    expect(result.isError).toBe(false);

    // Pause again
    result = executePomodoro({ action: 'pause', timer_id: id });
    expect(result.isError).toBe(false);

    // Cancel
    result = executePomodoro({ action: 'cancel', timer_id: id });
    expect(result.isError).toBe(false);

    const timer = timers.get(id)!;
    expect(timer.status).toBe('cancelled');
  });

  test('start returns expected end time', () => {
    const result = executePomodoro({ action: 'start', duration_minutes: 30 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Expected end:');
  });
});
