import { describe, expect, test } from "bun:test";

import {
  extractUserTimeZoneFromRecall,
  formatTurnTimestamp,
} from "../daemon/date-context.js";

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
      "2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)",
    );
  });

  test("handles UTC fallback when no timezone provided", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
    });
    expect(result).toBe("2026-04-02 (Thursday) 06:52:33 +00:00 (UTC)");
  });

  test("handles user timezone override", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
      userTimeZone: "Asia/Tokyo",
    });
    expect(result).toBe("2026-04-02 (Thursday) 15:52:33 +09:00 (Asia/Tokyo)");
  });

  test("handles DST correctly", () => {
    // Jul 1 12:00:30 UTC = Jul 1 08:00:30 EDT (Eastern Daylight Time, -04:00)
    const summerWithSeconds = Date.UTC(2026, 6, 1, 12, 0, 30);
    const result = formatTurnTimestamp({
      nowMs: summerWithSeconds,
      timeZone: "America/New_York",
    });
    expect(result).toBe(
      "2026-07-01 (Wednesday) 08:00:30 -04:00 (America/New_York)",
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
