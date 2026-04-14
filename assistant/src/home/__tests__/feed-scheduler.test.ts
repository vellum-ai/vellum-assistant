/**
 * Unit tests for the home-feed scheduler's tick lifecycle.
 *
 * Producer implementations are injected via `FeedSchedulerOptions`
 * spies so the tests never touch `mock.module` (which leaks across
 * files in Bun's test runner). The dedicated producer tests
 * (`reflection-producer.test.ts`, `platform-gmail-digest.test.ts`)
 * cover each producer's internal behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { startFeedScheduler } from "../feed-scheduler.js";
import type { FeedItem } from "../feed-types.js";
import type { ReflectionResult } from "../reflection-producer.js";

const gmailDigestRunner = mock<
  (now: Date, countSource: () => Promise<number>) => Promise<FeedItem | null>
>(async () => null);

const reflectionRunner = mock<(now: Date) => Promise<ReflectionResult>>(
  async () => ({ wroteCount: 0, skippedReason: "empty_items" }),
);

const defaultOptions = () => ({
  gmailCountSource: async () => 0,
  gmailDigestRunner,
  reflectionRunner,
  runOnStart: false,
});

beforeEach(() => {
  gmailDigestRunner.mockClear();
  reflectionRunner.mockClear();
});

describe("startFeedScheduler", () => {
  let handle: ReturnType<typeof startFeedScheduler> | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test("runOnce invokes both producers on the first tick", async () => {
    handle = startFeedScheduler(defaultOptions());
    const summary = await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));

    expect(summary.gmailDigestRan).toBe(true);
    expect(summary.reflectionRan).toBe(true);
    expect(gmailDigestRunner).toHaveBeenCalledTimes(1);
    expect(reflectionRunner).toHaveBeenCalledTimes(1);
  });

  test("gmail digest re-runs every tick once its interval has elapsed", async () => {
    handle = startFeedScheduler(defaultOptions());

    const t0 = new Date("2026-04-14T12:00:00.000Z");
    await handle.runOnce(t0);

    // 1 minute later — below the 5-minute gmail gate, should NOT re-run.
    const t1 = new Date("2026-04-14T12:01:00.000Z");
    const summary1 = await handle.runOnce(t1);
    expect(summary1.gmailDigestRan).toBe(false);

    // 6 minutes later — past the 5-minute gate, should re-run.
    const t2 = new Date("2026-04-14T12:06:00.000Z");
    const summary2 = await handle.runOnce(t2);
    expect(summary2.gmailDigestRan).toBe(true);
  });

  test("reflection only re-runs every 30 minutes", async () => {
    handle = startFeedScheduler(defaultOptions());

    const t0 = new Date("2026-04-14T12:00:00.000Z");
    await handle.runOnce(t0);

    // 5 min later — below the 30-min reflection gate.
    const t1 = new Date("2026-04-14T12:05:00.000Z");
    const summary1 = await handle.runOnce(t1);
    expect(summary1.reflectionRan).toBe(false);

    // 31 min later — past the 30-min gate, should re-run.
    const t2 = new Date("2026-04-14T12:31:00.000Z");
    const summary2 = await handle.runOnce(t2);
    expect(summary2.reflectionRan).toBe(true);
  });

  test("producer exceptions do not break the tick loop", async () => {
    gmailDigestRunner.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    reflectionRunner.mockImplementationOnce(async () => {
      throw new Error("also boom");
    });

    handle = startFeedScheduler(defaultOptions());
    const summary = await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));

    // Both producers were invoked and both counted as "ran" (the
    // gating bookkeeping advanced) even though they threw. This is
    // the intended behavior — a broken producer shouldn't cause the
    // scheduler to hammer it every tick via a backoff bypass.
    expect(summary.gmailDigestRan).toBe(true);
    expect(summary.reflectionRan).toBe(true);
  });

  test("stop() makes subsequent runOnce calls no-op", async () => {
    handle = startFeedScheduler(defaultOptions());
    await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));

    handle.stop();

    const beforeCount = gmailDigestRunner.mock.calls.length;
    // A tick well past the cadence gate should not fire after stop.
    await handle.runOnce(new Date("2026-04-14T13:00:00.000Z"));
    expect(gmailDigestRunner.mock.calls.length).toBe(beforeCount);
  });

  test("gmailCountSource option is threaded through to the digest runner", async () => {
    const countSource = mock<() => Promise<number>>(async () => 7);
    handle = startFeedScheduler({
      ...defaultOptions(),
      gmailCountSource: countSource,
    });
    await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));

    expect(gmailDigestRunner).toHaveBeenCalledTimes(1);
    const [, passedCountSource] = gmailDigestRunner.mock.calls[0]!;
    expect(passedCountSource).toBe(countSource);
  });
});
