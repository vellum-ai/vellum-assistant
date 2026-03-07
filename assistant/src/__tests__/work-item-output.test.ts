import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "work-item-output-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

mock.module("./indexer.js", () => ({
  indexMessageNow: () => {},
}));

import type { HandlerContext } from "../daemon/handlers/shared.js";
import { handleWorkItemOutput } from "../daemon/handlers/work-items.js";
import {
  addMessage,
  createConversation,
} from "../memory/conversation-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createTask,
  createTaskRun,
  updateTaskRun,
} from "../tasks/task-store.js";
import {
  createWorkItem,
  updateWorkItem,
} from "../work-items/work-item-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

describe("handleWorkItemOutput", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM task_runs");
    raw.run("DELETE FROM work_items");
    raw.run("DELETE FROM tasks");
    raw.run("DELETE FROM messages");
    raw.run("DELETE FROM conversations");
  });

  test("uses only the latest assistant text block for summary output", () => {
    const task = createTask({
      title: "Delete weather report",
      template: "Delete weather_report_task.txt",
    });
    const run = createTaskRun(task.id);
    const item = createWorkItem({
      taskId: task.id,
      title: "Delete weather_report_task.txt",
    });
    const conversation = createConversation("Task output test");

    updateTaskRun(run.id, {
      status: "completed",
      conversationId: conversation.id,
      finishedAt: Date.now(),
    });
    updateWorkItem(item.id, {
      status: "awaiting_review",
      lastRunId: run.id,
      lastRunConversationId: conversation.id,
      lastRunStatus: "completed",
    });

    addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([
        {
          type: "text",
          text: "I'll need to delete the weather report file from your Documents folder. This will permanently remove it.",
        },
        {
          type: "text",
          text: "Looks like that file has already been deleted — it's no longer there. I'll mark this task as done.",
        },
        {
          type: "text",
          text: "The file is already deleted, so the task is complete.",
        },
      ]),
    );

    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const socket = {} as net.Socket;
    const ctx = {
      send: (
        _socket: net.Socket,
        msg: { type: string; [key: string]: unknown },
      ) => sent.push(msg),
    } as unknown as HandlerContext;

    handleWorkItemOutput(
      { type: "work_item_output", id: item.id },
      socket,
      ctx,
    );

    expect(sent).toHaveLength(1);
    const response = sent[0];
    expect(response.type).toBe("work_item_output_response");
    expect(response.success).toBe(true);
    expect((response.output as { summary: string }).summary).toBe(
      "The file is already deleted, so the task is complete.",
    );
  });
});
