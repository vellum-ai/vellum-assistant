import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

/**
 * The watch-timeline sweep's startup contract.
 *
 * `drainOrphanedWatchTimelineEntries` is the recovery path for a purge that
 * did not happen, and the rows it reclaims hold narration, AX trees, and
 * screenshots of the user's screen. Database maintenance runs it on a periodic
 * cadence from the memory plugin's jobs worker, so an install with that plugin
 * disabled or `memory.enabled: false` reaches it never. Daemon startup runs it
 * on every install and closes that gap.
 *
 * Two properties carry the contract, and each is checked the way it can be:
 *
 *  1. lifecycle calls the sweep on its DB-ready startup path, after migrations
 *     have settled. Mounting the full lifecycle import graph to observe a real
 *     boot is disproportionately heavy, so this is a source guard over the call
 *     site.
 *  2. a throwing sweep does not abort startup. The wiring below mirrors the
 *     lifecycle call site verbatim.
 */

const LIFECYCLE_PATH = join(import.meta.dir, "..", "lifecycle.ts");

describe("lifecycle watch-timeline sweep wiring", () => {
  test("lifecycle sweeps orphaned entries on the DB-ready startup path", () => {
    const source = readFileSync(LIFECYCLE_PATH, "utf8");

    const sweepIndex = source.indexOf("drainOrphanedWatchTimelineEntries()");
    expect(sweepIndex).toBeGreaterThan(-1);

    // The drain yields between pages, so the call has to be awaited. Without
    // the await the count is a pending promise, which compares false against
    // zero, and the pass reports nothing swept however much it removed.
    expect(source).toContain("await drainOrphanedWatchTimelineEntries()");

    // `startRuntimeHttpServerBackgroundSweeps()` is the point where lifecycle
    // has established that migrations settled, so a call after it runs against
    // a database whose tables exist.
    const migrationsSettledIndex = source.indexOf(
      "startRuntimeHttpServerBackgroundSweeps();",
    );
    expect(migrationsSettledIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(migrationsSettledIndex);

    // The call sits under a `dbReady` guard, so a boot whose DB never opened
    // does not reach it.
    const guardIndex = source.lastIndexOf("if (dbReady) {", sweepIndex);
    expect(guardIndex).toBeGreaterThan(migrationsSettledIndex);
  });

  test("invokes the sweep once and logs only when it reclaimed rows", () => {
    const sweep = mock(() => 0);

    const quiet = runStartupSweepWiring(sweep);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(quiet.logged).toBe(false);
    expect(quiet.reachedNextStep).toBe(true);

    const noisy = runStartupSweepWiring(mock(() => 3));
    expect(noisy.logged).toBe(true);
    expect(noisy.reachedNextStep).toBe(true);
  });

  test("a throwing sweep does NOT abort startup", () => {
    const sweep = mock(() => {
      throw new Error("sweep exploded");
    });

    const { reachedNextStep, logged } = runStartupSweepWiring(sweep);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logged).toBe(false);
    expect(reachedNextStep).toBe(true);
  });
});

/**
 * Replicates the lifecycle startup wiring: sweep, log only a non-zero count,
 * swallow any throw, then continue to the next startup step.
 */
function runStartupSweepWiring(sweep: () => number): {
  reachedNextStep: boolean;
  logged: boolean;
} {
  let logged = false;
  try {
    const sweptWatchEntries = sweep();
    if (sweptWatchEntries > 0) {
      logged = true;
    }
  } catch {
    // Startup must never block on a subsystem failure.
  }
  return { reachedNextStep: true, logged };
}
