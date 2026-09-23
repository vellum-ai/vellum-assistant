/**
 * Tests for the event-loop block watchdog.
 *
 * - `evaluateTick` must derive the blocked duration as elapsed-beyond-interval
 *   and apply the threshold inclusively, clamping early/normal ticks to zero so
 *   a healthy loop never reports.
 * - `start`/`stop` must be idempotent and safe to call in any order so daemon
 *   startup and the two shutdown paths can call them unconditionally.
 * - `buildBlockTelemetryDetail` must never send conversation titles and must
 *   always fit the server's detail byte cap, since an oversize bag drops the
 *   whole report.
 */
import { describe, expect, test } from "bun:test";

import type { StallCapture } from "../monitoring/stall-capture.js";
import type { SectionTrailEntry } from "../persistence/slow-sync-log.js";
import type { DaemonActivityGroup } from "./activity-trail.js";

const {
  buildBlockTelemetryDetail,
  detailFitsServerCap,
  evaluateTick,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
} = await import("./event-loop-watchdog.js");

function captureWith(conversationCount: number): StallCapture {
  return {
    ts: 1,
    daemonPid: 1,
    heartbeatAgeMs: 21_000,
    kernelStack: "[<0>] do_epoll_wait+0x4a0/0x4e0\n".repeat(12),
    processState: "S",
    waitState: {
      syscall: 232,
      epoll: {
        fd: 7,
        watched: 1,
        listeningSockets: 0,
        sockets: 0,
        pipes: 1,
        eventfds: 0,
        timerfds: 0,
        other: 0,
      },
      children: [{ pid: 200, comm: "git", state: "R", ageMs: 20_000 }],
      threads: Array.from({ length: 8 }, (_, i) => ({
        comm: `Bun Pool ${i}`,
        state: "S",
        wchan: "futex_wait_queue",
        count: 1,
      })),
    },
    sample: {
      ts: 1,
      memory: null,
      memoryStat: null,
      reclaim: null,
      cpu: null,
      events: null,
      deltas: null,
      disk: null,
      activeConversations: Array.from(
        { length: conversationCount },
        (_, i) => ({
          conversationId: `01a0c9a0-0000-7000-8000-00000000000${i % 10}`,
          title:
            "A long title drawn from the user's own first message x".repeat(2),
          originChannel: "vellum",
          originInterface: "web",
          processingStartedAt: 1,
        }),
      ),
    },
  };
}

/** The report's maximum of 10 activity groups, longest (a user turn) first. */
const fullActivity: DaemonActivityGroup[] = [
  {
    kind: "turn",
    conversationType: "standard",
    callSite: "mainAgent",
    turnInterface: "web",
    interactive: true,
    count: 1,
    running: 1,
    longestMs: 90_000,
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    kind: "turn" as const,
    conversationType: "background" as const,
    callSite: "heartbeatAgent" as const,
    interactive: false,
    count: i + 1,
    running: 0,
    longestMs: 60_000 - i,
  })),
];

const trail: SectionTrailEntry[] = Array.from({ length: 16 }, (_, i) => ({
  label: "conversation-crud:get-messages",
  startedAgoMs: 100_000 + i * 1_000,
  endedAgoMs: 99_000 + i * 1_000,
}));

describe("evaluateTick", () => {
  const INTERVAL = 1_000;
  const THRESHOLD = 5_000;

  test("a healthy tick at the scheduled interval is not a block", () => {
    // GIVEN the timer fired right on schedule
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(INTERVAL, INTERVAL, THRESHOLD);
    // THEN no block is observed
    expect(blockedMs).toBe(0);
    expect(exceeded).toBe(false);
  });

  test("an early tick clamps the blocked duration to zero", () => {
    // GIVEN the timer fired sooner than the interval (e.g. clock jitter)
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(200, INTERVAL, THRESHOLD);
    // THEN the blocked duration never goes negative
    expect(blockedMs).toBe(0);
    expect(exceeded).toBe(false);
  });

  test("lateness under the threshold is measured but not reported", () => {
    // GIVEN the loop was blocked ~2s (below the 5s threshold)
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(3_000, INTERVAL, THRESHOLD);
    // THEN the block is quantified but does not trip a report
    expect(blockedMs).toBe(2_000);
    expect(exceeded).toBe(false);
  });

  test("the threshold is inclusive", () => {
    // GIVEN the blocked duration lands exactly on the threshold
    // WHEN the tick is evaluated
    const { blockedMs, exceeded } = evaluateTick(
      INTERVAL + THRESHOLD,
      INTERVAL,
      THRESHOLD,
    );
    // THEN it counts as exceeded
    expect(blockedMs).toBe(THRESHOLD);
    expect(exceeded).toBe(true);
  });

  test("a multi-minute freeze reports the full blocked duration", () => {
    // GIVEN a ~123s freeze (the observed daemon-freeze magnitude) with a 1s tick
    // WHEN the first tick after unblock is evaluated
    const { blockedMs, exceeded } = evaluateTick(124_000, INTERVAL, THRESHOLD);
    // THEN the reported block excludes the one normal interval of wait
    expect(blockedMs).toBe(123_000);
    expect(exceeded).toBe(true);
  });
});

describe("start/stop lifecycle", () => {
  test("start and stop are idempotent and order-independent", () => {
    // GIVEN a fresh module
    // WHEN start/stop are called repeatedly and out of order
    // THEN none of the calls throw (daemon boot + both shutdown paths are safe)
    expect(() => stopEventLoopWatchdog()).not.toThrow();
    expect(() => startEventLoopWatchdog()).not.toThrow();
    expect(() => startEventLoopWatchdog()).not.toThrow();
    expect(() => stopEventLoopWatchdog()).not.toThrow();
    expect(() => stopEventLoopWatchdog()).not.toThrow();
  });
});

describe("buildBlockTelemetryDetail", () => {
  test("never sends conversation titles", () => {
    // GIVEN a capture whose active conversations carry titles
    // WHEN the telemetry detail is built
    const detail = buildBlockTelemetryDetail({
      thresholdMs: 5_000,
      daemonUptimeMs: 60_000,
      activity: [],
      sectionTrail: [],
      stallCapture: captureWith(2),
    });
    // THEN every title is nulled but the rest of the entry is kept
    const conversations = detail.stall_capture!.sample.activeConversations!;
    expect(conversations).toHaveLength(2);
    expect(conversations.every((c) => c.title === null)).toBe(true);
    expect(conversations[0]!.originInterface).toBe("web");
  });

  test("does not mutate the caller's capture", () => {
    // GIVEN a capture the caller also logs locally
    const capture = captureWith(2);
    // WHEN the telemetry detail is built
    buildBlockTelemetryDetail({
      thresholdMs: 5_000,
      daemonUptimeMs: 60_000,
      activity: [],
      sectionTrail: trail,
      stallCapture: capture,
    });
    // THEN the local copy still has its titles
    expect(capture.sample.activeConversations![0]!.title).not.toBeNull();
  });

  test("a small report is sent untrimmed", () => {
    // GIVEN a report well under the byte cap
    // WHEN the telemetry detail is built
    const detail = buildBlockTelemetryDetail({
      thresholdMs: 5_000,
      daemonUptimeMs: 60_000,
      activity: [],
      sectionTrail: trail.slice(0, 2),
      stallCapture: captureWith(1),
    });
    // THEN nothing is trimmed and the wait state survives intact
    expect(detail.trimmed).toBeUndefined();
    expect(detail.stall_capture!.waitState!.threads).toHaveLength(8);
  });

  test("an oversize report is trimmed to fit, keeping the wait state", () => {
    // GIVEN a full trail and many active conversations (the heavy-user case)
    // WHEN the telemetry detail is built
    const detail = buildBlockTelemetryDetail({
      thresholdMs: 5_000,
      daemonUptimeMs: 60_000,
      activity: fullActivity,
      sectionTrail: trail,
      stallCapture: captureWith(20),
    });
    // THEN it fits the server cap, records what was trimmed, and still
    // carries the attribution the report exists for
    expect(detailFitsServerCap(detail)).toBe(true);
    expect(detail.trimmed!.length).toBeGreaterThan(0);
    expect(detail.stall_capture!.waitState!.epoll!.pipes).toBe(1);
    expect(detail.stall_capture!.waitState!.children).toHaveLength(1);
    expect(detail.activity.length).toBeGreaterThanOrEqual(4);
    expect(detail.activity[0]).toMatchObject({
      kind: "turn",
      conversationType: "standard",
    });
  });
});

describe("detailFitsServerCap", () => {
  test("ignores undefined keys, which serialization drops", () => {
    // GIVEN a small detail with an undefined field
    // WHEN it is checked against the server cap
    // THEN the undefined key does not count as an invalid payload
    expect(detailFitsServerCap({ a: 1, b: undefined })).toBe(true);
  });

  test("rejects a detail over the server cap", () => {
    // GIVEN a detail larger than 4096 serialized bytes
    // WHEN it is checked against the server cap
    // THEN it does not fit
    expect(detailFitsServerCap({ blob: "x".repeat(5_000) })).toBe(false);
  });
});
