/**
 * Tests that deleting or wiping a conversation with an associated schedule
 * job also deletes the schedule, preventing orphaned scheduled automations.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/conversation-store.js", () => ({
  destroyActiveConversation: () => {},
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: () => 0,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
  regenerateResponse: async () => null,
}));

import type { Database } from "bun:sqlite";

import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { createSchedule, getSchedule } from "../schedule/schedule-store.js";

initializeDb();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

const deleteRoute = ROUTES.find(
  (r) => r.operationId === "deleteConversation",
)!;

const wipeRoute = ROUTES.find(
  (r) => r.operationId === "wipeConversation",
)!;

describe("DELETE /conversations/:id — schedule cleanup", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    getRawDb().run("DELETE FROM memory_graph_nodes");
    getRawDb().run("DELETE FROM memory_segments");
    getRawDb().run("DELETE FROM memory_summaries");
    getRawDb().run("DELETE FROM memory_embeddings");
    getRawDb().run("DELETE FROM memory_jobs");
    getRawDb().run("DELETE FROM tool_invocations");
    getRawDb().run("DELETE FROM llm_request_logs");
    getRawDb().run("DELETE FROM messages");
    getRawDb().run("DELETE FROM conversations");
  });

  test("deleting a conversation with a scheduleJobId removes the schedule", () => {
    const schedule = createSchedule({
      name: "Daily standup",
      expression: "0 9 * * 1-5",
      message: "Time for standup!",
    });

    const conv = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    expect(getSchedule(schedule.id)).not.toBeNull();

    deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).toBeNull();
    expect(getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation without a scheduleJobId does not affect schedules", () => {
    const schedule = createSchedule({
      name: "Unrelated schedule",
      expression: "0 12 * * *",
      message: "Noon check",
    });

    const conv = createConversation("no-schedule-conv");

    deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).not.toBeNull();
    expect(getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation with a schedule also removes its cron_runs", () => {
    const schedule = createSchedule({
      name: "Recurring job",
      expression: "0 9 * * *",
      message: "Daily task",
    });

    const conv = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    const now = Date.now();
    getRawDb()
      .query(
        `INSERT INTO cron_runs (id, job_id, conversation_id, status, started_at, created_at)
         VALUES ('run-1', ?, ?, 'ok', ?, ?)`,
      )
      .run(schedule.id, conv.id, now, now);

    const runBefore = getRawDb()
      .query("SELECT * FROM cron_runs WHERE id = 'run-1'")
      .get();
    expect(runBefore).not.toBeNull();

    deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).toBeNull();
    const runAfter = getRawDb()
      .query("SELECT * FROM cron_runs WHERE id = 'run-1'")
      .get();
    expect(runAfter).toBeNull();
  });

  test("deleting one of multiple conversations sharing a schedule preserves the schedule", () => {
    const schedule = createSchedule({
      name: "Recurring daily",
      expression: "0 9 * * *",
      message: "Daily task",
    });

    const conv1 = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });
    createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    deleteRoute.handler({
      pathParams: { id: conv1.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).not.toBeNull();
  });

  test("deleting one scheduled conversation does not affect other schedules", () => {
    const scheduleA = createSchedule({
      name: "Schedule A",
      expression: "0 9 * * *",
      message: "Task A",
    });
    const scheduleB = createSchedule({
      name: "Schedule B",
      expression: "0 17 * * *",
      message: "Task B",
    });

    const convA = createConversation({
      source: "schedule",
      scheduleJobId: scheduleA.id,
    });
    createConversation({
      source: "schedule",
      scheduleJobId: scheduleB.id,
    });

    deleteRoute.handler({
      pathParams: { id: convA.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(scheduleA.id)).toBeNull();
    expect(getSchedule(scheduleB.id)).not.toBeNull();
  });
});

describe("POST /conversations/:id/wipe — schedule cleanup", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    getRawDb().run("DELETE FROM memory_graph_nodes");
    getRawDb().run("DELETE FROM memory_segments");
    getRawDb().run("DELETE FROM memory_summaries");
    getRawDb().run("DELETE FROM memory_embeddings");
    getRawDb().run("DELETE FROM memory_jobs");
    getRawDb().run("DELETE FROM tool_invocations");
    getRawDb().run("DELETE FROM llm_request_logs");
    getRawDb().run("DELETE FROM messages");
    getRawDb().run("DELETE FROM conversations");
  });

  test("wiping a conversation with a scheduleJobId removes the schedule", () => {
    const schedule = createSchedule({
      name: "Wipe-test schedule",
      expression: "0 9 * * 1-5",
      message: "Time for standup!",
    });

    const conv = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    expect(getSchedule(schedule.id)).not.toBeNull();

    wipeRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).toBeNull();
  });

  test("wiping a conversation without a scheduleJobId does not affect schedules", () => {
    const schedule = createSchedule({
      name: "Unrelated schedule",
      expression: "0 12 * * *",
      message: "Noon check",
    });

    const conv = createConversation("no-schedule-wipe");

    wipeRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},

    });

    expect(getSchedule(schedule.id)).not.toBeNull();
  });
});
