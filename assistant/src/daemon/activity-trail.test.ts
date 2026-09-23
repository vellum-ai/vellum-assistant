/**
 * Tests for the daemon activity trail. A block report asks "what overlapped
 * the last N ms", so the trail must include work still running, include work
 * that ended inside the window, exclude work that ended before it, and group
 * identical labels so the report stays small.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { InterfaceId } from "../channels/types.js";
import {
  getActivityOverlapping,
  resetActivityTrailForTests,
  trackDaemonActivity,
  turnActivityLabel,
  turnConversationType,
} from "./activity-trail.js";

/** Resolves after `ms` of wall time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetActivityTrailForTests();
});

describe("getActivityOverlapping", () => {
  test("reports running work and work that ended inside the window", async () => {
    // GIVEN a background turn that has ended and a user turn still running
    await trackDaemonActivity({ kind: "schedule_tick" }, async () => {});
    let release!: () => void;
    const userTurn = trackDaemonActivity(
      {
        kind: "turn",
        conversationType: "standard",
        callSite: "mainAgent",
        turnInterface: "web",
        interactive: true,
      },
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    // WHEN the last minute is queried
    const groups = getActivityOverlapping(60_000);

    // THEN both appear, the user turn marked as running
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(
      expect.objectContaining({ kind: "schedule_tick", count: 1, running: 0 }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: "turn",
        turnInterface: "web",
        interactive: true,
        running: 1,
      }),
    );
    release();
    await userTurn;
  });

  test("excludes work that ended before the window began", async () => {
    // GIVEN work that ended ~50ms ago
    await trackDaemonActivity({ kind: "git_compaction" }, async () => {});
    await sleep(50);

    // WHEN only the last 10ms are queried
    const groups = getActivityOverlapping(10);

    // THEN it is not attributed to the window
    expect(groups).toEqual([]);
  });

  test("groups identical labels and keeps the longest duration", async () => {
    // GIVEN three heartbeat turns, one noticeably longer
    const heartbeat = {
      kind: "turn" as const,
      conversationType: "background" as const,
      callSite: "heartbeatAgent" as const,
      interactive: false,
    };
    await trackDaemonActivity(heartbeat, async () => {});
    await trackDaemonActivity(heartbeat, () => sleep(30));
    await trackDaemonActivity(heartbeat, async () => {});

    // WHEN the window covers all three
    const groups = getActivityOverlapping(60_000);

    // THEN they collapse into one group
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ ...heartbeat, count: 3, running: 0 });
    expect(groups[0]!.longestMs).toBeGreaterThanOrEqual(25);
  });

  test("a failing job still closes its mark", async () => {
    // GIVEN tracked work that throws
    await expect(
      trackDaemonActivity({ kind: "vbundle_export" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // WHEN the trail is queried
    const groups = getActivityOverlapping(60_000);

    // THEN the work is recorded as ended, not left running forever
    expect(groups).toEqual([
      expect.objectContaining({ kind: "vbundle_export", running: 0 }),
    ]);
  });
});

describe("burst retention", () => {
  test("a burst of finished work does not evict what overlapped a block", async () => {
    // GIVEN a user turn that ends, then a burst of 500 short jobs
    await trackDaemonActivity(
      { kind: "turn", conversationType: "standard", callSite: "mainAgent" },
      async () => {},
    );
    for (let i = 0; i < 500; i++) {
      await trackDaemonActivity({ kind: "schedule_tick" }, async () => {});
    }

    // WHEN the last minute is queried
    const groups = getActivityOverlapping(60_000);

    // THEN the earlier turn is still attributed
    expect(groups).toContainEqual(
      expect.objectContaining({ kind: "turn", count: 1 }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({ kind: "schedule_tick", count: 500 }),
    );
  });
});

describe("turnActivityLabel", () => {
  function conversation(opts: {
    isSubagent?: boolean;
    originInterface?: InterfaceId;
    liveInterface?: InterfaceId;
  }) {
    return {
      conversationType: "standard",
      isSubagent: opts.isSubagent ?? false,
      originInterface: opts.originInterface,
      getTurnInterfaceContext: () =>
        opts.liveInterface
          ? { userMessageInterface: opts.liveInterface }
          : null,
    };
  }

  test("a subagent turn without an explicit call site is a subagent turn", () => {
    // GIVEN a subagent conversation and a queue-drained turn with no call site
    // WHEN its label is built
    const label = turnActivityLabel(
      conversation({ isSubagent: true }),
      undefined,
      false,
    );
    // THEN it matches the call site the loop resolves, not mainAgent
    expect(label.callSite).toBe("subagentSpawn");
  });

  test("an explicit call site wins", () => {
    const label = turnActivityLabel(conversation({}), "heartbeatAgent", false);
    expect(label.callSite).toBe("heartbeatAgent");
  });

  test("the turn's own interface wins over the conversation's origin", () => {
    // GIVEN a conversation started on web, now continued from Slack
    // WHEN the Slack turn's label is built
    const label = turnActivityLabel(
      conversation({ originInterface: "web", liveInterface: "slack" }),
      undefined,
      true,
    );
    // THEN it is attributed to Slack
    expect(label.turnInterface).toBe("slack");
    expect(label.interactive).toBe(true);
  });

  test("falls back to the origin interface, and omits it when unknown", () => {
    expect(
      turnActivityLabel(
        conversation({ originInterface: "macos" }),
        undefined,
        false,
      ).turnInterface,
    ).toBe("macos");
    expect(
      turnActivityLabel(conversation({}), undefined, false),
    ).not.toHaveProperty("turnInterface");
  });
});

describe("turnConversationType", () => {
  test("keeps known types, defaults a missing one, and buckets the rest", () => {
    expect(turnConversationType("background")).toBe("background");
    expect(turnConversationType("scheduled")).toBe("scheduled");
    expect(turnConversationType(undefined)).toBe("standard");
    expect(turnConversationType("something-new")).toBe("other");
  });
});
