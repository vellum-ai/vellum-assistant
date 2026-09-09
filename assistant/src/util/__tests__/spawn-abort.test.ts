/**
 * Cancellation behaviour of `spawnWithTimeout()`.
 *
 * ffmpeg transcodes and frame extractions run long enough that abandoning one
 * after the user pressed Stop keeps a core busy for minutes on work nobody is
 * waiting for, so the signal kills the process rather than just being checked
 * around it.
 */
import { describe, expect, test } from "bun:test";

import { createAbortReason } from "../abort-reasons.js";
import { spawnWithTimeout } from "../spawn.js";

const REASON = createAbortReason("user_cancel", "spawn-abort.test");

describe("spawnWithTimeout cancellation", () => {
  test("an already-aborted signal never spawns", async () => {
    const controller = new AbortController();
    controller.abort(REASON);

    await expect(
      spawnWithTimeout(["sleep", "30"], 60_000, controller.signal),
    ).rejects.toBe(REASON);
  });

  test("aborting mid-run kills the process and rejects", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = spawnWithTimeout(
      ["sleep", "30"],
      60_000,
      controller.signal,
    );
    setTimeout(() => controller.abort(REASON), 20);

    await expect(running).rejects.toBe(REASON);
    // Rejects on the abort, not by waiting the process or the timeout out.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a live signal leaves a normal run alone", async () => {
    const controller = new AbortController();
    const result = await spawnWithTimeout(
      ["echo", "hello"],
      10_000,
      controller.signal,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});
