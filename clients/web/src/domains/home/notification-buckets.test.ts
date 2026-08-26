import { describe, expect, test } from "bun:test";

import type { FeedItem } from "@vellumai/assistant-api";

import {
  clearableActivityIds,
  formatRunElapsed,
  groupIntoSections,
  isRunInFlight,
  isRunQuiet,
  resolveBucket,
  unreadIds,
} from "./notification-buckets";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  const iso = new Date(NOW).toISOString();
  return {
    id: "notif:1",
    type: "notification",
    priority: 60,
    summary: "Something happened.",
    timestamp: iso,
    createdAt: iso,
    status: "seen",
    ...overrides,
  };
}

function runItem(
  id: string,
  state: NonNullable<FeedItem["run"]>["state"],
  overrides: Partial<FeedItem> = {},
): FeedItem {
  const iso = new Date(NOW).toISOString();
  return item({
    id,
    type: "run",
    bucket: "activity",
    run: { runId: id, kind: "subagent", state, startedAt: iso },
    ...overrides,
  });
}

describe("resolveBucket", () => {
  test("uses the bucket the daemon wrote", () => {
    expect(resolveBucket(item({ bucket: "needs_you" }))).toBe("needs_you");
  });

  test("reads a pre-bucket row from what it does carry", () => {
    // `noteworthy` was the inbox-versus-activity split before buckets existed.
    expect(resolveBucket(item({ noteworthy: true }))).toBe("worth_knowing");
    expect(resolveBucket(item({ noteworthy: false }))).toBe("activity");
  });

  test("a pre-bucket row with something to answer is blocked on the user", () => {
    expect(
      resolveBucket(
        item({ actions: [{ id: "a", label: "Approve", prompt: "yes" }] }),
      ),
    ).toBe("needs_you");
    expect(
      resolveBucket(item({ detailPanel: { kind: "permissionChat" } })),
    ).toBe("needs_you");
  });
});

describe("groupIntoSections", () => {
  test("orders the sections most important first", () => {
    const sections = groupIntoSections([
      item({ id: "c", bucket: "activity" }),
      item({ id: "a", bucket: "needs_you" }),
      item({ id: "b", bucket: "worth_knowing" }),
    ]);

    expect(sections.map((section) => section.bucket)).toEqual([
      "needs_you",
      "worth_knowing",
      "activity",
    ]);
  });

  test("drops empty sections", () => {
    // A permanent "Needs you (0)" header is a standing reminder of nothing.
    const sections = groupIntoSections([item({ bucket: "activity" })]);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.bucket).toBe("activity");
  });

  test("puts live runs at the top of Activity and the digest at the bottom", () => {
    const older = new Date(NOW - 60_000).toISOString();
    const sections = groupIntoSections([
      item({ id: "digest:runs", type: "digest", bucket: "activity" }),
      item({ id: "notif:x", bucket: "activity", timestamp: older }),
      runItem("run:live", "running"),
    ]);

    expect(sections[0]!.items.map((i) => i.id)).toEqual([
      "run:live",
      "notif:x",
      "digest:runs",
    ]);
  });

  test("counts the live runs in a section", () => {
    const sections = groupIntoSections([
      runItem("run:a", "running"),
      runItem("run:b", "queued"),
      runItem("run:c", "succeeded"),
    ]);

    expect(sections[0]!.runningCount).toBe(2);
  });

  test("sorts newest first inside a section", () => {
    const older = new Date(NOW - 60_000).toISOString();
    const sections = groupIntoSections([
      item({ id: "old", bucket: "worth_knowing", timestamp: older }),
      item({ id: "new", bucket: "worth_knowing" }),
    ]);

    expect(sections[0]!.items.map((i) => i.id)).toEqual(["new", "old"]);
  });
});

describe("isRunInFlight", () => {
  test.each(["queued", "running", "needs_input"] as const)(
    "%s is still being driven",
    (state) => {
      expect(isRunInFlight(runItem("r", state))).toBe(true);
    },
  );

  test.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
    "%s is not",
    (state) => {
      expect(isRunInFlight(runItem("r", state))).toBe(false);
    },
  );

  test("an ordinary notification is never in flight", () => {
    expect(isRunInFlight(item())).toBe(false);
  });
});

describe("isRunQuiet", () => {
  test("a run with nothing to say for half an hour reads as stalled", () => {
    const stale = runItem("r", "running", {
      timestamp: new Date(NOW - 31 * 60_000).toISOString(),
    });

    expect(isRunQuiet(stale, NOW)).toBe(true);
  });

  test("a run that just reported is not quiet", () => {
    expect(isRunQuiet(runItem("r", "running"), NOW)).toBe(false);
  });

  test("a finished run is never quiet, however long ago it ended", () => {
    const old = runItem("r", "succeeded", {
      timestamp: new Date(NOW - 10 * 60 * 60_000).toISOString(),
    });

    expect(isRunQuiet(old, NOW)).toBe(false);
  });
});

describe("formatRunElapsed", () => {
  test("reads m:ss under an hour", () => {
    expect(
      formatRunElapsed(new Date(NOW - 72_000).toISOString(), NOW),
    ).toBe("1:12");
  });

  test("reads h:mm:ss over one", () => {
    expect(
      formatRunElapsed(new Date(NOW - 3_723_000).toISOString(), NOW),
    ).toBe("1:02:03");
  });

  test("never goes negative on a clock that ran backwards", () => {
    expect(formatRunElapsed(new Date(NOW + 5_000).toISOString(), NOW)).toBe(
      "0:00",
    );
  });

  test("says nothing for an unparseable start", () => {
    expect(formatRunElapsed("not a date", NOW)).toBe("");
  });
});

describe("clearableActivityIds", () => {
  test("covers the Activity section only", () => {
    const sections = groupIntoSections([
      item({ id: "approval", bucket: "needs_you" }),
      item({ id: "outcome", bucket: "worth_knowing" }),
      item({ id: "routine", bucket: "activity" }),
    ]);

    expect(clearableActivityIds(sections)).toEqual(["routine"]);
  });

  test("leaves live runs alone", () => {
    // Dismissing a row for work that is still going would just have it
    // reappear on the next update.
    const sections = groupIntoSections([
      runItem("run:live", "running"),
      runItem("run:done", "succeeded"),
    ]);

    expect(clearableActivityIds(sections)).toEqual(["run:done"]);
  });

  test("is empty when there is no Activity section", () => {
    const sections = groupIntoSections([item({ bucket: "needs_you" })]);

    expect(clearableActivityIds(sections)).toEqual([]);
  });
});

describe("unreadIds", () => {
  test("spans every section", () => {
    const sections = groupIntoSections([
      item({ id: "a", bucket: "needs_you", status: "new" }),
      item({ id: "b", bucket: "activity", status: "new" }),
      item({ id: "c", bucket: "activity", status: "seen" }),
    ]);

    expect(new Set(unreadIds(sections))).toEqual(new Set(["a", "b"]));
  });
});
