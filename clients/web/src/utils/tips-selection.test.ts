import { describe, expect, it } from "bun:test";

import type { Tip } from "@/utils/tips-catalog";
import type { TipRecord } from "@/utils/tips-storage";
import {
  isTipEligible,
  selectCurrentTip,
  TIP_ROTATION_INTERVAL_MS,
} from "@/utils/tips-selection";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY;

function tip(id: string): Tip {
  return {
    id,
    kind: "info",
    source: "curated",
    eyebrow: "Tips",
    title: `title of ${id}`,
    body: `body of ${id}`,
  };
}

const catalog: readonly Tip[] = [tip("one"), tip("two"), tip("three")];

describe("isTipEligible", () => {
  it("treats a missing record as eligible", () => {
    expect(isTipEligible(tip("one"), undefined, NOW)).toBe(true);
  });

  it("treats an undismissed record as eligible regardless of showings", () => {
    expect(
      isTipEligible(tip("one"), { lastShownAt: NOW - 2 * DAY, shownCount: 3 }, NOW),
    ).toBe(true);
  });

  it("never re-admits a dismissed tip", () => {
    expect(
      isTipEligible(tip("one"), { dismissedAt: NOW - 100 * DAY, shownCount: 1 }, NOW),
    ).toBe(false);
  });
});

describe("selectCurrentTip", () => {
  it("shows the first tip in catalog order to a fresh user", () => {
    expect(selectCurrentTip(catalog, {}, NOW)?.id).toBe("one");
  });

  it("keeps the same tip for the rest of its rotation window", () => {
    const records = {
      one: { lastShownAt: NOW - TIP_ROTATION_INTERVAL_MS + 1, shownCount: 1 },
    };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("one");
  });

  it("re-selects an undismissed tip once its window has elapsed", () => {
    const records = { one: { lastShownAt: NOW - DAY - 1, shownCount: 1 } };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("one");
  });

  it("shows nothing for the rest of the window after a dismissal", () => {
    const records = {
      one: { dismissedAt: NOW - 1, lastShownAt: NOW - 60_000, shownCount: 1 },
    };
    expect(selectCurrentTip(catalog, records, NOW)).toBeNull();
  });

  it("advances to the next tip on the next window after a dismissal", () => {
    const records = {
      one: { dismissedAt: NOW - DAY - 1, lastShownAt: NOW - DAY - 1, shownCount: 1 },
    };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("two");
  });

  it("enforces at most one tip per window across different tips", () => {
    // Tip two was shown then dismissed within the current window; tip one was
    // dismissed long ago. Nothing shows until the window elapses.
    const records = {
      one: { dismissedAt: NOW - 5 * DAY, lastShownAt: NOW - 5 * DAY, shownCount: 1 },
      two: { dismissedAt: NOW - 1, lastShownAt: NOW - 60_000, shownCount: 1 },
    };
    expect(selectCurrentTip(catalog, records, NOW)).toBeNull();
    expect(
      selectCurrentTip(catalog, records, NOW + TIP_ROTATION_INTERVAL_MS)?.id,
    ).toBe("three");
  });

  it("advances immediately past a tip dismissed without ever being shown", () => {
    const records = { one: { dismissedAt: NOW - 1, shownCount: 0 } };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("two");
  });

  it("returns null forever once every tip is dismissed", () => {
    const records: Record<string, TipRecord> = {};
    for (const entry of catalog) {
      records[entry.id] = { dismissedAt: NOW - 30 * DAY, shownCount: 1 };
    }
    expect(selectCurrentTip(catalog, records, NOW)).toBeNull();
    expect(selectCurrentTip(catalog, records, NOW + 365 * DAY)).toBeNull();
  });

  it("treats partial records with no lastShownAt as unseen", () => {
    const records = { one: { shownCount: 2 } };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("one");
  });

  it("ignores records for tips no longer in the catalog", () => {
    const records = { retired: { dismissedAt: NOW - 5 * DAY, shownCount: 1 } };
    expect(selectCurrentTip(catalog, records, NOW)?.id).toBe("one");
  });

  it("holds the window even when the current tip's record id left the catalog", () => {
    // A stale record shown within the window still counts toward ≤1 tip/window.
    const records = { retired: { lastShownAt: NOW - 60_000, shownCount: 1 } };
    expect(selectCurrentTip(catalog, records, NOW)).toBeNull();
  });

  it("returns null for an empty catalog", () => {
    expect(selectCurrentTip([], {}, NOW)).toBeNull();
  });
});
