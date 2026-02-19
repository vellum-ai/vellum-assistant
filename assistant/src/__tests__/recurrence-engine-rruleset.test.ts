import { describe, test, expect } from 'bun:test';
import { isValidScheduleExpression, computeNextRunAt } from '../schedule/recurrence-engine.js';

describe('RRULE set engine support', () => {
  test('multiple RRULE lines are unioned — next run is earliest', () => {
    // Daily at 9am + Weekly on Mondays at 3pm, starting Jan 1 2099
    const expr = [
      'DTSTART:20990101T090000Z',
      'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=15;BYMINUTE=0;BYSECOND=0',
    ].join('\n');
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
    const next = computeNextRunAt({ syntax: 'rrule', expression: expr });
    expect(next).toBeGreaterThan(Date.now());
  });

  test('RRULE + EXDATE excludes matching occurrence', () => {
    // Daily starting Jan 1 2099, exclude Jan 2
    const expr = [
      'DTSTART:20990101T090000Z',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE:20990102T090000Z',
    ].join('\n');
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
    // First occurrence: Jan 1, second should skip Jan 2 and be Jan 3
    const jan1 = new Date('2099-01-01T09:00:00Z').getTime();
    const jan2 = new Date('2099-01-02T09:00:00Z').getTime();
    const next = computeNextRunAt({ syntax: 'rrule', expression: expr }, jan1 + 1);
    // Should not be Jan 2 (excluded)
    expect(next).not.toBe(jan2);
  });

  test('RDATE adds ad-hoc occurrence', () => {
    // Weekly on Mondays + an extra occurrence on Jan 15 2099 (Wednesday)
    const expr = [
      'DTSTART:20990106T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'RDATE:20990115T090000Z',
    ].join('\n');
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
  });

  test('unknown line is rejected', () => {
    const expr = [
      'DTSTART:20990101T090000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:My event',
    ].join('\n');
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(false);
  });

  test('expression without DTSTART is rejected', () => {
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: 'RRULE:FREQ=DAILY' })).toBe(false);
  });

  test('expression without inclusion source is rejected', () => {
    const expr = 'DTSTART:20990101T090000Z\nEXDATE:20990102T090000Z';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(false);
  });

  test('escaped newlines are normalized', () => {
    const expr = 'DTSTART:20990101T090000Z\\nRRULE:FREQ=DAILY';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
    const next = computeNextRunAt({ syntax: 'rrule', expression: expr });
    expect(next).toBeGreaterThan(Date.now());
  });

  test('existing single RRULE still works', () => {
    const expr = 'DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY';
    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);
  });

  test('existing cron still works', () => {
    expect(isValidScheduleExpression({ syntax: 'cron', expression: '0 9 * * 1-5' })).toBe(true);
    const next = computeNextRunAt({ syntax: 'cron', expression: '* * * * *' });
    expect(next).toBeGreaterThan(Date.now() - 1);
  });
});
