import { describe, test, expect } from 'bun:test';
import { isValidScheduleExpression, computeNextRunAt } from '../schedule/recurrence-engine.js';

describe('recurrence engine — cron', () => {
  test('validates valid cron expressions', () => {
    expect(isValidScheduleExpression({ syntax: 'cron', expression: '0 9 * * 1-5' })).toBe(true);
    expect(isValidScheduleExpression({ syntax: 'cron', expression: '*/5 * * * *' })).toBe(true);
  });

  test('rejects invalid cron expressions', () => {
    expect(isValidScheduleExpression({ syntax: 'cron', expression: 'not valid' })).toBe(false);
    expect(isValidScheduleExpression({ syntax: 'cron', expression: '' })).toBe(false);
  });

  test('computes next run for cron', () => {
    const now = Date.now();
    const next = computeNextRunAt({ syntax: 'cron', expression: '* * * * *' }, now);
    expect(next).toBeGreaterThan(now - 1);
    // Next minute should be within 60 seconds
    expect(next - now).toBeLessThanOrEqual(60_000);
  });
});

describe('recurrence engine — rrule', () => {
  test('validates RRULE with DTSTART', () => {
    const expr = 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
  });

  test('rejects RRULE without DTSTART', () => {
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: 'RRULE:FREQ=DAILY' })).toBe(false);
  });

  test('accepts RRULE set constructs', () => {
    const withExdate = 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20250105T090000Z';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: withExdate })).toBe(true);

    const withRdate = 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nRDATE:20250115T090000Z';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: withRdate })).toBe(true);

    const multiRrule = 'DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: multiRrule })).toBe(true);
  });

  test('computes next run for RRULE with future DTSTART', () => {
    // Use a date far in the future to ensure the test is stable
    const futureDate = new Date('2099-01-01T09:00:00Z');
    const expr = 'DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY';
    const next = computeNextRunAt({ syntax: 'rrule', expression: expr });
    expect(next).toBeGreaterThanOrEqual(futureDate.getTime());
  });

  test('throws when RRULE has no future runs (UNTIL in past)', () => {
    const expr = 'DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20200105T090000Z';
    expect(() => computeNextRunAt({ syntax: 'rrule', expression: expr })).toThrow(/no upcoming runs/);
  });

  test('throws for RRULE missing DTSTART in computeNextRunAt', () => {
    expect(() => computeNextRunAt({ syntax: 'rrule', expression: 'RRULE:FREQ=DAILY' })).toThrow(/DTSTART/);
  });

  test('computes next run for RRULE with EXDATE set construct', () => {
    const expr = 'DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20990101T090000Z';
    const next = computeNextRunAt({ syntax: 'rrule', expression: expr });
    // Should skip the excluded date and return January 2
    const jan2 = new Date('2099-01-02T09:00:00Z').getTime();
    expect(next).toBe(jan2);
  });
});
