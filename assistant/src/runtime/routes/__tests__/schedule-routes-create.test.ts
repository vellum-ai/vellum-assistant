/**
 * The `createSchedule` route accepts `script` mode (not just execute/workflow),
 * so a catalog skill's `setup.ts` can register a script-mode schedule via the
 * CLI/HTTP path instead of the in-assistant `schedule_create` tool.
 */

import { describe, expect, test } from "bun:test";

import { initializeDb } from "../../../persistence/db-init.js";
import { ROUTES } from "../schedule-routes.js";

await initializeDb();

const createHandler = (() => {
  const route = ROUTES.find((r) => r.operationId === "createSchedule");
  if (!route) throw new Error("createSchedule route not found");
  return route.handler;
})();

interface ListResult {
  schedules: Array<{
    name: string;
    mode: string;
    script: string | null;
    timeoutMs: number | null;
  }>;
}

async function create(body: Record<string, unknown>): Promise<ListResult> {
  return (await createHandler({ body })) as ListResult;
}

describe("createSchedule route — script mode", () => {
  test("creates a script-mode schedule with its command + timeout", async () => {
    const res = await create({
      name: "wt-script-create",
      mode: "script",
      script: 'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts',
      expression: "*/15 * * * *",
      description: "polls github",
      timeoutMs: 120000,
    });
    const job = res.schedules.find((s) => s.name === "wt-script-create");
    expect(job?.mode).toBe("script");
    expect(job?.script).toContain("bun poll.ts");
    expect(job?.timeoutMs).toBe(120000);
  });

  test("script mode does not require a message", async () => {
    const res = await create({
      name: "wt-script-nomsg",
      mode: "script",
      script: "echo hi",
      expression: "0 * * * *",
      description: "d",
    });
    expect(
      res.schedules.find((s) => s.name === "wt-script-nomsg")?.mode,
    ).toBe("script");
  });

  test("rejects script mode without a script", async () => {
    await expect(
      create({
        name: "wt-script-missing",
        mode: "script",
        expression: "* * * * *",
        description: "d",
      }),
    ).rejects.toThrow(/script is required/);
  });
});
