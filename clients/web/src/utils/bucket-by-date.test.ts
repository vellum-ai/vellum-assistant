import { describe, expect, test } from "bun:test";

import {
  bucketByDate,
  dateBucketIdFor,
  dateBucketKey,
  formatBucketedTime,
} from "@/utils/bucket-by-date";

/** Local wall-clock instant, so every case is expressed in the reader's zone. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): number {
  return new Date(year, month, day, hour, minute).getTime();
}

const NOW = new Date(2026, 8, 18, 14, 30);

function bucket(timestamps: number[], now: Date = NOW) {
  return bucketByDate(timestamps, (value) => value, now).map((b) => ({
    key: b.key,
    items: b.items,
  }));
}

describe("bucketByDate", () => {
  test("bands the four relative ranges newest first", () => {
    expect(
      bucket([
        at(2026, 8, 18, 9),
        at(2026, 8, 17, 23),
        at(2026, 8, 14),
        at(2026, 8, 1),
      ]),
    ).toEqual([
      { key: "today", items: [at(2026, 8, 18, 9)] },
      { key: "yesterday", items: [at(2026, 8, 17, 23)] },
      { key: "previous7Days", items: [at(2026, 8, 14)] },
      { key: "previous30Days", items: [at(2026, 8, 1)] },
    ]);
  });

  test("places anything at or after local midnight today in Today", () => {
    const midnight = new Date(2026, 8, 18).getTime();
    expect(bucket([midnight])).toEqual([{ key: "today", items: [midnight] }]);
  });

  test("places one millisecond before local midnight in Yesterday", () => {
    const lastMoment = new Date(2026, 8, 18).getTime() - 1;
    expect(bucket([lastMoment])).toEqual([
      { key: "yesterday", items: [lastMoment] },
    ]);
  });

  test("bands a future instant as Today rather than dropping it", () => {
    const soon = at(2026, 8, 19, 9);
    expect(bucket([soon])).toEqual([{ key: "today", items: [soon] }]);
  });

  test("falls to month bands past 30 days, newest month first", () => {
    const july = at(2026, 6, 20);
    const june = at(2026, 5, 2);
    const lastDecember = at(2025, 11, 31);
    expect(bucket([june, lastDecember, july])).toEqual([
      { key: "month:2026-6", items: [july] },
      { key: "month:2026-5", items: [june] },
      { key: "month:2025-11", items: [lastDecember] },
    ]);
  });

  test("keeps a month band separate from the relative band covering the same month", () => {
    /* Both instants are in August 2026; one falls inside the 30-day window
       and one does not, so they must not merge. */
    const inWindow = at(2026, 7, 25);
    const outsideWindow = at(2026, 7, 3);
    expect(bucket([inWindow, outsideWindow])).toEqual([
      { key: "previous30Days", items: [inWindow] },
      { key: "month:2026-7", items: [outsideWindow] },
    ]);
  });

  test("splits a calendar-month boundary into two month bands", () => {
    const now = new Date(2026, 3, 15, 8, 0);
    const februaryEnd = at(2026, 1, 28, 23, 59);
    const marchStart = at(2026, 2, 1, 0, 1);
    expect(bucket([marchStart, februaryEnd], now)).toEqual([
      { key: "month:2026-2", items: [marchStart] },
      { key: "month:2026-1", items: [februaryEnd] },
    ]);
  });

  test("keeps input order inside a band", () => {
    const first = at(2026, 8, 18, 13);
    const second = at(2026, 8, 18, 9);
    expect(bucket([first, second])).toEqual([
      { key: "today", items: [first, second] },
    ]);
  });

  test("drops items with no usable instant", () => {
    const rows = [{ at: 1 }, { at: null }, { at: undefined }, { at: NaN }];
    const bands = bucketByDate(rows, (row) => row.at, NOW);
    expect(bands).toHaveLength(1);
    expect(bands[0].items).toEqual([{ at: 1 }]);
  });

  test("returns no bands for an empty input", () => {
    expect(bucketByDate([], () => 0, NOW)).toEqual([]);
  });

  test("bands by local midnight across a spring-forward transition", () => {
    /* US spring-forward in 2026 is 8 March. A day is 23 hours long here, so
       a band computed by subtracting 86_400_000ms would end an hour off. */
    const now = new Date(2026, 2, 8, 12, 0);
    const beforeTransition = at(2026, 2, 7, 23, 30);
    const afterMidnight = at(2026, 2, 8, 0, 30);
    expect(bucket([afterMidnight, beforeTransition], now)).toEqual([
      { key: "today", items: [afterMidnight] },
      { key: "yesterday", items: [beforeTransition] },
    ]);
  });

  test("bands by local midnight across a fall-back transition", () => {
    const now = new Date(2026, 10, 1, 12, 0);
    const beforeTransition = at(2026, 9, 31, 23, 30);
    const afterMidnight = at(2026, 10, 1, 0, 30);
    expect(bucket([afterMidnight, beforeTransition], now)).toEqual([
      { key: "today", items: [afterMidnight] },
      { key: "yesterday", items: [beforeTransition] },
    ]);
  });
});

describe("formatBucketedTime", () => {
  const EN = "en-US";

  test("names a chat from today by its clock time", () => {
    expect(formatBucketedTime(at(2026, 8, 18, 9, 14), NOW, EN)).toBe("9:14 AM");
  });

  // The defect this replaced: a rounded relative duration reads "2 days ago"
  // for an instant the calendar bands put under Yesterday.
  test("names a chat from early yesterday by its clock time, not a duration", () => {
    const earlyYesterday = at(2026, 8, 17, 0, 30);
    expect(dateBucketIdFor(earlyYesterday, NOW).kind).toBe("yesterday");
    expect(formatBucketedTime(earlyYesterday, NOW, EN)).toBe("12:30 AM");
  });

  test("names an older chat in the current year by day and month", () => {
    expect(formatBucketedTime(at(2026, 8, 12, 16, 5), NOW, EN)).toBe("Sep 12");
  });

  test("adds the year once it differs from now's", () => {
    expect(formatBucketedTime(at(2025, 10, 3, 16, 5), NOW, EN)).toBe(
      "Nov 3, 2025",
    );
  });

  test("keeps a January instant in the current year without a year", () => {
    expect(formatBucketedTime(at(2026, 0, 6, 8, 0), NOW, EN)).toBe("Jan 6");
  });

  test("formats in the locale it is given", () => {
    expect(formatBucketedTime(at(2026, 8, 12, 16, 5), NOW, "es-ES")).toMatch(
      /12/,
    );
    expect(formatBucketedTime(at(2026, 8, 12, 16, 5), NOW, "es-ES")).not.toBe(
      "Sep 12",
    );
  });

  // Every band a row can sit under has to produce a label, and none of them
  // may produce a relative phrase.
  test("never produces a relative phrase, in any band", () => {
    const samples = [
      at(2026, 8, 18, 9),
      at(2026, 8, 17, 9),
      at(2026, 8, 14, 9),
      at(2026, 8, 1, 9),
      at(2026, 6, 20, 9),
      at(2025, 11, 31, 9),
    ];
    for (const sample of samples) {
      const label = formatBucketedTime(sample, NOW, EN);
      expect(label).not.toMatch(/ago|yesterday|now|day/i);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("dateBucketIdFor", () => {
  test("answers the same band bucketByDate files an item into", () => {
    const sample = at(2026, 8, 14);
    expect(dateBucketKey(dateBucketIdFor(sample, NOW))).toBe(
      bucketByDate([sample], (value) => value, NOW)[0].key,
    );
  });
});

describe("dateBucketKey", () => {
  test("names a month band by its year and zero-indexed month", () => {
    expect(dateBucketKey({ kind: "month", year: 2026, month: 7 })).toBe(
      "month:2026-7",
    );
  });

  test("names a relative band by its kind", () => {
    expect(dateBucketKey({ kind: "previous7Days" })).toBe("previous7Days");
  });
});
