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
