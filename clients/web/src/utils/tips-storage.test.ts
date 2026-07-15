import { beforeEach, describe, expect, it } from "bun:test";

import {
  ensureTipsFirstSeenAt,
  recordTipDismissed,
  recordTipShown,
  tipRecordsStorage,
  tipsDemoCyclerStorage,
  tipsEnabledStorage,
  tipsFirstSeenAtStorage,
  tipsPlacementStorage,
} from "@/utils/tips-storage";

beforeEach(() => {
  localStorage.clear();
});

describe("tipRecordsStorage", () => {
  it("falls back to an empty record when nothing is stored", () => {
    expect(tipRecordsStorage.load()).toEqual({});
  });

  it("round-trips tip records", () => {
    const records = {
      "what-are-skills": { lastShownAt: 111, shownCount: 2 },
      "voice-mode": { dismissedAt: 222, lastShownAt: 200, shownCount: 1 },
    };
    tipRecordsStorage.save(records);
    expect(tipRecordsStorage.load()).toEqual(records);
  });

  it("falls back on malformed persisted values", () => {
    localStorage.setItem(tipRecordsStorage.key, "not json");
    expect(tipRecordsStorage.load()).toEqual({});

    localStorage.setItem(tipRecordsStorage.key, JSON.stringify([1, 2]));
    expect(tipRecordsStorage.load()).toEqual({});
  });

  it("drops malformed entries but keeps valid ones", () => {
    localStorage.setItem(
      tipRecordsStorage.key,
      JSON.stringify({
        good: { shownCount: 1, lastShownAt: 5 },
        badCount: { shownCount: "many" },
        badTimestamp: { shownCount: 1, dismissedAt: "yesterday" },
        notAnObject: 7,
      }),
    );
    expect(tipRecordsStorage.load()).toEqual({
      good: { shownCount: 1, lastShownAt: 5 },
    });
  });
});

describe("tipsEnabledStorage", () => {
  it("defaults to enabled and round-trips", () => {
    expect(tipsEnabledStorage.load()).toBe(true);
    tipsEnabledStorage.save(false);
    expect(tipsEnabledStorage.load()).toBe(false);
  });

  it("falls back to enabled on malformed values", () => {
    localStorage.setItem(tipsEnabledStorage.key, "yes");
    expect(tipsEnabledStorage.load()).toBe(true);
  });
});

describe("tipsDemoCyclerStorage", () => {
  it("defaults to off and round-trips", () => {
    expect(tipsDemoCyclerStorage.load()).toBe(false);
    tipsDemoCyclerStorage.save(true);
    expect(tipsDemoCyclerStorage.load()).toBe(true);
  });

  it("falls back to off on malformed values", () => {
    localStorage.setItem(tipsDemoCyclerStorage.key, "yes");
    expect(tipsDemoCyclerStorage.load()).toBe(false);
  });
});

describe("tipsPlacementStorage", () => {
  it("defaults to sidebar and round-trips every placement", () => {
    expect(tipsPlacementStorage.load()).toBe("sidebar");
    for (const placement of ["banner", "popover", "sidebar"] as const) {
      tipsPlacementStorage.save(placement);
      expect(tipsPlacementStorage.load()).toBe(placement);
    }
  });

  it("falls back to sidebar on invalid values", () => {
    localStorage.setItem(tipsPlacementStorage.key, "toast");
    expect(tipsPlacementStorage.load()).toBe("sidebar");

    localStorage.setItem(tipsPlacementStorage.key, "");
    expect(tipsPlacementStorage.load()).toBe("sidebar");
  });
});

describe("tipsFirstSeenAtStorage", () => {
  it("defaults to 0 and rejects malformed values", () => {
    expect(tipsFirstSeenAtStorage.load()).toBe(0);

    localStorage.setItem(tipsFirstSeenAtStorage.key, "not-a-number");
    expect(tipsFirstSeenAtStorage.load()).toBe(0);

    localStorage.setItem(tipsFirstSeenAtStorage.key, "-5");
    expect(tipsFirstSeenAtStorage.load()).toBe(0);
  });
});

describe("ensureTipsFirstSeenAt", () => {
  it("stamps once and is idempotent", () => {
    const before = Date.now();
    ensureTipsFirstSeenAt();
    const stamped = tipsFirstSeenAtStorage.load();
    expect(stamped).toBeGreaterThanOrEqual(before);

    ensureTipsFirstSeenAt();
    expect(tipsFirstSeenAtStorage.load()).toBe(stamped);
  });

  it("does not overwrite an existing stamp", () => {
    tipsFirstSeenAtStorage.save(123);
    ensureTipsFirstSeenAt();
    expect(tipsFirstSeenAtStorage.load()).toBe(123);
  });
});

describe("recordTipShown", () => {
  it("creates a record and bumps lastShownAt + shownCount", () => {
    recordTipShown("app-builder", 1_000);
    expect(tipRecordsStorage.load()["app-builder"]).toEqual({
      lastShownAt: 1_000,
      shownCount: 1,
    });

    recordTipShown("app-builder", 2_000);
    expect(tipRecordsStorage.load()["app-builder"]).toEqual({
      lastShownAt: 2_000,
      shownCount: 2,
    });
  });

  it("preserves a prior dismissal and other tips' records", () => {
    recordTipDismissed("memory-aware", 500);
    recordTipShown("app-builder", 1_000);
    recordTipShown("memory-aware", 2_000);

    expect(tipRecordsStorage.load()).toEqual({
      "app-builder": { lastShownAt: 1_000, shownCount: 1 },
      "memory-aware": { dismissedAt: 500, lastShownAt: 2_000, shownCount: 1 },
    });
  });
});

describe("recordTipDismissed", () => {
  it("stamps dismissedAt on an unseen tip with a zero shownCount", () => {
    recordTipDismissed("image-studio", 3_000);
    expect(tipRecordsStorage.load()["image-studio"]).toEqual({
      dismissedAt: 3_000,
      shownCount: 0,
    });
  });

  it("preserves lastShownAt and shownCount from prior showings", () => {
    recordTipShown("image-studio", 1_000);
    recordTipDismissed("image-studio", 3_000);
    expect(tipRecordsStorage.load()["image-studio"]).toEqual({
      dismissedAt: 3_000,
      lastShownAt: 1_000,
      shownCount: 1,
    });
  });
});
