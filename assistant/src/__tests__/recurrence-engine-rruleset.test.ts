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

// ── EXRULE behavioral tests ──────────────────────────────────────────

describe('EXRULE engine behavior', () => {
  test('EXRULE excludes matching occurrences from daily series', () => {
    // RRULE: every day at 09:00 starting Jan 1 2099
    // EXRULE: every Saturday and Sunday (weekends)
    // Expected: weekday occurrences only
    const expr = [
      'DTSTART:20990101T090000Z',
      'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'EXRULE:FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    ].join('\n');

    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);

    // Jan 1 2099 is a Thursday. Enumerate the first several occurrences
    // and verify that no Saturday (Jan 3) or Sunday (Jan 4) appears.
    const thu = new Date('2099-01-01T09:00:00Z').getTime(); // Thu
    const fri = new Date('2099-01-02T09:00:00Z').getTime(); // Fri
    const sat = new Date('2099-01-03T09:00:00Z').getTime(); // Sat
    const sun = new Date('2099-01-04T09:00:00Z').getTime(); // Sun
    const mon = new Date('2099-01-05T09:00:00Z').getTime(); // Mon

    // After Thu -> should be Fri (not Sat/Sun)
    const afterThu = computeNextRunAt({ syntax: 'rrule', expression: expr }, thu + 1);
    expect(afterThu).toBe(fri);

    // After Fri -> should skip Sat+Sun, land on Mon
    const afterFri = computeNextRunAt({ syntax: 'rrule', expression: expr }, fri + 1);
    expect(afterFri).toBe(mon);

    // Explicitly confirm Sat and Sun are never returned
    expect(afterFri).not.toBe(sat);
    expect(afterFri).not.toBe(sun);
  });

  test('EXRULE with FREQ acts as repeating exclusion series', () => {
    // RRULE: every day starting Jan 1 2099
    // EXRULE: every 3rd day starting Jan 1 2099 (excludes Jan 1, Jan 4, Jan 7, ...)
    const expr = [
      'DTSTART:20990101T090000Z',
      'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'EXRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    ].join('\n');

    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);

    const jan1 = new Date('2099-01-01T09:00:00Z').getTime();
    const jan2 = new Date('2099-01-02T09:00:00Z').getTime();
    const jan3 = new Date('2099-01-03T09:00:00Z').getTime();
    const jan4 = new Date('2099-01-04T09:00:00Z').getTime();
    const jan5 = new Date('2099-01-05T09:00:00Z').getTime();

    // Jan 1 is excluded (EXRULE fires on DTSTART). First occurrence after
    // DTSTART should be Jan 2.
    const first = computeNextRunAt({ syntax: 'rrule', expression: expr }, jan1 - 1);
    expect(first).toBe(jan2);

    // After Jan 2 -> Jan 3 (Jan 3 not excluded)
    const second = computeNextRunAt({ syntax: 'rrule', expression: expr }, jan2 + 1);
    expect(second).toBe(jan3);

    // After Jan 3 -> should skip Jan 4 (excluded, 3 days after Jan 1) -> Jan 5
    const third = computeNextRunAt({ syntax: 'rrule', expression: expr }, jan3 + 1);
    expect(third).toBe(jan5);
    expect(third).not.toBe(jan4);
  });

  test('EXRULE does not affect non-matching occurrences', () => {
    // RRULE: every weekday (Mon-Fri) at 09:00
    // EXRULE: every Saturday at 09:00 (no overlap with weekday rule)
    // Expected: all weekday occurrences remain intact
    const expr = [
      'DTSTART:20990105T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      'EXRULE:FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    ].join('\n');

    expect(isValidScheduleExpression({ syntax: 'rrule', expression: expr })).toBe(true);

    // Jan 5 2099 is a Monday. Verify all five weekdays in the first week appear.
    const mon = new Date('2099-01-05T09:00:00Z').getTime();
    const tue = new Date('2099-01-06T09:00:00Z').getTime();
    const wed = new Date('2099-01-07T09:00:00Z').getTime();
    const thu = new Date('2099-01-08T09:00:00Z').getTime();
    const fri = new Date('2099-01-09T09:00:00Z').getTime();
    const nextMon = new Date('2099-01-12T09:00:00Z').getTime();

    expect(computeNextRunAt({ syntax: 'rrule', expression: expr }, mon + 1)).toBe(tue);
    expect(computeNextRunAt({ syntax: 'rrule', expression: expr }, tue + 1)).toBe(wed);
    expect(computeNextRunAt({ syntax: 'rrule', expression: expr }, wed + 1)).toBe(thu);
    expect(computeNextRunAt({ syntax: 'rrule', expression: expr }, thu + 1)).toBe(fri);
    // After Fri -> skips weekend entirely (Sat excluded + Sun not in RRULE) -> Mon
    expect(computeNextRunAt({ syntax: 'rrule', expression: expr }, fri + 1)).toBe(nextMon);
  });
});
