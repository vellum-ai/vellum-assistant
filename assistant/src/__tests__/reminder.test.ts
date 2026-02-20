import { afterAll, describe, test, expect, beforeEach } from 'bun:test';
import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { reminders } from '../memory/schema.js';
import { executeReminderCreate, executeReminderList, executeReminderCancel } from '../tools/reminder/reminder.js';
import { claimDueReminders } from '../tools/reminder/reminder-store.js';

initializeDb();

function clearReminders() {
  getDb().delete(reminders).run();
}

afterAll(() => {
  resetDb();
});

describe('reminder tool', () => {
  beforeEach(() => {
    clearReminders();
  });

  // ── create ──────────────────────────────────────────────────────────

  test('create with valid future ISO timestamp succeeds', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: 'Call Sidd',
      message: 'Remember to call Sidd',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Reminder created');
    expect(result.content).toContain('Call Sidd');
    expect(result.content).toContain('notify');
  });

  test('create with past timestamp returns error', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: past,
      label: 'Too late',
      message: 'This is in the past',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('must be in the future');
  });

  test('create with invalid timestamp string returns error', async () => {
    const result = executeReminderCreate({
      fire_at: 'not-a-date',
      label: 'Bad date',
      message: 'This has a bad date',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid timestamp');
  });

  test('create rejects non-ISO date formats like MM/DD/YYYY', async () => {
    const result = executeReminderCreate({
      fire_at: '03/04/2027',
      label: 'Ambiguous date',
      message: 'This format is locale-dependent',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid timestamp');
  });

  test('create rejects ISO timestamp without timezone', async () => {
    const result = executeReminderCreate({
      fire_at: '2027-03-15T09:00:00',
      label: 'No timezone',
      message: 'Missing timezone offset',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid timestamp');
  });

  test('create accepts ISO timestamp with timezone offset', async () => {
    const future = new Date(Date.now() + 120_000);
    const offset = '-05:00';
    const isoWithOffset = future.toISOString().replace('Z', offset);
    const result = executeReminderCreate({
      fire_at: isoWithOffset,
      label: 'With offset',
      message: 'Has explicit timezone',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Reminder created');
  });

  test('create defaults mode to notify', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: 'Default mode',
      message: 'Should be notify',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Mode: notify');
  });

  test('create with mode execute sets mode correctly', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: 'Execute mode',
      message: 'Should be execute',
      mode: 'execute',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Mode: execute');
  });

  test('create requires fire_at', async () => {
    const result = executeReminderCreate({
      label: 'No fire_at',
      message: 'Missing fire_at',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('fire_at is required');
  });

  test('create requires label', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      message: 'Missing label',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('label is required');
  });

  test('create requires message', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: 'No message',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('message is required');
  });

  // ── list ────────────────────────────────────────────────────────────

  test('list returns "No reminders found" when empty', async () => {
    const result = executeReminderList();
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No reminders found');
  });

  test('list returns formatted reminders', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    executeReminderCreate({
      fire_at: future,
      label: 'Test reminder',
      message: 'Test message',
    });

    const result = executeReminderList();
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Test reminder');
    expect(result.content).toContain('pending');
  });

  // ── cancel ──────────────────────────────────────────────────────────

  test('cancel with valid pending reminder succeeds', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const createResult = executeReminderCreate({
      fire_at: future,
      label: 'Cancel me',
      message: 'To be cancelled',
    });

    // Extract ID from the create result
    const idMatch = createResult.content.match(/ID: (.+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1].trim();

    const result = executeReminderCancel({
      reminder_id: id,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('cancelled');
  });

  test('cancel with nonexistent ID returns error', async () => {
    const result = executeReminderCancel({
      reminder_id: 'nonexistent',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('cancel with already-fired reminder returns error', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const createResult = executeReminderCreate({
      fire_at: future,
      label: 'Fire then cancel',
      message: 'x',
    });

    const idMatch = createResult.content.match(/ID: (.+)/);
    const id = idMatch![1].trim();

    // Force-fire by claiming with a future timestamp
    claimDueReminders(Date.now() + 120_000);

    const result = executeReminderCancel({
      reminder_id: id,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found or already fired');
  });
});
