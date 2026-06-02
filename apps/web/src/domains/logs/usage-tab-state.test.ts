import { describe, expect, test } from "bun:test";

import { toTimezoneDateString } from "@/components/charts/format-date-label";
import { resolveRangeWindow } from "@/domains/logs/usage-tab-state";

const UTC = "UTC";

describe("resolveRangeWindow", () => {
  test("'all' returns from=0 and to=now regardless of tz", () => {
    const now = Date.UTC(2026, 5, 2, 12, 0, 0);
    expect(resolveRangeWindow("all", "America/New_York", now)).toEqual({
      from: 0,
      to: now,
    });
  });

  test("'to' is the current instant; 'today' from is zone-local midnight", () => {
    const now = Date.UTC(2026, 5, 2, 18, 30, 0);
    const { from, to } = resolveRangeWindow("today", UTC, now);
    expect(to).toBe(now);
    // UTC midnight of 2026-06-02
    expect(from).toBe(Date.UTC(2026, 5, 2, 0, 0, 0));
  });

  test("'7d' from is six zone-local days before today (UTC)", () => {
    const now = Date.UTC(2026, 5, 2, 18, 30, 0);
    const { from } = resolveRangeWindow("7d", UTC, now);
    expect(from).toBe(Date.UTC(2026, 4, 27, 0, 0, 0));
  });

  test("day boundaries are computed in the supplied tz", () => {
    // An instant where the calendar day differs across far-apart zones.
    // 2026-06-02T01:00:00Z: UTC+14 (Kiritimati) is already 2026-06-02 15:00,
    // while UTC-11 (Niue) is still 2026-06-01 14:00.
    const now = Date.UTC(2026, 5, 2, 1, 0, 0);

    const east = resolveRangeWindow("today", "Pacific/Kiritimati", now);
    const west = resolveRangeWindow("today", "Pacific/Niue", now);

    // Different calendar "today" => different from-boundaries.
    expect(east.from).not.toBe(west.from);

    // Sanity-check the actual calendar dates the boundaries land on.
    expect(toTimezoneDateString(new Date(east.from), "Pacific/Kiritimati")).toBe(
      "2026-06-02",
    );
    expect(toTimezoneDateString(new Date(west.from), "Pacific/Niue")).toBe(
      "2026-06-01",
    );
  });

  test("from epoch maps back to zone-local midnight (DST-safe)", () => {
    // US DST is in effect in June; verify the from-boundary is local midnight.
    const now = Date.UTC(2026, 5, 2, 18, 0, 0);
    const tz = "America/New_York";
    const { from } = resolveRangeWindow("7d", tz, now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(from));
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    expect(`${hour}:${minute}`).toBe("00:00");
  });
});
