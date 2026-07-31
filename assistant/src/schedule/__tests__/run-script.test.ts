/**
 * `runScript` injects the schedule's ids into the spawned command's env so a
 * saved command can reference its own dir, e.g.
 * `cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts`.
 */

import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { runScript } from "../run-script.js";

describe("runScript schedule env injection", () => {
  test("injects __SCHEDULE_ID and __SCHEDULE_RUN_ID, expanded by the shell", async () => {
    const result = await runScript(
      'echo "id=$__SCHEDULE_ID run=$__SCHEDULE_RUN_ID"',
      { cwd: tmpdir(), scheduleId: "sched-abc", scheduleRunId: "run-xyz" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("id=sched-abc run=run-xyz");
  });
});

/** Poll until the pid is gone, since SIGKILL delivery is asynchronous. */
async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("runScript orphan reaping", () => {
  test("reaps background children when the script exits normally", async () => {
    const started = Date.now();
    const result = await runScript("sleep 600 & echo $!", {
      cwd: tmpdir(),
      scheduleId: "sched-reap",
      scheduleRunId: "run-reap",
    });
    // The backgrounded child holds the stdout pipe, so resolving quickly
    // proves the group sweep closed it rather than the drain timeout firing.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.exitCode).toBe(0);
    const childPid = Number(result.stdout.trim());
    expect(childPid).toBeGreaterThan(0);
    expect(await waitUntilDead(childPid)).toBe(true);
  });

  test("resolves and keeps partial output when an escaped process holds the pipe open", async () => {
    // Spawning a detached child that inherits stdout mimics a daemonized
    // process: it leaves the script's process group, so it survives the
    // sweep while still holding the pipe's write end.
    const escape =
      'const p = Bun.spawn(["sleep", "600"], { detached: true, stdout: "inherit" }); p.unref(); console.log(p.pid);';
    const result = await runScript(`bun -e '${escape}'`, {
      cwd: tmpdir(),
      scheduleId: "sched-escape",
      scheduleRunId: "run-escape",
    });
    expect(result.exitCode).toBe(0);
    const escapeePid = Number(result.stdout.trim());
    expect(escapeePid).toBeGreaterThan(0);
    expect(() => process.kill(escapeePid, 0)).not.toThrow();
    process.kill(escapeePid, "SIGKILL");
  }, 15_000);

  test("reaps background children when the script times out", async () => {
    const result = await runScript("sleep 600 & echo $!; sleep 600", {
      cwd: tmpdir(),
      scheduleId: "sched-reap-timeout",
      scheduleRunId: "run-reap-timeout",
      timeoutMs: 1_000,
    });
    expect(result.exitCode).toBe(124);
    const childPid = Number(result.stdout.trim());
    expect(childPid).toBeGreaterThan(0);
    expect(await waitUntilDead(childPid)).toBe(true);
  });
});
