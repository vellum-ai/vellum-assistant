import { describe, expect, test } from "bun:test";

import {
  buildTemporalContext,
  extractUserTimeZoneFromRecall,
  formatTurnTimestamp,
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

  test("includes today date, weekday, time and offset on one line", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toContain("Today: 2026-02-18 (Wed) 12:00 +00:00");
  });

  test("includes timezone", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      timeZone: "America/New_York",
    });
    expect(result).toContain("TZ: America/New_York");
  });

  test("does not include UTC time, timezone source, or seconds", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).not.toContain("Current UTC time");
    expect(result).not.toContain("Current local time");
    expect(result).not.toContain("Timezone source:");
    // No seconds in the time
    expect(result).not.toContain("12:00:00");
  });

  test("does not include week definitions, next weekend, next work week, or horizon dates", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).not.toContain("Week definitions");
    expect(result).not.toContain("Next weekend");
    expect(result).not.toContain("Next work week");
    expect(result).not.toContain("Upcoming dates");
  });

  test("uses user timezone when provided", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(result).toContain("TZ: America/New_York");
    expect(result).toContain("Today: 2026-02-18 (Wed) 07:00 -05:00");
    expect(result).not.toContain("(host fallback)");
  });

  test("shows user TZ only when different from primary timezone", () => {
    // When user timezone equals the primary timezone, omit it
    const sameResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "UTC",
    });
    expect(sameResult).not.toContain("User TZ:");

    // When user timezone differs from host, it becomes the primary timezone
    // and the host timezone is shown as a secondary annotation
    const diffResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(diffResult).toContain("TZ: America/New_York");
    expect(diffResult).toContain("Host TZ: UTC");
    expect(diffResult).not.toContain("User TZ:");
  });

  test("shows host TZ only when different from primary timezone", () => {
    // When host timezone equals the primary timezone, omit it
    const sameResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      timeZone: "UTC",
    });
    expect(sameResult).not.toContain("Host TZ:");

    // When different, include it
    const diffResult = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "America/New_York",
    });
    expect(diffResult).toContain("Host TZ: UTC");
  });

  test("uses configured user timezone when profile timezone is unavailable", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "America/Chicago",
      userTimeZone: null,
    });
    expect(result).toContain("TZ: America/Chicago");
    expect(result).toContain("Today: 2026-02-18 (Wed) 06:00 -06:00");
    expect(result).not.toContain("(host fallback)");
  });

  test("configured user timezone takes precedence over profile timezone", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "America/Los_Angeles",
      userTimeZone: "America/New_York",
    });
    expect(result).toContain("TZ: America/Los_Angeles");
    expect(result).toContain("Today: 2026-02-18 (Wed) 04:00 -08:00");
  });

  test("falls back to host timezone with (host fallback) suffix", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: null,
    });
    expect(result).toContain("TZ: UTC (host fallback)");
  });

  test("accepts UTC/GMT offset-style user timezone values", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "UTC+2",
    });
    expect(result).toContain("TZ: Etc/GMT-2");
    expect(result).toContain("Today: 2026-02-18 (Wed) 14:00 +02:00");
    expect(result).not.toContain("(host fallback)");
  });

  test("accepts fractional UTC/GMT offset-style user timezone values", () => {
    const result = buildTemporalContext({
      nowMs: WED_FEB_18,
      hostTimeZone: "UTC",
      userTimeZone: "UTC+5:30",
    });
    expect(result).toContain("TZ: +05:30");
    expect(result).toContain("Today: 2026-02-18 (Wed) 17:30 +05:30");
    expect(result).not.toContain("(host fallback)");
  });

  test("formats midnight hours as 00 (never 24)", () => {
    const justAfterMidnight = Date.UTC(2026, 1, 19, 0, 5, 0);
    const result = buildTemporalContext({
      nowMs: justAfterMidnight,
      timeZone: "UTC",
    });
    expect(result).toContain("00:05 +00:00");
    expect(result).not.toContain("24:05");
  });

  test("Today line includes full YYYY-MM-DD format with year", () => {
    const result = buildTemporalContext({ nowMs: WED_FEB_18, timeZone: "UTC" });
    expect(result).toMatch(/Today: \d{4}-\d{2}-\d{2} \(\w{3}\) \d{2}:\d{2}/);
    expect(result).toContain("2026-02-18");
  });

  test("handles year boundary correctly", () => {
    const result = buildTemporalContext({ nowMs: TUE_DEC_29, timeZone: "UTC" });
    expect(result).toContain("Today: 2026-12-29 (Tue)");
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
    expect(result).toContain("Today: 2026-02-18 (Wed) 07:00 -05:00");
  });

  test("date labels are correct in timezone ahead of UTC", () => {
    // Feb 18 23:00 UTC = Feb 19 08:00 JST
    const nearMidnight = Date.UTC(2026, 1, 18, 23, 0, 0);
    const result = buildTemporalContext({
      nowMs: nearMidnight,
      timeZone: "Asia/Tokyo",
    });
    expect(result).toContain("Today: 2026-02-19 (Thu) 08:00 +09:00");
  });

  test("local offset tracks daylight saving changes", () => {
    // Jul 1 12:00 UTC = Jul 1 08:00 EDT
    const summer = Date.UTC(2026, 6, 1, 12, 0, 0);
    const result = buildTemporalContext({
      nowMs: summer,
      timeZone: "America/New_York",
    });
    expect(result).toContain("Today: 2026-07-01 (Wed) 08:00 -04:00");
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

  test("extracts IANA timezone from identity item", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">User's timezone is America/New_York</item>
<item id="item:2" kind="identity" importance="0.80" timestamp="2026-03-01 10:00 PST">User works as a software engineer</item>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("America/New_York");
  });

  test("extracts timezone from 'timezone: ...' in identity item", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">timezone: Europe/London</item>
<item id="item:2" kind="identity" importance="0.80" timestamp="2026-03-01 10:00 PST">name: Alice</item>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("Europe/London");
  });

  test("extracts UTC offset timezone", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">User's time zone is UTC+5:30</item>
</recalled>
</memory_context>`;
    const result = extractUserTimeZoneFromRecall(text);
    expect(result).not.toBeNull();
    expect(result).toBe("+05:30");
  });

  test("falls back to scanning full text when no identity items", () => {
    const text = `<memory_context __injected>
<recalled>
<segment id="seg:1" timestamp="2026-03-05 10:00 PST">User mentioned their timezone is Asia/Tokyo</segment>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("Asia/Tokyo");
  });

  test("returns null when no timezone info present", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">User's name is Bob</item>
<item id="item:2" kind="identity" importance="0.80" timestamp="2026-03-01 10:00 PST">User works at Acme Corp</item>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBeNull();
  });

  test("prefers identity items over other recalled content", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">User's timezone is America/Chicago</item>
<segment id="seg:1" timestamp="2026-03-05 10:00 PST">Discussed timezone America/Los_Angeles for the deployment</segment>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("America/Chicago");
  });

  test("extracts timezone from identity item without timezone keyword via second pass", () => {
    const text = `<memory_context __injected>
<recalled>
<item id="item:1" kind="identity" importance="0.90" timestamp="2026-03-01 10:00 PST">America/Denver</item>
</recalled>
</memory_context>`;
    expect(extractUserTimeZoneFromRecall(text)).toBe("America/Denver");
  });
});

// ---------------------------------------------------------------------------
// formatTurnTimestamp
// ---------------------------------------------------------------------------

describe("formatTurnTimestamp", () => {
  /** 2026-04-02 06:52:33 UTC (Thursday) */
  const THU_APR_02_0652 = Date.UTC(2026, 3, 2, 6, 52, 33);

  test("includes seconds in the timestamp", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      timeZone: "America/Chicago",
    });
    expect(result).toContain("01:52:33");
  });

  test("timezone name appears in parentheses", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      timeZone: "America/Chicago",
    });
    expect(result).toContain("(America/Chicago)");
  });

  test("produces expected full format", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      timeZone: "America/Chicago",
    });
    expect(result).toBe(
      "2026-04-02 (Thu) 01:52:33 -05:00 (America/Chicago)",
    );
  });

  test("handles UTC fallback when no timezone provided", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
    });
    expect(result).toBe("2026-04-02 (Thu) 06:52:33 +00:00 (UTC)");
  });

  test("handles user timezone override", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
      userTimeZone: "Asia/Tokyo",
    });
    expect(result).toBe("2026-04-02 (Thu) 15:52:33 +09:00 (Asia/Tokyo)");
  });

  test("handles DST correctly", () => {
    // Jul 1 12:00:30 UTC = Jul 1 08:00:30 EDT (Eastern Daylight Time, -04:00)
    const summerWithSeconds = Date.UTC(2026, 6, 1, 12, 0, 30);
    const result = formatTurnTimestamp({
      nowMs: summerWithSeconds,
      timeZone: "America/New_York",
    });
    expect(result).toBe(
      "2026-07-01 (Wed) 08:00:30 -04:00 (America/New_York)",
    );
  });

  test("formats midnight as 00", () => {
    // 2026-02-19 00:00:15 UTC
    const justAfterMidnight = Date.UTC(2026, 1, 19, 0, 0, 15);
    const result = formatTurnTimestamp({
      nowMs: justAfterMidnight,
      timeZone: "UTC",
    });
    expect(result).toContain("00:00:15");
    expect(result).not.toContain("24:");
  });
});
