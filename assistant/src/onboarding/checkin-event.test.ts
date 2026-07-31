import { describe, expect, test } from "bun:test";

import {
  buildCheckinDescription,
  buildCheckinTitle,
  type BusyInterval,
  checkinAvailabilityWindow,
  chooseCheckinSlot,
  extractBusyFromEvents,
  findFirstOpenSlot,
  type GcalEvent,
  tomorrowInTimeZone,
  zonedWallTimeToUtcMs,
} from "./checkin-event.js";

const TZ = "America/New_York";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// A fixed "now": 2024-01-15 18:00 UTC (= 1pm EST). Tomorrow is 2024-01-16.
const NOW = Date.parse("2024-01-15T18:00:00Z");

/** Helper: epoch ms for tomorrow (2024-01-16) at a given EST hour. */
function estTomorrow(hour: number, minute = 0): number {
  return zonedWallTimeToUtcMs(2024, 1, 16, hour, minute, TZ);
}

describe("buildCheckinTitle", () => {
  test("both names", () => {
    expect(
      buildCheckinTitle({ userName: "Alex", assistantName: "Jarvis" }),
    ).toBe("Alex <> Jarvis: Day 2 Check-in");
  });
  test("user only", () => {
    expect(buildCheckinTitle({ userName: "Alex" })).toBe(
      "Alex: Day 2 Check-in",
    );
  });
  test("assistant only", () => {
    expect(buildCheckinTitle({ assistantName: "Jarvis" })).toBe(
      "Jarvis: Day 2 Check-in",
    );
  });
  test("neither (blank strings dropped)", () => {
    expect(buildCheckinTitle({ userName: "  ", assistantName: "" })).toBe(
      "Day 2 Check-in",
    );
  });
});

describe("buildCheckinDescription", () => {
  test("embeds the uuid + fixed first-week prompt in the CTA link", () => {
    const html = buildCheckinDescription("uuid-123");
    expect(html).toContain(
      "https://www.vellum.ai/assistant/conversations/uuid-123?prompt=What%20would%20you%20recommend",
    );
    // Carries the app-owned attribution param (not a marketing `utm_*`, which
    // the marketing-site capture never sees on `/assistant/*` routes) so the web
    // app can emit the research-onboarding check-in funnel step on landing.
    expect(html).toContain("&vref=research_checkin");
    expect(html).not.toContain("utm_");
    // Only sanitization-safe tags; the CTA is a bold link, not a styled button.
    expect(html).toContain("<a href=");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("style=");
  });
});

describe("findFirstOpenSlot", () => {
  const windowStart = 0;
  const windowEnd = 60 * MIN;
  const dur = 15 * MIN;

  test("empty calendar → start of window", () => {
    expect(findFirstOpenSlot(windowStart, windowEnd, [], dur)).toBe(
      windowStart,
    );
  });

  test("busy at start → first gap after it", () => {
    const busy: BusyInterval[] = [{ start: 0, end: 20 * MIN }];
    expect(findFirstOpenSlot(windowStart, windowEnd, busy, dur)).toBe(20 * MIN);
  });

  test("finds a gap between two meetings", () => {
    const busy: BusyInterval[] = [
      { start: 0, end: 10 * MIN },
      { start: 30 * MIN, end: 60 * MIN },
    ];
    // gap [10,30) is 20min >= 15min → slot at 10min.
    expect(findFirstOpenSlot(windowStart, windowEnd, busy, dur)).toBe(10 * MIN);
  });

  test("skips a gap too small to fit", () => {
    const busy: BusyInterval[] = [
      { start: 0, end: 10 * MIN },
      { start: 20 * MIN, end: 60 * MIN }, // gap [10,20) only 10min
    ];
    expect(findFirstOpenSlot(windowStart, windowEnd, busy, dur)).toBeNull();
  });

  test("fully booked → null", () => {
    const busy: BusyInterval[] = [{ start: -MIN, end: windowEnd + MIN }];
    expect(findFirstOpenSlot(windowStart, windowEnd, busy, dur)).toBeNull();
  });

  test("ignores out-of-window busy intervals", () => {
    const busy: BusyInterval[] = [{ start: -2 * HOUR, end: -HOUR }];
    expect(findFirstOpenSlot(windowStart, windowEnd, busy, dur)).toBe(
      windowStart,
    );
  });
});

describe("tomorrowInTimeZone", () => {
  test("advances to the next local calendar day", () => {
    expect(tomorrowInTimeZone(NOW, TZ)).toEqual({
      year: 2024,
      month: 1,
      day: 16,
    });
  });

  test("late-evening local time still maps to the correct next day", () => {
    // 2024-01-16 02:00 UTC = 2024-01-15 21:00 EST → tomorrow is the 16th.
    const lateLocal = Date.parse("2024-01-16T02:00:00Z");
    expect(tomorrowInTimeZone(lateLocal, TZ)).toEqual({
      year: 2024,
      month: 1,
      day: 16,
    });
  });
});

describe("chooseCheckinSlot", () => {
  test("empty calendar → 12:00 (start of primary window)", () => {
    const slot = chooseCheckinSlot(NOW, TZ, []);
    expect(slot.window).toBe("primary");
    expect(slot.startMs).toBe(estTomorrow(12));
    expect(slot.endMs).toBe(estTomorrow(12, 15));
  });

  test("noon booked → next open slot inside the primary window", () => {
    const busy: BusyInterval[] = [
      { start: estTomorrow(12), end: estTomorrow(13) },
    ];
    const slot = chooseCheckinSlot(NOW, TZ, busy);
    expect(slot.window).toBe("primary");
    expect(slot.startMs).toBe(estTomorrow(13));
  });

  test("primary window full → widens to 8am–8pm and takes earliest slot", () => {
    // Block all of 12pm–5pm; leave the morning open.
    const busy: BusyInterval[] = [
      { start: estTomorrow(12), end: estTomorrow(17) },
    ];
    const slot = chooseCheckinSlot(NOW, TZ, busy);
    expect(slot.window).toBe("wide");
    // Earliest free slot in 8am–8pm is 8:00am.
    expect(slot.startMs).toBe(estTomorrow(8));
  });

  test("entire 8am–8pm full → fallback books at noon anyway", () => {
    const busy: BusyInterval[] = [
      { start: estTomorrow(8), end: estTomorrow(20) },
    ];
    const slot = chooseCheckinSlot(NOW, TZ, busy);
    expect(slot.window).toBe("fallback");
    expect(slot.startMs).toBe(estTomorrow(12));
  });
});

describe("extractBusyFromEvents", () => {
  const a = "2024-01-16T13:00:00Z";
  const b = "2024-01-16T13:30:00Z";

  test("timed event → busy interval", () => {
    const events: GcalEvent[] = [
      { start: { dateTime: a }, end: { dateTime: b } },
    ];
    expect(extractBusyFromEvents(events)).toEqual([
      { start: Date.parse(a), end: Date.parse(b) },
    ]);
  });

  test("skips cancelled, transparent, all-day, and declined events", () => {
    const events: GcalEvent[] = [
      { status: "cancelled", start: { dateTime: a }, end: { dateTime: b } },
      {
        transparency: "transparent",
        start: { dateTime: a },
        end: { dateTime: b },
      },
      { start: { date: "2024-01-16" }, end: { date: "2024-01-17" } },
      {
        start: { dateTime: a },
        end: { dateTime: b },
        attendees: [{ self: true, responseStatus: "declined" }],
      },
    ];
    expect(extractBusyFromEvents(events)).toEqual([]);
  });

  test("keeps an accepted event even with another attendee declined", () => {
    const events: GcalEvent[] = [
      {
        start: { dateTime: a },
        end: { dateTime: b },
        attendees: [
          { self: true, responseStatus: "accepted" },
          { responseStatus: "declined" },
        ],
      },
    ];
    expect(extractBusyFromEvents(events)).toHaveLength(1);
  });
});

describe("checkinAvailabilityWindow", () => {
  test("spans the full 8am–8pm fallback window tomorrow", () => {
    const { timeMinMs, timeMaxMs } = checkinAvailabilityWindow(NOW, TZ);
    expect(timeMinMs).toBe(estTomorrow(8));
    expect(timeMaxMs).toBe(estTomorrow(20));
  });
});
