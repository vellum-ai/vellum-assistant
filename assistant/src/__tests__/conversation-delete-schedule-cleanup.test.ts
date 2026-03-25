/**
 * Tests that deleting a conversation with an associated schedule job
 * also deletes the schedule, preventing orphaned scheduled automations.
 *
 * Covers LUM-380: "Deleting a scheduled thread does not cancel its scheduled runs"
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "conv-delete-schedule-cleanup-test-"),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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

import type { Database } from "bun:sqlite";

import {
  createConversation,
  getConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversationManagementRouteDefinitions } from "../runtime/routes/conversation-management-routes.js";
import { createSchedule, getSchedule } from "../schedule/schedule-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/** Build route definitions with minimal deps. */
function getRoutes() {
  const routes = conversationManagementRouteDefinitions({
    switchConversation: async () => null,
    renameConversation: () => true,
    clearAllConversations: () => 0,
    cancelGeneration: () => true,
    destroyConversation: () => {},
    undoLastMessage: async () => null,
    regenerateResponse: async () => null,
  });
  return routes;
}

function getDeleteHandler() {
  const deleteRoute = getRoutes().find(
    (r) => r.endpoint === "conversations/:id" && r.method === "DELETE",
  );
  if (!deleteRoute) throw new Error("DELETE conversations/:id route not found");
  return deleteRoute.handler;
}

function getWipeHandler() {
  const wipeRoute = getRoutes().find(
    (r) => r.endpoint === "conversations/:id/wipe" && r.method === "POST",
  );
  if (!wipeRoute)
    throw new Error("POST conversations/:id/wipe route not found");
  return wipeRoute.handler;
}

describe("DELETE /conversations/:id — schedule cleanup (LUM-380)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    getRawDb().run("DELETE FROM memory_item_sources");
    getRawDb().run("DELETE FROM memory_segments");
    getRawDb().run("DELETE FROM memory_items");
    getRawDb().run("DELETE FROM memory_summaries");
    getRawDb().run("DELETE FROM memory_embeddings");
    getRawDb().run("DELETE FROM memory_jobs");
    getRawDb().run("DELETE FROM tool_invocations");
    getRawDb().run("DELETE FROM llm_request_logs");
    getRawDb().run("DELETE FROM messages");
    getRawDb().run("DELETE FROM conversations");
  });

  test("deleting a conversation with a scheduleJobId removes the schedule", async () => {
    // Create a schedule job
    const schedule = createSchedule({
      name: "Daily standup",
      expression: "0 9 * * 1-5",
      message: "Time for standup!",
    });

    // Create a conversation linked to that schedule
    const conv = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    // Verify the schedule exists
    expect(getSchedule(schedule.id)).not.toBeNull();

    // Call the DELETE handler
    const handler = getDeleteHandler();
    const req = new Request(`http://localhost/v1/conversations/${conv.id}`, {
      method: "DELETE",
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: conv.id },
    });

    expect(response.status).toBe(204);

    // Schedule should be deleted
    expect(getSchedule(schedule.id)).toBeNull();

    // Conversation should be deleted
    expect(getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation without a scheduleJobId does not affect schedules", async () => {
    // Create a schedule job (not linked to any conversation)
    const schedule = createSchedule({
      name: "Unrelated schedule",
      expression: "0 12 * * *",
      message: "Noon check",
    });

    // Create a conversation with no schedule link
    const conv = createConversation("no-schedule-conv");

    // Call the DELETE handler
    const handler = getDeleteHandler();
    const req = new Request(`http://localhost/v1/conversations/${conv.id}`, {
      method: "DELETE",
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: conv.id },
    });

    expect(response.status).toBe(204);

    // Unrelated schedule should still exist
    expect(getSchedule(schedule.id)).not.toBeNull();

    // Conversation should be deleted
    expect(getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation with a schedule also removes its cron_runs", async () => {
    // Create a schedule job
    const schedule = createSchedule({
      name: "Recurring job",
      expression: "0 9 * * *",
      message: "Daily task",
    });

    // Create a conversation linked to the schedule
    const conv = createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    // Insert a cron_run record for this schedule
    const now = Date.now();
    getRawDb()
      .query(
        `INSERT INTO cron_runs (id, job_id, conversation_id, status, started_at, created_at)
         VALUES ('run-1', ?, ?, 'ok', ?, ?)`,
      )
      .run(schedule.id, conv.id, now, now);

    // Verify the run exists
    const runBefore = getRawDb()
      .query("SELECT * FROM cron_runs WHERE id = 'run-1'")
      .get();
    expect(runBefore).not.toBeNull();

    // Call the DELETE handler
    const handler = getDeleteHandler();
    const req = new Request(`http://localhost/v1/conversations/${conv.id}`, {
      method: "DELETE",
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: conv.id },
    });

    expect(response.status).toBe(204);

    // Schedule and its runs should be deleted (FK cascade)
    expect(getSchedule(schedule.id)).toBeNull();
    const runAfter = getRawDb()
      .query("SELECT * FROM cron_runs WHERE id = 'run-1'")
      .get();
    expect(runAfter).toBeNull();
  });

  test("deleting one scheduled conversation does not affect other schedules", async () => {
    // Create two separate schedules
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

    // Create conversations linked to each schedule
    const convA = createConversation({
      source: "schedule",
      scheduleJobId: scheduleA.id,
    });
    createConversation({
      source: "schedule",
      scheduleJobId: scheduleB.id,
    });

    // Delete only conversation A
    const handler = getDeleteHandler();
    const req = new Request(`http://localhost/v1/conversations/${convA.id}`, {
      method: "DELETE",
    });
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: convA.id },
    });

    expect(response.status).toBe(204);

    // Schedule A should be deleted
    expect(getSchedule(scheduleA.id)).toBeNull();

    // Schedule B should still exist
    expect(getSchedule(scheduleB.id)).not.toBeNull();
  });
});

describe("POST /conversations/:id/wipe — schedule cleanup (LUM-380)", () => {
  beforeEach(() => {
    getRawDb().run("DELETE FROM cron_runs");
    getRawDb().run("DELETE FROM cron_jobs");
    getRawDb().run("DELETE FROM memory_item_sources");
    getRawDb().run("DELETE FROM memory_segments");
    getRawDb().run("DELETE FROM memory_items");
    getRawDb().run("DELETE FROM memory_summaries");
    getRawDb().run("DELETE FROM memory_embeddings");
    getRawDb().run("DELETE FROM memory_jobs");
    getRawDb().run("DELETE FROM tool_invocations");
    getRawDb().run("DELETE FROM llm_request_logs");
    getRawDb().run("DELETE FROM messages");
    getRawDb().run("DELETE FROM conversations");
  });

  test("wiping a conversation with a scheduleJobId removes the schedule", async () => {
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

    const handler = getWipeHandler();
    const req = new Request(
      `http://localhost/v1/conversations/${conv.id}/wipe`,
      { method: "POST" },
    );
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: conv.id },
    });

    expect(response.status).toBe(200);

    // Schedule should be deleted
    expect(getSchedule(schedule.id)).toBeNull();
  });

  test("wiping a conversation without a scheduleJobId does not affect schedules", async () => {
    const schedule = createSchedule({
      name: "Unrelated schedule",
      expression: "0 12 * * *",
      message: "Noon check",
    });

    const conv = createConversation("no-schedule-wipe");

    const handler = getWipeHandler();
    const req = new Request(
      `http://localhost/v1/conversations/${conv.id}/wipe`,
      { method: "POST" },
    );
    const response = await handler({
      req,
      url: new URL(req.url),
      server: {} as never,
      authContext: undefined as never,
      params: { id: conv.id },
    });

    expect(response.status).toBe(200);

    // Unrelated schedule should still exist
    expect(getSchedule(schedule.id)).not.toBeNull();
  });
});
