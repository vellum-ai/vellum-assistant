import { describe, expect, test } from "bun:test";

import { UiConfigSchema } from "../config/schemas/platform.js";
import {
  canonicalizeTimeZone,
  extractUserTimeZoneFromRecall,
  formatTurnTimestamp,
  resolveTurnTimezoneContext,
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
// UiConfigSchema timezone fields
// ---------------------------------------------------------------------------

describe("UiConfigSchema timezone fields", () => {
  test("accepts canonicalizable IANA timezone identifiers", () => {
    const result = UiConfigSchema.parse({
      userTimezone: "america/new_york",
      detectedTimezone: "america/los_angeles",
    });

    expect(result.userTimezone).toBe("America/New_York");
    expect(result.detectedTimezone).toBe("America/Los_Angeles");
    expect(UiConfigSchema.parse({ userTimezone: "UTC" }).userTimezone).toBe(
      "UTC",
    );
  });

  test("accepts empty-string clearing sentinels", () => {
    const result = UiConfigSchema.parse({
      userTimezone: "",
      detectedTimezone: "",
    });

    expect(result.userTimezone).toBe("");
    expect(result.detectedTimezone).toBe("");
  });

  test("rejects invalid non-empty userTimezone and detectedTimezone values", () => {
    expect(() =>
      UiConfigSchema.parse({ userTimezone: "not-a-timezone" }),
    ).toThrow("ui.userTimezone must be a valid IANA timezone identifier");
    expect(() =>
      UiConfigSchema.parse({ detectedTimezone: "Mars/Olympus_Mons" }),
    ).toThrow("ui.detectedTimezone must be a valid IANA timezone identifier");
    expect(() => UiConfigSchema.parse({ userTimezone: "+05:30" })).toThrow(
      "ui.userTimezone must be a valid IANA timezone identifier",
    );
  });

  test("rejects ambiguous abbreviations and offset strings", () => {
    for (const value of ["EST", "PST", "UTC+5:30", "GMT-0800", "+05:30"]) {
      expect(() => UiConfigSchema.parse({ userTimezone: value })).toThrow(
        "ui.userTimezone must be a valid IANA timezone identifier",
      );
      expect(() => UiConfigSchema.parse({ detectedTimezone: value })).toThrow(
        "ui.detectedTimezone must be a valid IANA timezone identifier",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// canonicalizeTimeZone
// ---------------------------------------------------------------------------

describe("canonicalizeTimeZone", () => {
  test("returns canonical timezone identifiers and ignores empty values", () => {
    expect(canonicalizeTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalizeTimeZone("")).toBeNull();
    expect(canonicalizeTimeZone(null)).toBeNull();
    expect(canonicalizeTimeZone("not-a-timezone")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTurnTimezoneContext
// ---------------------------------------------------------------------------

describe("resolveTurnTimezoneContext", () => {
  test("prefers configured user timezone over automatic sources", () => {
    const context = resolveTurnTimezoneContext({
      configuredUserTimeZone: "America/New_York",
      clientTimezone: "America/Chicago",
      detectedTimezone: "Asia/Tokyo",
      hostTimeZone: "Europe/London",
    });

    expect(context.effectiveTimezone).toBe("America/New_York");
    expect(context.source).toBe("configuredUserTimezone");
  });

  test("prefers client timezone over detected and host timezones", () => {
    const context = resolveTurnTimezoneContext({
      clientTimezone: "America/Chicago",
      detectedTimezone: "Asia/Tokyo",
      hostTimeZone: "Europe/London",
    });

    expect(context.effectiveTimezone).toBe("America/Chicago");
    expect(context.source).toBe("clientTimezone");
  });

  test("prefers detected timezone over host timezone", () => {
    const context = resolveTurnTimezoneContext({
      detectedTimezone: "Asia/Tokyo",
      hostTimeZone: "Europe/London",
    });

    expect(context.effectiveTimezone).toBe("Asia/Tokyo");
    expect(context.source).toBe("detectedTimezone");
  });

  test("uses host timezone before UTC fallback", () => {
    const context = resolveTurnTimezoneContext({
      hostTimeZone: "Europe/London",
    });

    expect(context.effectiveTimezone).toBe("Europe/London");
    expect(context.source).toBe("hostTimezone");
  });

  test("falls back to UTC when no timezone resolves", () => {
    const context = resolveTurnTimezoneContext({
      configuredUserTimeZone: "not-a-timezone",
      clientTimezone: "also-invalid",
      detectedTimezone: "",
      hostTimeZone: "still-invalid",
    });

    expect(context.effectiveTimezone).toBe("UTC");
    expect(context.source).toBe("utcFallback");
  });

  test("ignores empty strings during runtime resolution", () => {
    const context = resolveTurnTimezoneContext({
      configuredUserTimeZone: "",
      clientTimezone: "",
      detectedTimezone: "",
      hostTimeZone: "UTC",
    });

    expect(context.configuredUserTimezone).toBeNull();
    expect(context.clientTimezone).toBeNull();
    expect(context.detectedTimezone).toBeNull();
    expect(context.effectiveTimezone).toBe("UTC");
    expect(context.source).toBe("hostTimezone");
  });

  test("does not use recalled profile timezone in normal turn precedence", () => {
    const context = resolveTurnTimezoneContext({
      userTimeZone: "Asia/Tokyo",
      hostTimeZone: "UTC",
    });

    expect(context.effectiveTimezone).toBe("UTC");
    expect(context.source).toBe("hostTimezone");
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

  test("handles configured user timezone override", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
      configuredUserTimeZone: "Asia/Tokyo",
    });
    expect(result).toBe("2026-04-02 (Thursday) 15:52:33 +09:00 (Asia/Tokyo)");
  });

  test("uses client timezone when no configured override exists", () => {
    const result = formatTurnTimestamp({
      nowMs: THU_APR_02_0652,
      hostTimeZone: "UTC",
      clientTimezone: "Asia/Tokyo",
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
