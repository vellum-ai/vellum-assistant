import { describe, expect, test } from "bun:test";

import {
  buildTemporalContext,
  extractUserTimeZoneFromRecall,
} from "../daemon/date-context.js";

// Fixed timestamps for deterministic assertions (all UTC midday to avoid DST edge cases).

/** Wednesday 2026-02-18 12:00 UTC */
const WED_FEB_18 = Date.UTC(2026, 1, 18, 12, 0, 0);

/** Tuesday 2026-12-29 12:00 UTC - year boundary */
const TUE_DEC_29 = Date.UTC(2026, 11, 29, 12, 0, 0);

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

  test("includes timezone source", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Timezone source:");
  });

  test("does not include week definitions, next weekend, next work week, or horizon dates", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).not.toContain("Week definitions");
    expect(result).not.toContain("Next weekend");
    expect(result).not.toContain("Next work week");
    expect(result).not.toContain("Upcoming dates");
  });

  test("uses user timezone when provided and records source metadata", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(result).toContain("Timezone: America/New_York");
    expect(result).toContain("Current local time: 2026-02-18T07:00:00-05:00");
    expect(result).toContain("Timezone source: user_profile_memory");
  });

  test("shows user timezone only when different from primary timezone", () => {
    // When user timezone equals the primary timezone, omit it
    const sameResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "UTC",
    });
    expect(sameResult).not.toContain("User timezone:");

    // When user timezone differs from host, it becomes the primary timezone
    // and the host timezone is shown as a secondary annotation
    const diffResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(diffResult).toContain("Timezone: America/New_York");
    expect(diffResult).toContain("Assistant host timezone: UTC");
    expect(diffResult).not.toContain("User timezone:");
  });

  test("shows assistant host timezone only when different from primary timezone", () => {
    // When host timezone equals the primary timezone, omit it
    const sameResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      timeZone: "UTC",
    });
    expect(sameResult).not.toContain("Assistant host timezone:");

    // When different, include it
    const diffResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(diffResult).toContain("Assistant host timezone: UTC");
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
    expect(result).toContain("Timezone source: user_settings");
  });

  test("falls back to host timezone when user timezone is unavailable", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: null,
    });
    expect(result).toContain("Timezone: UTC");
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
    expect(result).toContain("Timezone source: user_profile_memory");
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

  test("Today line includes full YYYY-MM-DD format with year", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toMatch(/Today: \d{4}-\d{2}-\d{2} \(\w+\)/);
    expect(result).toContain("2026-02-18");
  });

  test("handles year boundary correctly", () => {
    const result = buildTemporalContext({ nowMs: TUE_DEC_29, timeZone: "UTC" });
    expect(result).toContain("Today: 2026-12-29 (Tuesday)");
  });
});

// ---------------------------------------------------------------------------
// DST-safe timezone behavior
// ---------------------------------------------------------------------------

describe("DST-safe timezone behavior", () => {
  test("date labels are correct in US Eastern timezone", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "America/New_York",
    });
    expect(result).toContain("Today: 2026-02-18 (Wednesday)");
    expect(result).toContain("Current local time: 2026-02-18T07:00:00-05:00");
  });

  test("date labels are correct in timezone ahead of UTC", () => {
    // Feb 18 23:00 UTC = Feb 19 08:00 JST
    const nearMidnight = Date.UTC(2026, 1, 18, 23, 0, 0);
    const result = buildTemporalContext({
      nowMs: nearMidnight,
      timeZone: "Asia/Tokyo",
    });
    expect(result).toContain("Today: 2026-02-19 (Thursday)");
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
