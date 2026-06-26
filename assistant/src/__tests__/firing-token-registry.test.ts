import { describe, expect, test } from "bun:test";

import { firingTokenRegistry } from "../schedule/firing-token-registry.js";

/** Spawn a long-lived process so liveness checks see `exitCode === null`. */
function spawnLive(): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
}

describe("firingTokenRegistry", () => {
  test("mints a secret token distinct from the run id", () => {
    const token = firingTokenRegistry.mint("run-1", "job-1");
    expect(token).not.toBe("run-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    firingTokenRegistry.revoke(token);
  });

  test("a live firing resolves to its {runId, jobId}", () => {
    const token = firingTokenRegistry.mint("run-2", "job-2");
    const proc = spawnLive();
    try {
      firingTokenRegistry.attachProc("run-2", proc);
      expect(firingTokenRegistry.resolve(token)).toEqual({
        runId: "run-2",
        jobId: "job-2",
      });
    } finally {
      proc.kill();
      firingTokenRegistry.revoke(token);
    }
  });

  test("resolve returns null after the subprocess exits, even without revoke", async () => {
    const token = firingTokenRegistry.mint("run-3", "job-3");
    const proc = spawnLive();
    firingTokenRegistry.attachProc("run-3", proc);
    expect(firingTokenRegistry.resolve(token)).not.toBeNull();

    proc.kill();
    await proc.exited;

    // No revoke() — correctness comes from the live-process check.
    expect(firingTokenRegistry.resolve(token)).toBeNull();
    firingTokenRegistry.revoke(token);
  });

  test("a firing with no attached subprocess is not live (fail-closed)", () => {
    const token = firingTokenRegistry.mint("run-4", "job-4");
    expect(firingTokenRegistry.resolve(token)).toBeNull();
    firingTokenRegistry.revoke(token);
  });

  test("unknown or revoked tokens resolve to null", () => {
    expect(firingTokenRegistry.resolve("not-a-real-token")).toBeNull();

    const token = firingTokenRegistry.mint("run-5", "job-5");
    const proc = spawnLive();
    firingTokenRegistry.attachProc("run-5", proc);
    firingTokenRegistry.revoke(token);
    expect(firingTokenRegistry.resolve(token)).toBeNull();
    proc.kill();
  });

  test("sweep drops entries whose subprocess has exited", async () => {
    const token = firingTokenRegistry.mint("run-6", "job-6");
    const proc = spawnLive();
    firingTokenRegistry.attachProc("run-6", proc);

    proc.kill();
    await proc.exited;

    firingTokenRegistry.sweep();
    expect(firingTokenRegistry.resolve(token)).toBeNull();
  });
});
