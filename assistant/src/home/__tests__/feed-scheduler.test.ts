/**
 * Unit tests for the home-feed scheduler's tick lifecycle.
 *
 * Producer implementations are injected via `FeedSchedulerOptions`
 * spies so the tests never touch `mock.module` (which leaks across
 * files in Bun's test runner). The dedicated producer tests
 * (`rollup-producer.test.ts`, `platform-gmail-digest.test.ts`) cover
 * each producer's internal behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { startFeedScheduler } from "../feed-scheduler.js";
import type { FeedItem } from "../feed-types.js";
import type { RollupResult } from "../rollup-producer.js";

const gmailDigestRunner = mock<
  (now: Date, countSource: () => Promise<number>) => Promise<FeedItem | null>
>(async () => null);

const rollupRunner = mock<(now: Date) => Promise<RollupResult>>(async () => ({
  wroteCount: 0,
  skippedReason: "empty_items",
}));

const defaultOptions = () => ({
  gmailCountSource: async () => 0,
  gmailDigestRunner,
  rollupRunner,
  runOnStart: false,
});

beforeEach(() => {
  gmailDigestRunner.mockClear();
  rollupRunner.mockClear();
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
    expect(summary.rollupRan).toBe(true);
    expect(gmailDigestRunner).toHaveBeenCalledTimes(1);
    expect(rollupRunner).toHaveBeenCalledTimes(1);
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

  test("rollup only re-runs every 2 hours as the safety-net cadence", async () => {
    // The scheduler is the safety net; the primary trigger is the
    // on-visit refresh in home-feed-routes.ts. Long cadence is
    // intentional so the scheduler doesn't fight the route.
    handle = startFeedScheduler(defaultOptions());

    const t0 = new Date("2026-04-14T12:00:00.000Z");
    await handle.runOnce(t0);

    // 30 min later — below the 2-hour gate.
    const t1 = new Date("2026-04-14T12:30:00.000Z");
    const summary1 = await handle.runOnce(t1);
    expect(summary1.rollupRan).toBe(false);

    // 1h later — still below the 2-hour gate.
    const t2 = new Date("2026-04-14T13:00:00.000Z");
    const summary2 = await handle.runOnce(t2);
    expect(summary2.rollupRan).toBe(false);

    // 2h 1m later — past the gate, should re-run.
    const t3 = new Date("2026-04-14T14:01:00.000Z");
    const summary3 = await handle.runOnce(t3);
    expect(summary3.rollupRan).toBe(true);
  });

  test("rollup cooldown is NOT advanced on no_provider so the next tick retries", async () => {
    // Mimic the daemon startup ordering: the scheduler boots before
    // the provider registry is ready. The first tick gets no_provider;
    // the next tick (even one second later) must still run the rollup
    // instead of waiting 2 hours.
    rollupRunner.mockImplementationOnce(async () => ({
      wroteCount: 0,
      skippedReason: "no_provider",
    }));

    handle = startFeedScheduler(defaultOptions());
    const t0 = new Date("2026-04-14T12:00:00.000Z");
    await handle.runOnce(t0);
    expect(rollupRunner).toHaveBeenCalledTimes(1);

    // One second later — providers have initialized.
    const t1 = new Date("2026-04-14T12:00:01.000Z");
    const summary = await handle.runOnce(t1);

    expect(summary.rollupRan).toBe(true);
    expect(rollupRunner).toHaveBeenCalledTimes(2);
  });

  test("rollup cooldown is NOT advanced on in_flight so the next tick retries", async () => {
    // in_flight means another caller (on-visit refresh, usually) is
    // already running the producer. Advancing the gate here would
    // force the NEXT tick to wait out the full cadence window even
    // though nothing broken happened — the other caller's result is
    // effectively this tick's run.
    rollupRunner.mockImplementationOnce(async () => ({
      wroteCount: 0,
      skippedReason: "in_flight",
    }));

    handle = startFeedScheduler(defaultOptions());
    await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));
    expect(rollupRunner).toHaveBeenCalledTimes(1);

    const summary = await handle.runOnce(new Date("2026-04-14T12:00:01.000Z"));
    expect(summary.rollupRan).toBe(true);
    expect(rollupRunner).toHaveBeenCalledTimes(2);
  });

  test("rollup cooldown is NOT advanced on no_actions so the next tick retries", async () => {
    // no_actions means the activity log was empty — no LLM call was
    // made. A subsequent tick should retry as soon as new actions
    // land, not wait the full 2-hour window.
    rollupRunner.mockImplementationOnce(async () => ({
      wroteCount: 0,
      skippedReason: "no_actions",
    }));

    handle = startFeedScheduler(defaultOptions());
    await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));
    expect(rollupRunner).toHaveBeenCalledTimes(1);

    // One second later — the next tick must still invoke the rollup.
    const summary = await handle.runOnce(new Date("2026-04-14T12:00:01.000Z"));
    expect(summary.rollupRan).toBe(true);
    expect(rollupRunner).toHaveBeenCalledTimes(2);
  });

  test("rollup cooldown IS advanced on other skip reasons to preserve backoff", async () => {
    // empty_items / malformed_output / provider_error are real LLM
    // attempts — the next tick should be gated by the full 2-hour
    // window so a broken producer doesn't get hammered every tick.
    rollupRunner.mockImplementationOnce(async () => ({
      wroteCount: 0,
      skippedReason: "malformed_output",
    }));

    handle = startFeedScheduler(defaultOptions());
    await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));
    expect(rollupRunner).toHaveBeenCalledTimes(1);

    // Thirty minutes later — below the 2-hour gate, should NOT re-run.
    const summary = await handle.runOnce(new Date("2026-04-14T12:30:00.000Z"));
    expect(summary.rollupRan).toBe(false);
    expect(rollupRunner).toHaveBeenCalledTimes(1);
  });

  test("producer exceptions do not break the tick loop", async () => {
    gmailDigestRunner.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    rollupRunner.mockImplementationOnce(async () => {
      throw new Error("also boom");
    });

    handle = startFeedScheduler(defaultOptions());
    const summary = await handle.runOnce(new Date("2026-04-14T12:00:00.000Z"));

    // Both producers were invoked and both counted as "ran" (the
    // gating bookkeeping advanced) even though they threw. This is
    // the intended behavior — a broken producer shouldn't cause the
    // scheduler to hammer it every tick via a backoff bypass.
    expect(summary.gmailDigestRan).toBe(true);
    expect(summary.rollupRan).toBe(true);
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
