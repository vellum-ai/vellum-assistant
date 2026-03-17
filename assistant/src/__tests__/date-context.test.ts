import { describe, expect, test } from "bun:test";

import {
  buildTemporalContext,
  extractUserTimeZoneFromRecall,
} from "../daemon/date-context.js";

// Fixed timestamps for deterministic assertions (all UTC midday to avoid DST edge cases).

/** Wednesday 2026-02-18 12:00 UTC */
const WED_FEB_18 = Date.UTC(2026, 1, 18, 12, 0, 0);

/** Saturday 2026-02-21 12:00 UTC */
const SAT_FEB_21 = Date.UTC(2026, 1, 21, 12, 0, 0);

/** Sunday 2026-02-22 12:00 UTC */
const SUN_FEB_22 = Date.UTC(2026, 1, 22, 12, 0, 0);

/** Tuesday 2026-12-29 12:00 UTC — year boundary */
const TUE_DEC_29 = Date.UTC(2026, 11, 29, 12, 0, 0);

/** Friday 2026-02-27 12:00 UTC */
const FRI_FEB_27 = Date.UTC(2026, 1, 27, 12, 0, 0);

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe("buildTemporalContext", () => {
  test("returns output wrapped in <temporal_context> tags", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toStartWith("<temporal_context>");
    expect(result).toEndWith("</temporal_context>");
  });

  test("includes today date and weekday", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Today: 2026-02-18 (Wednesday)");
  });

  test("includes timezone", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "America/New_York",
    });
    expect(result).toContain("Timezone: America/New_York");
  });

  test("includes current local time as ISO 8601 with offset", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Current local time: 2026-02-18T12:00:00+00:00");
  });

  test("includes current UTC time from assistant host clock", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Current UTC time: 2026-02-18T12:00:00.000Z");
  });

  test("documents assistant host as the authoritative clock source", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Clock source: assistant host machine");
  });

  test("uses user timezone when provided and records source metadata", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(result).toContain("Timezone: America/New_York");
    expect(result).toContain("Current local time: 2026-02-18T07:00:00-05:00");
    expect(result).toContain("Assistant host timezone: UTC");
    expect(result).toContain("User timezone: America/New_York");
    expect(result).toContain("Timezone source: user_profile_memory");
  });

  test("uses configured user timezone when profile timezone is unavailable", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "America/Chicago",
      userTimeZone: null,
    });
    expect(result).toContain("Timezone: America/Chicago");
    expect(result).toContain("Current local time: 2026-02-18T06:00:00-06:00");
    expect(result).toContain("User timezone: America/Chicago");
    expect(result).toContain("Timezone source: user_settings");
  });

  test("configured user timezone takes precedence over profile timezone", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "America/Los_Angeles",
      userTimeZone: "America/New_York",
    });
    expect(result).toContain("Timezone: America/Los_Angeles");
    expect(result).toContain("Current local time: 2026-02-18T04:00:00-08:00");
    expect(result).toContain("User timezone: America/Los_Angeles");
    expect(result).toContain("Timezone source: user_settings");
  });

  test("falls back to host timezone when user timezone is unavailable", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: null,
    });
    expect(result).toContain("Timezone: UTC");
    expect(result).toContain("User timezone: unknown");
    expect(result).toContain("Timezone source: assistant_host_fallback");
  });

  test("accepts UTC/GMT offset-style user timezone values", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "UTC+2",
    });
    expect(result).toContain("Timezone: Etc/GMT-2");
    expect(result).toContain("Current local time: 2026-02-18T14:00:00+02:00");
    expect(result).toContain("User timezone: Etc/GMT-2");
    expect(result).toContain("Timezone source: user_profile_memory");
  });

  test("accepts fractional UTC/GMT offset-style user timezone values", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "UTC+5:30",
    });
    expect(result).toContain("Timezone: +05:30");
    expect(result).toContain("Current local time: 2026-02-18T17:30:00+05:30");
    expect(result).toContain("User timezone: +05:30");
    expect(result).toContain("Timezone source: user_profile_memory");
  });

  test("includes week definitions", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("work week = Monday–Friday");
    expect(result).toContain("weekend = Saturday–Sunday");
  });

  test("formats midnight hours as 00 (never 24) in local ISO output", () => {
    const justAfterMidnight = Date.UTC(2026, 1, 19, 0, 5, 0);
    const result = buildTemporalContext({
      nowMs: justAfterMidnight,
      timeZone: "UTC",
    });
    expect(result).toContain("Current local time: 2026-02-19T00:05:00+00:00");
    expect(result).not.toContain("T24:05:00");
  });
});

// ---------------------------------------------------------------------------
// Weekday baseline — today is Wednesday
// ---------------------------------------------------------------------------

describe("weekday baseline (Wednesday)", () => {
  test("next weekend is the upcoming Saturday-Sunday", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    // Wednesday Feb 18 → next Saturday is Feb 21, Sunday is Feb 22
    expect(result).toContain("Next weekend: 2026-02-21 – 2026-02-22");
  });

  test("next work week is the following Monday-Friday", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    // Wednesday Feb 18 → next Monday is Feb 23, Friday is Feb 27
    expect(result).toContain("Next work week: 2026-02-23 – 2026-02-27");
  });
});

// ---------------------------------------------------------------------------
// Weekend baseline — today is Saturday
// ---------------------------------------------------------------------------

describe("weekend baseline (Saturday)", () => {
  test("next weekend is the *following* Saturday-Sunday, not today", () => {
    const result = buildTemporalContext({ nowMs: SAT_FEB_21, timeZone: "UTC" });
    // Saturday Feb 21 → next Saturday is Feb 28, Sunday is Mar 1
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test("next work week is the upcoming Monday-Friday", () => {
    const result = buildTemporalContext({ nowMs: SAT_FEB_21, timeZone: "UTC" });
    // Saturday Feb 21 → next Monday is Feb 23, Friday is Feb 27
    expect(result).toContain("Next work week: 2026-02-23 – 2026-02-27");
  });
});

// ---------------------------------------------------------------------------
// Weekend baseline — today is Sunday
// ---------------------------------------------------------------------------

describe("weekend baseline (Sunday)", () => {
  test("next weekend is the following Saturday-Sunday", () => {
    const result = buildTemporalContext({ nowMs: SUN_FEB_22, timeZone: "UTC" });
    // Sunday Feb 22 → next Saturday is Feb 28, Sunday is Mar 1
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test("next work week is the upcoming Monday-Friday", () => {
    const result = buildTemporalContext({ nowMs: SUN_FEB_22, timeZone: "UTC" });
    // Sunday Feb 22 → next Monday is Feb 23, Friday is Feb 27
    expect(result).toContain("Next work week: 2026-02-23 – 2026-02-27");
  });
});

// ---------------------------------------------------------------------------
// Friday baseline
// ---------------------------------------------------------------------------

describe("Friday baseline", () => {
  test("next weekend is tomorrow (Saturday) and Sunday", () => {
    const result = buildTemporalContext({ nowMs: FRI_FEB_27, timeZone: "UTC" });
    // Friday Feb 27 → next Saturday is Feb 28, Sunday is Mar 1
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test("next work week is the following Monday-Friday", () => {
    const result = buildTemporalContext({ nowMs: FRI_FEB_27, timeZone: "UTC" });
    // Friday Feb 27 → next Monday is Mar 2, Friday is Mar 6
    expect(result).toContain("Next work week: 2026-03-02 – 2026-03-06");
  });
});

// ---------------------------------------------------------------------------
// Month / year boundary
// ---------------------------------------------------------------------------

describe("month/year boundary", () => {
  test("handles year boundary correctly", () => {
    const result = buildTemporalContext({ nowMs: TUE_DEC_29, timeZone: "UTC" });
    expect(result).toContain("Today: 2026-12-29 (Tuesday)");
    // Tuesday Dec 29 → next Saturday is Jan 2 2027
    expect(result).toContain("Next weekend: 2027-01-02 – 2027-01-03");
    // Next Monday is Jan 4 2027 (skips current work week)
    // Wait — Dec 29 is Tuesday, so next Monday = Jan 4? Let me think:
    // Dec 29 Tue → Mon is (1-2+7)%7 = 6 days → Jan 4 Mon
    expect(result).toContain("Next work week: 2027-01-04 – 2027-01-08");
  });

  test("horizon entries cross year boundary", () => {
    const result = buildTemporalContext({
      nowMs: TUE_DEC_29,
      timeZone: "UTC",
      horizonDays: 5,
    });
    expect(result).toContain("2026-12-30 Wednesday");
    expect(result).toContain("2026-12-31 Thursday");
    expect(result).toContain("2027-01-01 Friday");
    expect(result).toContain("2027-01-02 Saturday");
    expect(result).toContain("2027-01-03 Sunday");
  });
});

// ---------------------------------------------------------------------------
// Output size caps
// ---------------------------------------------------------------------------

describe("output size caps", () => {
  test("output is at most 1500 characters", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "UTC",
      horizonDays: 14,
    });
    expect(result.length).toBeLessThanOrEqual(1500);
  });

  test("horizon entries are capped at 14 even if more requested", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "UTC",
      horizonDays: 30,
    });
    const horizonMatches = result.match(/^\s+\d{4}-\d{2}-\d{2} \w+$/gm);
    expect(horizonMatches).not.toBeNull();
    expect(horizonMatches!.length).toBeLessThanOrEqual(14);
  });

  test("default horizon is 14 days", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    const horizonMatches = result.match(/^\s+\d{4}-\d{2}-\d{2} \w+$/gm);
    expect(horizonMatches).not.toBeNull();
    expect(horizonMatches!.length).toBe(14);
  });

  test("respects smaller horizonDays", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "UTC",
      horizonDays: 3,
    });
    const horizonMatches = result.match(/^\s+\d{4}-\d{2}-\d{2} \w+$/gm);
    expect(horizonMatches).not.toBeNull();
    expect(horizonMatches!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DST-safe timezone behavior
// ---------------------------------------------------------------------------

describe("DST-safe timezone behavior", () => {
  test("date labels are correct in US Eastern timezone", () => {
    // Feb 18 12:00 UTC = Feb 18 07:00 EST (same calendar date)
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "America/New_York",
    });
    expect(result).toContain("Today: 2026-02-18 (Wednesday)");
    expect(result).toContain("Current local time: 2026-02-18T07:00:00-05:00");
  });

  test("date labels are correct in timezone ahead of UTC", () => {
    // Use a timestamp near midnight UTC so the local date differs
    // Feb 18 23:00 UTC = Feb 19 08:00 JST
    const nearMidnight = Date.UTC(2026, 1, 18, 23, 0, 0);
    const result = buildTemporalContext({
      nowMs: nearMidnight,
      timeZone: "Asia/Tokyo",
    });
    expect(result).toContain("Today: 2026-02-19 (Thursday)");
  });

  test("addDays is correct across DST spring-forward boundary", () => {
    // 2026-03-08 is spring-forward day in America/New_York (clocks jump 2:00→3:00 AM).
    // Use a timestamp at local 23:30 on Friday March 6 (04:30 UTC March 7).
    const preDST = Date.UTC(2026, 2, 7, 4, 30, 0); // local: Fri Mar 6 23:30 EST
    const result = buildTemporalContext({
      nowMs: preDST,
      timeZone: "America/New_York",
      horizonDays: 5,
    });
    // Today should be Friday March 6
    expect(result).toContain("Today: 2026-03-06 (Friday)");
    // Horizon should have 5 consecutive days with no duplicates/skips
    expect(result).toContain("2026-03-07 Saturday");
    expect(result).toContain("2026-03-08 Sunday");
    expect(result).toContain("2026-03-09 Monday");
    expect(result).toContain("2026-03-10 Tuesday");
    expect(result).toContain("2026-03-11 Wednesday");
  });

  test("addDays is correct across DST fall-back boundary", () => {
    // 2026-11-01 is fall-back day in America/New_York (clocks jump 2:00→1:00 AM).
    // Use a timestamp at local 00:30 on Sunday Nov 1 (04:30 UTC Nov 1).
    const preFallback = Date.UTC(2026, 10, 1, 4, 30, 0); // local: Sun Nov 1 00:30 EDT
    const result = buildTemporalContext({
      nowMs: preFallback,
      timeZone: "America/New_York",
      horizonDays: 3,
    });
    // Today should be Sunday Nov 1
    expect(result).toContain("Today: 2026-11-01 (Sunday)");
    // Horizon should have 3 consecutive days
    expect(result).toContain("2026-11-02 Monday");
    expect(result).toContain("2026-11-03 Tuesday");
    expect(result).toContain("2026-11-04 Wednesday");
  });

  test("dates are correct in far-east UTC+13 timezone (Pacific/Auckland NZDT)", () => {
    // Feb 18 12:00 UTC = Feb 19 01:00 NZDT (UTC+13 during daylight saving)
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "Pacific/Auckland",
      horizonDays: 3,
    });
    // In Auckland, Feb 18 12:00 UTC is already Feb 19 (Thursday)
    expect(result).toContain("Today: 2026-02-19 (Thursday)");
    // Horizon should show consecutive days without +1 shift
    expect(result).toContain("2026-02-20 Friday");
    expect(result).toContain("2026-02-21 Saturday");
    expect(result).toContain("2026-02-22 Sunday");
  });

  test("local offset tracks daylight saving changes", () => {
    // Jul 1 12:00 UTC = Jul 1 08:00 EDT
    const summer = Date.UTC(2026, 6, 1, 12, 0, 0);
    const result = buildTemporalContext({
      nowMs: summer,
      timeZone: "America/New_York",
    });
    expect(result).toContain("Current local time: 2026-07-01T08:00:00-04:00");
  });
});

// ---------------------------------------------------------------------------
// Trip-planning regression: "next weekend" resolution
// ---------------------------------------------------------------------------

describe("trip-planning: next weekend resolution", () => {
  test('Wednesday → "next weekend" anchors resolve to upcoming Sat-Sun', () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    // A user asking "plan a trip for next weekend" on Wednesday Feb 18
    // expects Sat Feb 21 – Sun Feb 22.
    expect(result).toContain("Next weekend: 2026-02-21 – 2026-02-22");
    // Both dates must appear in the horizon so the model can reference them.
    expect(result).toContain("2026-02-21 Saturday");
    expect(result).toContain("2026-02-22 Sunday");
  });

  test('Saturday → "next weekend" skips current weekend', () => {
    const result = buildTemporalContext({ nowMs: SAT_FEB_21, timeZone: "UTC" });
    // Already on Saturday → "next weekend" means the *following* weekend.
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test('Sunday → "next weekend" skips current weekend', () => {
    const result = buildTemporalContext({ nowMs: SUN_FEB_22, timeZone: "UTC" });
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test('Friday → "next weekend" is tomorrow', () => {
    const result = buildTemporalContext({ nowMs: FRI_FEB_27, timeZone: "UTC" });
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });
});

// ---------------------------------------------------------------------------
// Trip-planning regression: "next work week" resolution
// ---------------------------------------------------------------------------

describe("trip-planning: next work week resolution", () => {
  test('Wednesday → "next work week" skips remainder of current week', () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Next work week: 2026-02-23 – 2026-02-27");
  });

  test('Monday → "next work week" is the following Monday-Friday', () => {
    /** Monday 2026-02-23 12:00 UTC */
    const MON_FEB_23 = Date.UTC(2026, 1, 23, 12, 0, 0);
    const result = buildTemporalContext({ nowMs: MON_FEB_23, timeZone: "UTC" });
    expect(result).toContain("Next work week: 2026-03-02 – 2026-03-06");
  });

  test('Saturday → "next work week" is the upcoming Monday-Friday', () => {
    const result = buildTemporalContext({ nowMs: SAT_FEB_21, timeZone: "UTC" });
    expect(result).toContain("Next work week: 2026-02-23 – 2026-02-27");
  });
});

// ---------------------------------------------------------------------------
// Trip-planning regression: month-without-year disambiguation
// ---------------------------------------------------------------------------

describe("trip-planning: month-without-year disambiguation via temporal anchors", () => {
  test("Today line includes full YYYY-MM-DD format with year for month disambiguation", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    // The Today line must include the full year so the model can resolve bare
    // month names (e.g. "May" → May 2026 because today is Feb 2026).
    // Regex ensures YYYY-MM-DD format is present (regression if year is dropped).
    expect(result).toMatch(/Today: \d{4}-\d{2}-\d{2} \(\w+\)/);
    expect(result).toContain("2026-02-18");
  });

  test("future-month anchors: horizon dates are all in the future relative to today", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "UTC",
      horizonDays: 14,
    });
    // Extract all horizon dates (indented YYYY-MM-DD lines)
    const horizonDates = result.match(/^\s+(\d{4}-\d{2}-\d{2}) \w+$/gm);
    expect(horizonDates).not.toBeNull();
    // All horizon dates must be after today (2026-02-18)
    for (const line of horizonDates!) {
      const dateStr = line.trim().split(" ")[0];
      expect(dateStr > "2026-02-18").toBe(true);
    }
  });

  test("year-end context: horizon spans into next year for Dec disambiguation", () => {
    const result = buildTemporalContext({
      nowMs: TUE_DEC_29,
      timeZone: "UTC",
      horizonDays: 14,
    });
    // Today is Dec 29 2026 — horizon must include 2027 dates so the model can
    // distinguish "January" (Jan 2027) from past January (Jan 2026).
    expect(result).toContain("Today: 2026-12-29");
    expect(result).toMatch(/2027-01-\d{2} \w+/); // At least one January 2027 date
  });

  test("timezone is always present for correct local-month resolution", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "America/New_York",
    });
    // Timezone must be present so the model resolves months in the user's
    // local calendar, not UTC.
    expect(result).toMatch(/Timezone: .+/);
    expect(result).toContain("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// Trip-planning regression: cross-month weekend resolution
// ---------------------------------------------------------------------------

describe("trip-planning: cross-month weekend resolution", () => {
  test("weekend that spans a month boundary (Feb → Mar)", () => {
    const result = buildTemporalContext({ nowMs: FRI_FEB_27, timeZone: "UTC" });
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });

  test("year-boundary weekend (Dec 2026 → Jan 2027)", () => {
    const result = buildTemporalContext({ nowMs: TUE_DEC_29, timeZone: "UTC" });
    expect(result).toContain("Next weekend: 2027-01-02 – 2027-01-03");
  });
});

// ---------------------------------------------------------------------------
// Trip-planning regression: timezone-shifted weekend anchors
// ---------------------------------------------------------------------------

describe("trip-planning: timezone-shifted weekend anchors", () => {
  test("late Friday UTC is already Saturday in Auckland → skips to next weekend", () => {
    // Friday Feb 27 23:00 UTC = Saturday Feb 28 12:00 NZDT
    const lateFriUTC = Date.UTC(2026, 1, 27, 23, 0, 0);
    const result = buildTemporalContext({
      nowMs: lateFriUTC,
      timeZone: "Pacific/Auckland",
    });
    expect(result).toContain("Today: 2026-02-28 (Saturday)");
    // "Next weekend" skips current weekend → Mar 7-8.
    expect(result).toContain("Next weekend: 2026-03-07 – 2026-03-08");
  });

  test("early Saturday UTC is still Friday in US Pacific → next weekend is tomorrow", () => {
    // Saturday Feb 28 02:00 UTC = Friday Feb 27 18:00 PST
    const earlySatUTC = Date.UTC(2026, 1, 28, 2, 0, 0);
    const result = buildTemporalContext({
      nowMs: earlySatUTC,
      timeZone: "America/Los_Angeles",
    });
    expect(result).toContain("Today: 2026-02-27 (Friday)");
    expect(result).toContain("Next weekend: 2026-02-28 – 2026-03-01");
  });
});

// ---------------------------------------------------------------------------
// extractUserTimeZoneFromRecall
// ---------------------------------------------------------------------------

describe("extractUserTimeZoneFromRecall", () => {
  test("returns null for empty input", () => {
    expect(extractUserTimeZoneFromRecall("")).toBeNull();
    expect(extractUserTimeZoneFromRecall("  ")).toBeNull();
  });

  test("extracts IANA timezone from user_identity section", () => {
    const text = `<memory_context __injected>

<user_identity>
User's timezone is America/New_York
User works as a software engineer
</user_identity>

</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("America/New_York");
  });

  test("extracts timezone from 'timezone: ...' line in identity", () => {
    const text = `<memory_context __injected>

<user_identity>
- name: Alice
- timezone: Europe/London
- role: designer
</user_identity>

</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("Europe/London");
  });

  test("extracts UTC offset timezone", () => {
    const text = `<memory_context __injected>

<user_identity>
User's time zone is UTC+5:30
</user_identity>

</memory_context>`;
    const result = extractUserTimeZoneFromRecall(text);
    expect(result).not.toBeNull();
    // UTC+5:30 should canonicalize to +05:30
    expect(result).toBe("+05:30");
  });

  test("falls back to scanning full text when no identity section", () => {
    const text = `<memory_context __injected>

<relevant_context>
<episode source="Mar 5">
User mentioned their timezone is Asia/Tokyo
</episode>
</relevant_context>

</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("Asia/Tokyo");
  });

  test("returns null when no timezone info present", () => {
    const text = `<memory_context __injected>

<user_identity>
User's name is Bob
User works at Acme Corp
</user_identity>

</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBeNull();
  });

  test("prefers identity section over other sections", () => {
    const text = `<memory_context __injected>

<user_identity>
User's timezone is America/Chicago
</user_identity>

<relevant_context>
<episode source="Mar 5">
Discussed timezone America/Los_Angeles for the deployment
</episode>
</relevant_context>

</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("America/Chicago");
  });
});
