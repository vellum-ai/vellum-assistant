import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

import type { Database } from "bun:sqlite";

import { RiskLevel } from "../permissions/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  __clearRegistryForTesting,
  __resetRegistryForTesting,
  registerTool,
} from "../tools/registry.js";
import { executeScheduleCreate as rawExecuteScheduleCreate } from "../tools/schedule/create.js";
import { executeScheduleDelete } from "../tools/schedule/delete.js";
import { executeScheduleList } from "../tools/schedule/list.js";
import { executeScheduleUpdate } from "../tools/schedule/update.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

await initializeDb();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conversation",
  trustClass: "guardian",
};

const trustedCtx: ToolContext = {
  ...ctx,
  trustClass: "trusted_contact",
};

function executeScheduleCreate(
  input: Record<string, unknown>,
  context: ToolContext,
) {
  return rawExecuteScheduleCreate(
    { description: "Test schedule description", ...input },
    context,
  );
}

// ── schedule_create ─────────────────────────────────────────────────

describe("schedule_create tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with valid cron expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Daily standup",
        description: "Remind the team to join the daily standup.",
        expression: "0 9 * * 1-5",
        message: "Time for standup!",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Daily standup");
    expect(result.content).toContain(
      "Description: Remind the team to join the daily standup.",
    );
    expect(result.content).toContain("Every weekday at 9:00 AM");
    expect(result.content).toContain("Enabled: true");

    const row = getRawDb()
      .query("SELECT description FROM cron_jobs LIMIT 1")
      .get() as { description: string };
    expect(row.description).toBe("Remind the team to join the daily standup.");
  });

  test("persists the creating conversation for recurring schedules", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Recurring source",
        expression: "0 9 * * *",
        message: "remember the source",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT created_from_conversation_id FROM cron_jobs LIMIT 1")
      .get() as { created_from_conversation_id: string | null };
    expect(row.created_from_conversation_id).toBe(ctx.conversationId);
  });

  test("creates a disabled schedule", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Paused job",
        expression: "0 12 * * *",
        message: "Noon check",
        enabled: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled: false");
  });

  test("creates a schedule with timezone", async () => {
    const result = await executeScheduleCreate(
      {
        name: "LA morning",
        expression: "0 8 * * *",
        message: "Good morning LA",
        timezone: "America/Los_Angeles",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("America/Los_Angeles");
  });

  test("rejects missing name", async () => {
    const result = await executeScheduleCreate(
      {
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("name is required");
  });

  test("rejects missing description", async () => {
    const result = await rawExecuteScheduleCreate(
      {
        name: "No description",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("description is required");
  });

  test("rejects blank description", async () => {
    const result = await rawExecuteScheduleCreate(
      {
        name: "Blank description",
        description: "   ",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("description is required");
  });

  test("rejects missing expression when no fire_at", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Test",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("expression is required");
  });

  test("rejects missing message", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Test",
        expression: "0 9 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("message is required");
  });

  test("rejects invalid cron expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad cron",
        syntax: "cron",
        expression: "not-a-cron",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid cron expression");
  });

  test("rejects non-guardian actors", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Blocked schedule",
        expression: "0 9 * * *",
        message: "test",
      },
      trustedCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian actors");
  });
});

// ── schedule_create with fire_at (one-shot) ──────────────────────────

describe("schedule_create with fire_at (one-shot)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a one-shot schedule with fire_at", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "One-time reminder",
        description: "Remind the user about a one-time event.",
        fire_at: futureDate,
        message: "Don't forget!",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");
    expect(result.content).toContain("Type: one-shot");
    expect(result.content).toContain("Mode: execute");
    expect(result.content).toContain("One-time reminder");
    expect(result.content).toContain(
      "Description: Remind the user about a one-time event.",
    );
    expect(result.content).toContain("Status: active");

    const row = getRawDb()
      .query("SELECT description FROM cron_jobs LIMIT 1")
      .get() as { description: string };
    expect(row.description).toBe("Remind the user about a one-time event.");
  });

  test("persists the creating conversation for one-shot schedules", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "One-shot source",
        fire_at: futureDate,
        message: "remember this source too",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT created_from_conversation_id FROM cron_jobs LIMIT 1")
      .get() as { created_from_conversation_id: string | null };
    expect(row.created_from_conversation_id).toBe(ctx.conversationId);
  });

  test("rejects fire_at that is not valid ISO 8601", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad date",
        fire_at: "not-a-date",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("valid ISO 8601");
  });

  test("rejects fire_at that is in the past", async () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Past date",
        fire_at: pastDate,
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be in the future");
  });

  test("fire_at ignores expression param when provided", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Fire at with expression",
        fire_at: futureDate,
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");
    expect(result.content).toContain("Type: one-shot");
  });
});

// ── schedule_create with mode and routing ──────────────────────────

describe("schedule_create with mode and routing", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("passes mode through to schedule", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Notify schedule",
        expression: "0 9 * * *",
        message: "notify test",
        mode: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: notify");
  });

  test("defaults mode to execute", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Default mode",
        expression: "0 9 * * *",
        message: "default test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: execute");
  });

  test("rejects invalid mode", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad mode",
        expression: "0 9 * * *",
        message: "test",
        mode: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mode must be one of");
  });

  test("passes routing_intent and routing_hints through", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await executeScheduleCreate(
      {
        name: "Routed schedule",
        fire_at: futureDate,
        message: "routed test",
        routing_intent: "single_channel",
        routing_hints: { channel: "slack" },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot schedule created successfully");

    // Verify in DB
    const row = getRawDb()
      .query("SELECT routing_intent, routing_hints_json FROM cron_jobs LIMIT 1")
      .get() as { routing_intent: string; routing_hints_json: string };
    expect(row.routing_intent).toBe("single_channel");
    expect(JSON.parse(row.routing_hints_json)).toEqual({ channel: "slack" });
  });
});

// ── schedule_create / schedule_update workflow mode ─────────────────

describe("schedule tools — workflow mode", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    setOverridesForTesting({});
  });
  afterAll(() => {
    setOverridesForTesting({});
  });

  test("creates a workflow-mode schedule with workflow_name + workflow_args", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Morning triage",
        expression: "0 8 * * *",
        mode: "workflow",
        workflow_name: "inbox-triage",
        workflow_args: { limit: 50 },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: workflow");

    const row = getRawDb()
      .query(
        "SELECT mode, workflow_name, workflow_args_json FROM cron_jobs LIMIT 1",
      )
      .get() as {
      mode: string;
      workflow_name: string;
      workflow_args_json: string;
    };
    expect(row.mode).toBe("workflow");
    expect(row.workflow_name).toBe("inbox-triage");
    expect(JSON.parse(row.workflow_args_json)).toEqual({ limit: 50 });
  });

  test("rejects workflow mode without workflow_name", async () => {
    const result = await executeScheduleCreate(
      { name: "No wf name", expression: "0 8 * * *", mode: "workflow" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("workflow_name is required");
  });

  test("update to workflow mode requires a workflow_name", async () => {
    await executeScheduleCreate(
      { name: "To workflow", expression: "0 9 * * *", message: "test" },
      ctx,
    );
    const { id } = getRawDb()
      .query("SELECT id FROM cron_jobs LIMIT 1")
      .get() as { id: string };

    const result = await executeScheduleUpdate(
      { job_id: id, mode: "workflow" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("workflow_name is required");
  });

  test("updates a schedule into workflow mode with a workflow_name", async () => {
    await executeScheduleCreate(
      { name: "To workflow ok", expression: "0 9 * * *", message: "test" },
      ctx,
    );
    const { id } = getRawDb()
      .query("SELECT id FROM cron_jobs LIMIT 1")
      .get() as { id: string };

    const result = await executeScheduleUpdate(
      { job_id: id, mode: "workflow", workflow_name: "nightly-report" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: workflow");
    const dbRow = getRawDb()
      .query("SELECT mode, workflow_name FROM cron_jobs WHERE id = ?")
      .get(id) as { mode: string; workflow_name: string };
    expect(dbRow.mode).toBe("workflow");
    expect(dbRow.workflow_name).toBe("nightly-report");
  });
});

// ── schedule_create workflow capability manifest ────────────────────

describe("schedule_create — workflow capability manifest", () => {
  function makeFakeTool(name: string): Tool {
    return {
      name,
      description: `Fake ${name}`,
      category: "test",
      defaultRiskLevel: RiskLevel.Low,
      executionTarget: "sandbox",
      input_schema: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "ok", isError: false };
      },
    };
  }

  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    setOverridesForTesting({});
    // Deterministic registry so a declared side-effecting tool resolves.
    __clearRegistryForTesting();
    registerTool(makeFakeTool("file_write"));
  });
  afterAll(() => {
    setOverridesForTesting({});
    __resetRegistryForTesting();
  });

  test("persists a validated side-effecting manifest verbatim", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Nightly writeback",
        expression: "0 2 * * *",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { tools: ["file_write"], persona: true },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT capabilities_json FROM cron_jobs LIMIT 1")
      .get() as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toEqual({
      tools: ["file_write"],
      hostFunctions: [],
      persona: true,
    });
  });

  test("rejects a forbidden manifest at creation", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Recursion vector",
        expression: "0 2 * * *",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { tools: ["run_workflow"] },
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid capabilities manifest");
    expect(getRawDb().query("SELECT id FROM cron_jobs").all()).toHaveLength(0);
  });

  test("rejects an unknown tool in the manifest at creation", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Bad tool",
        expression: "0 2 * * *",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { tools: ["unknown_tool"] },
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid capabilities manifest");
    expect(getRawDb().query("SELECT id FROM cron_jobs").all()).toHaveLength(0);
  });

  test("a read-only manifest persists as a baseline grant", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Read-only run",
        expression: "0 2 * * *",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { tools: [], hostFunctions: [], persona: false },
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT capabilities_json FROM cron_jobs LIMIT 1")
      .get() as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toEqual({
      tools: [],
      hostFunctions: [],
      persona: false,
    });
  });

  test("an absent manifest persists no capabilities", async () => {
    const result = await executeScheduleCreate(
      {
        name: "No manifest",
        expression: "0 2 * * *",
        mode: "workflow",
        workflow_name: "nightly-report",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT capabilities_json FROM cron_jobs LIMIT 1")
      .get() as { capabilities_json: string | null };
    expect(row.capabilities_json).toBeNull();
  });
});

// ── script timeout override ─────────────────────────────────────────

describe("schedule_create / schedule_update timeout_ms", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("persists timeout_ms when creating a script schedule", async () => {
    // GIVEN a script schedule created with a custom timeout
    const result = await executeScheduleCreate(
      {
        name: "Slow job",
        expression: "0 9 * * *",
        message: "",
        mode: "script",
        script: "sleep 5",
        timeout_ms: 120_000,
      },
      ctx,
    );

    // THEN the override is stored on the row
    expect(result.isError).toBe(false);
    const row = getRawDb()
      .query("SELECT timeout_ms FROM cron_jobs LIMIT 1")
      .get() as { timeout_ms: number | null };
    expect(row.timeout_ms).toBe(120_000);
  });

  test("rejects an out-of-range timeout_ms on create", async () => {
    // WHEN creating with a timeout below the minimum
    const result = await executeScheduleCreate(
      {
        name: "Too short",
        expression: "0 9 * * *",
        message: "",
        mode: "script",
        script: "echo hi",
        timeout_ms: 10,
      },
      ctx,
    );

    // THEN the tool returns a validation error and stores nothing
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout_ms must be between");
    const count = getRawDb()
      .query("SELECT COUNT(*) AS n FROM cron_jobs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("updates and clears timeout_ms", async () => {
    // GIVEN an existing script schedule
    await executeScheduleCreate(
      {
        name: "Adjustable",
        expression: "0 9 * * *",
        message: "",
        mode: "script",
        script: "echo hi",
        timeout_ms: 90_000,
      },
      ctx,
    );
    const { id } = getRawDb()
      .query("SELECT id FROM cron_jobs LIMIT 1")
      .get() as { id: string };

    // WHEN the timeout is updated
    const updated = await executeScheduleUpdate(
      { job_id: id, timeout_ms: 5_000 },
      ctx,
    );

    // THEN the new value is stored
    expect(updated.isError).toBe(false);
    const afterUpdate = getRawDb()
      .query("SELECT timeout_ms FROM cron_jobs WHERE id = ?")
      .get(id) as { timeout_ms: number | null };
    expect(afterUpdate.timeout_ms).toBe(5_000);

    // AND WHEN the timeout is cleared with null
    const cleared = await executeScheduleUpdate(
      { job_id: id, timeout_ms: null },
      ctx,
    );

    // THEN the override reverts to null
    expect(cleared.isError).toBe(false);
    const afterClear = getRawDb()
      .query("SELECT timeout_ms FROM cron_jobs WHERE id = ?")
      .get(id) as { timeout_ms: number | null };
    expect(afterClear.timeout_ms).toBeNull();
  });

  test("rejects an out-of-range timeout_ms on update", async () => {
    // GIVEN an existing script schedule
    await executeScheduleCreate(
      {
        name: "Guarded",
        expression: "0 9 * * *",
        message: "",
        mode: "script",
        script: "echo hi",
      },
      ctx,
    );
    const { id } = getRawDb()
      .query("SELECT id FROM cron_jobs LIMIT 1")
      .get() as { id: string };

    // WHEN updating with a timeout above the maximum
    const result = await executeScheduleUpdate(
      { job_id: id, timeout_ms: 60 * 60 * 1000 },
      ctx,
    );

    // THEN the tool returns a validation error
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout_ms must be between");
  });
});

// ── schedule_list ───────────────────────────────────────────────────

describe("schedule_list tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("returns empty message when no schedules exist", async () => {
    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No schedules found");
  });

  test("lists all schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Job Alpha",
        expression: "0 9 * * *",
        message: "Alpha",
      },
      ctx,
    );
    await executeScheduleCreate(
      {
        name: "Job Beta",
        expression: "0 17 * * *",
        message: "Beta",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedules (2)");
    expect(result.content).toContain("Job Alpha");
    expect(result.content).toContain("Job Beta");
  });

  test("filters to enabled only", async () => {
    await executeScheduleCreate(
      {
        name: "Enabled Job",
        expression: "0 9 * * *",
        message: "enabled",
      },
      ctx,
    );
    await executeScheduleCreate(
      {
        name: "Disabled Job",
        expression: "0 17 * * *",
        message: "disabled",
        enabled: false,
      },
      ctx,
    );

    const result = await executeScheduleList({ enabled_only: true }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled Job");
    expect(result.content).not.toContain("Disabled Job");
  });

  test("shows detail for a specific job", async () => {
    await executeScheduleCreate(
      {
        name: "Detail Job",
        description: "Describe the detail job purpose.",
        expression: "30 14 * * *",
        message: "Afternoon check",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule: Detail Job");
    expect(result.content).toContain(
      "Description: Describe the detail job purpose.",
    );
    expect(result.content).toContain("Every day at 2:30 PM");
    expect(result.content).toContain("Message: Afternoon check");
    expect(result.content).toContain("Enabled: true");
    expect(result.content).toContain("No runs yet");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleList({ job_id: "nonexistent" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });
});

// ── schedule_list with one-shot schedules ────────────────────────────

describe("schedule_list with one-shot schedules", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows one-shot schedule with fire time in list mode", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot Event",
        fire_at: futureDate,
        message: "fire test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("One-shot Event");
    expect(result.content).toContain("Test schedule description");
    expect(result.content).toContain("one-shot");
    expect(result.content).toContain("fire at:");
    expect(result.content).toContain("active");
  });

  test("shows one-shot detail view with type and status", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot Detail",
        fire_at: futureDate,
        message: "detail test",
        mode: "notify",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Type: one-shot");
    expect(result.content).toContain("Mode: notify");
    expect(result.content).toContain("Status: active");
    expect(result.content).toContain("Fire at:");
  });

  test("shows mode in list output for recurring schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Recurring with mode",
        expression: "0 9 * * *",
        message: "test",
        mode: "notify",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("notify");
  });

  test("shows routing intent in detail when not default", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "Routed One-shot",
        fire_at: futureDate,
        message: "routed test",
        routing_intent: "single_channel",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: single_channel");
  });

  test("hides routing intent in detail when it is the default", async () => {
    await executeScheduleCreate(
      {
        name: "Default Routing",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Routing:");
  });
});

// ── schedule_update ─────────────────────────────────────────────────

describe("schedule_update tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates the name of a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Old Name",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        name: "New Name",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("New Name");
  });

  test("updates the description of a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Description update",
        description: "Original purpose.",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        description: "Updated purpose.",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Description: Updated purpose.");

    const dbRow = getRawDb()
      .query("SELECT description FROM cron_jobs WHERE id = ?")
      .get(row.id) as { description: string };
    expect(dbRow.description).toBe("Updated purpose.");
  });

  test("updates the cron expression", async () => {
    await executeScheduleCreate(
      {
        name: "Timing Test",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "0 17 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Every day at 5:00 PM");
  });

  test("disables a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Disable Me",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        enabled: false,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enabled: false");
    expect(result.content).toContain("n/a (disabled)");
  });

  test("rejects missing job_id", async () => {
    const result = await executeScheduleUpdate({ name: "test" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("job_id is required");
  });

  test("rejects update with no fields", async () => {
    await executeScheduleCreate(
      {
        name: "No Update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate({ job_id: row.id }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No updates provided");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleUpdate(
      {
        job_id: "nonexistent",
        name: "test",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });

  test("rejects invalid cron expression in update", async () => {
    await executeScheduleCreate(
      {
        name: "Bad Update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "cron",
        expression: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid cron expression");
  });

  test("rejects non-guardian actors", async () => {
    const result = await executeScheduleUpdate(
      {
        job_id: "nonexistent-id",
        message: "injected",
      },
      trustedCtx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian actors");
  });
});

// ── schedule_update with mode and routing ────────────────────────────

describe("schedule_update with mode and routing", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates mode", async () => {
    await executeScheduleCreate(
      {
        name: "Mode update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        mode: "notify",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: notify");
  });

  test("updates routing_intent", async () => {
    await executeScheduleCreate(
      {
        name: "Routing update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_intent: "single_channel",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");

    // Verify in DB
    const dbRow = getRawDb()
      .query("SELECT routing_intent FROM cron_jobs WHERE id = ?")
      .get(row.id) as { routing_intent: string };
    expect(dbRow.routing_intent).toBe("single_channel");
  });

  test("updates routing_hints", async () => {
    await executeScheduleCreate(
      {
        name: "Hints update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_hints: { channel: "telegram" },
      },
      ctx,
    );

    expect(result.isError).toBe(false);

    const dbRow = getRawDb()
      .query("SELECT routing_hints_json FROM cron_jobs WHERE id = ?")
      .get(row.id) as { routing_hints_json: string };
    expect(JSON.parse(dbRow.routing_hints_json)).toEqual({
      channel: "telegram",
    });
  });

  test("rejects invalid mode", async () => {
    await executeScheduleCreate(
      {
        name: "Bad mode",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        mode: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mode must be one of");
  });

  test("rejects invalid routing_intent", async () => {
    await executeScheduleCreate(
      {
        name: "Bad routing",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        routing_intent: "invalid",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("routing_intent must be one of");
  });

  test("prevents changing one-shot to recurring", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await executeScheduleCreate(
      {
        name: "One-shot",
        fire_at: futureDate,
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "0 9 * * *",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Cannot change a one-shot schedule to recurring",
    );
  });

  test("prevents changing recurring to one-shot", async () => {
    await executeScheduleCreate(
      {
        name: "Recurring",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        fire_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Cannot change a recurring schedule to one-shot",
    );
  });
});

// ── RRULE support in schedule tools ─────────────────────────────────

describe("schedule_create with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE syntax + expression", async () => {
    const result = await executeScheduleCreate(
      {
        name: "RRULE daily",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "RRULE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("auto-detects RRULE syntax when syntax is omitted", async () => {
    const result = await executeScheduleCreate(
      {
        name: "Auto-detect RRULE",
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
        message: "Auto-detect test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });

  test("rejects RRULE missing DTSTART with deterministic message", async () => {
    const result = await executeScheduleCreate(
      {
        name: "No DTSTART",
        syntax: "rrule",
        expression: "RRULE:FREQ=DAILY",
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DTSTART");
    expect(result.content).toContain("deterministic");
  });
});

describe("schedule_update with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("switches a cron schedule to rrule", async () => {
    await executeScheduleCreate(
      {
        name: "Cron to RRULE",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("auto-detects rrule syntax when updating expression without explicit syntax", async () => {
    await executeScheduleCreate(
      {
        name: "Auto-detect on update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });

  test("auto-detects cron syntax when updating expression without explicit syntax", async () => {
    await executeScheduleCreate(
      {
        name: "Cron auto-detect",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        expression: "30 17 * * 1-5",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: cron");
  });
});

describe("schedule_list with RRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows syntax-aware output for cron schedules", async () => {
    await executeScheduleCreate(
      {
        name: "Cron Job",
        expression: "0 9 * * 1-5",
        message: "Cron test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[cron]");
    expect(result.content).toContain("Every weekday at 9:00 AM");
  });

  test("shows syntax-aware output for rrule schedules", async () => {
    await executeScheduleCreate(
      {
        name: "RRULE Job",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "RRULE test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[rrule]");
    expect(result.content).toContain("RRULE:FREQ=DAILY");
  });

  test("shows syntax and expression in detail mode", async () => {
    await executeScheduleCreate(
      {
        name: "Detail RRULE",
        syntax: "rrule",
        expression: "DTSTART:20250601T120000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
        message: "Detail test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleList({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Syntax: rrule");
    expect(result.content).toContain("Expression:");
    expect(result.content).toContain("RRULE:FREQ=WEEKLY");
  });
});

// ── RRULE set support in schedule tools ──────────────────────────────

describe("schedule_create with RRULE set (EXDATE)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE + EXDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Daily with exclusion",
        syntax: "rrule",
        expression,
        message: "RRULE set test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("creates a schedule with RRULE + RDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE:20250115T090000Z",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Weekly with extra date",
        syntax: "rrule",
        expression,
        message: "RDATE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
  });

  test("rejects unsupported line types in RRULE set", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY",
      "VTIMEZONE:America/New_York",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Bad set line",
        syntax: "rrule",
        expression,
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported recurrence line");
    expect(result.content).toContain("Supported line types");
  });

  test("rejects RRULE set missing DTSTART", async () => {
    const expression = ["RRULE:FREQ=DAILY", "EXDATE:20250102T090000Z"].join(
      "\n",
    );

    const result = await executeScheduleCreate(
      {
        name: "Set without DTSTART",
        syntax: "rrule",
        expression,
        message: "Should fail",
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DTSTART");
  });
});

describe("schedule_update with RRULE set", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("updates a cron schedule to RRULE set with EXDATE", async () => {
    await executeScheduleCreate(
      {
        name: "Cron to set",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression,
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule updated successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("rejects update with unsupported set lines", async () => {
    await executeScheduleCreate(
      {
        name: "Bad set update",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };

    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY",
      "VCALENDAR:BEGIN",
    ].join("\n");

    const result = await executeScheduleUpdate(
      {
        job_id: row.id,
        syntax: "rrule",
        expression,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported recurrence line");
    expect(result.content).toContain("Supported line types");
  });
});

describe("schedule_list with RRULE set", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("shows [RRULE set] label for schedules with EXDATE", async () => {
    const expression = [
      "DTSTART:20250101T090000Z",
      "RRULE:FREQ=DAILY;INTERVAL=1",
      "EXDATE:20250102T090000Z",
    ].join("\n");

    await executeScheduleCreate(
      {
        name: "Set Schedule",
        syntax: "rrule",
        expression,
        message: "set test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[RRULE set]");
  });

  test("does not show [RRULE set] label for simple RRULE", async () => {
    await executeScheduleCreate(
      {
        name: "Simple RRULE",
        syntax: "rrule",
        expression: "DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY",
        message: "simple test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("[RRULE set]");
  });
});

// ── EXRULE support in schedule tools ──────────────────────────────────

describe("schedule_create with RRULE + EXRULE", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("creates a schedule with RRULE + EXRULE", async () => {
    const expression = [
      "DTSTART:20990101T090000Z",
      "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "EXRULE:FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    ].join("\n");

    const result = await executeScheduleCreate(
      {
        name: "Weekday-only via EXRULE",
        syntax: "rrule",
        expression,
        message: "EXRULE test",
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("schedule created successfully");
    expect(result.content).toContain("Syntax: rrule");
  });

  test("list output shows [RRULE set] label for EXRULE expression", async () => {
    const expression = [
      "DTSTART:20990101T090000Z",
      "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      "EXRULE:FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    ].join("\n");

    await executeScheduleCreate(
      {
        name: "EXRULE Set Schedule",
        syntax: "rrule",
        expression,
        message: "EXRULE set test",
      },
      ctx,
    );

    const result = await executeScheduleList({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[RRULE set]");
  });
});

// ── schedule_delete ─────────────────────────────────────────────────

describe("schedule_delete tool", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
  });

  test("deletes a schedule", async () => {
    await executeScheduleCreate(
      {
        name: "Delete Me",
        expression: "0 9 * * *",
        message: "test",
      },
      ctx,
    );

    const row = getRawDb().query("SELECT id FROM cron_jobs LIMIT 1").get() as {
      id: string;
    };
    const result = await executeScheduleDelete({ job_id: row.id }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Schedule deleted");
    expect(result.content).toContain("Delete Me");

    // Verify it's actually gone
    const count = getRawDb()
      .query("SELECT COUNT(*) as c FROM cron_jobs")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("rejects missing job_id", async () => {
    const result = await executeScheduleDelete({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("job_id is required");
  });

  test("returns error for nonexistent job_id", async () => {
    const result = await executeScheduleDelete({ job_id: "nonexistent" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Schedule not found");
  });
});
