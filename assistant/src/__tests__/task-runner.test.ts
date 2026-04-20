import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { ruleScope } from "@vellumai/ces-contracts";

import { getDb, initializeDb } from "../memory/db.js";
import { getTaskRunRules } from "../tasks/ephemeral-permissions.js";
import { renderTemplate, runTask } from "../tasks/task-runner.js";
import { createTask } from "../tasks/task-store.js";

initializeDb();

// ── renderTemplate ──────────────────────────────────────────────────

describe("renderTemplate", () => {
  test("correctly substitutes placeholders", () => {
    const template = "Hello {{name}}, welcome to {{place}}!";
    const result = renderTemplate(template, {
      name: "Alice",
      place: "Wonderland",
    });
    expect(result).toBe("Hello Alice, welcome to Wonderland!");
  });

  test("replaces missing placeholders with <MISSING: key>", () => {
    const template = "Hello {{name}}, your id is {{id}}";
    const result = renderTemplate(template, { name: "Bob" });
    expect(result).toBe("Hello Bob, your id is <MISSING: id>");
  });

  test("handles template with no placeholders", () => {
    const template = "No placeholders here.";
    const result = renderTemplate(template, { key: "value" });
    expect(result).toBe("No placeholders here.");
  });

  test("replaces all missing placeholders with <MISSING: key>", () => {
    const template = "{{greeting}} world";
    const result = renderTemplate(template, {});
    expect(result).toBe("<MISSING: greeting> world");
  });

  test("input values containing {{key}} patterns are not double-interpolated", () => {
    // JavaScript String.replace with a regex callback is single-pass: it scans
    // the ORIGINAL template left-to-right, so substituted values are never
    // re-scanned for further matches. This test documents that guarantee.
    const template = "Message: {{body}}";
    const result = renderTemplate(template, {
      body: "hello {{secret}}",
      secret: "PRIVATE",
    });
    // The {{secret}} inside the value is not expanded — it remains literal.
    expect(result).toBe("Message: hello {{secret}}");
  });
});

// ── runTask ─────────────────────────────────────────────────────────

describe("runTask", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("creates a conversation and task run, calls processMessage with rendered template", async () => {
    const task = createTask({
      title: "Greet User",
      template: "Hello {{name}}, please do {{action}}",
      requiredTools: ["read_file"],
    });

    const processedMessages: { conversationId: string; message: string }[] = [];
    const mockProcess = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const result = await runTask(
      {
        taskId: task.id,
        inputs: { name: "Alice", action: "testing" },
        workingDir: "/tmp",
      },
      mockProcess,
    );

    expect(result.status).toBe("completed");
    expect(result.taskRunId).toBeTruthy();
    expect(result.conversationId).toBeTruthy();
    expect(result.error).toBeUndefined();

    // Verify processMessage was called with rendered template
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].message).toBe("Hello Alice, please do testing");
    expect(processedMessages[0].conversationId).toBe(result.conversationId);
  });

  test("sets up and cleans up ephemeral permissions", async () => {
    const task = createTask({
      title: "File Task",
      template: "Read the file",
      requiredTools: ["read_file", "write_file"],
    });

    let rulesWhileRunning: ReturnType<typeof getTaskRunRules> = [];
    let capturedTaskRunId = "";

    const mockProcess = async (_conversationId: string, _message: string) => {
      const db = getDb();
      const raw = (
        db as unknown as {
          $client: import("bun:sqlite").Database;
        }
      ).$client;
      const row = raw
        .query("SELECT id FROM task_runs WHERE task_id = ?")
        .get(task.id) as { id: string };
      capturedTaskRunId = row.id;
      rulesWhileRunning = getTaskRunRules(capturedTaskRunId);
    };

    await runTask({ taskId: task.id, workingDir: "/home/user" }, mockProcess);

    // During execution, rules should have been set
    expect(rulesWhileRunning).toHaveLength(2);
    expect(rulesWhileRunning[0].tool).toBe("read_file");
    expect(rulesWhileRunning[1].tool).toBe("write_file");
    expect(ruleScope(rulesWhileRunning[0])).toBe("everywhere");
    expect(rulesWhileRunning[0].decision).toBe("allow");
    expect(rulesWhileRunning[0].priority).toBe(75);

    // After execution, rules should be cleaned up
    const rulesAfter = getTaskRunRules(capturedTaskRunId);
    expect(rulesAfter).toHaveLength(0);
  });

  test("handles errors and sets failed status", async () => {
    const task = createTask({
      title: "Failing Task",
      template: "Do something",
    });

    const mockProcess = async (_conversationId: string, _message: string) => {
      throw new Error("Something went wrong");
    };

    const result = await runTask(
      { taskId: task.id, workingDir: "/tmp" },
      mockProcess,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Something went wrong");
    expect(result.taskRunId).toBeTruthy();
    expect(result.conversationId).toBeTruthy();
  });

  test("cleans up ephemeral rules even on error", async () => {
    const task = createTask({
      title: "Error Cleanup Task",
      template: "Do something",
      requiredTools: ["shell"],
    });

    let capturedTaskRunId = "";

    const mockProcess = async (_conversationId: string, _message: string) => {
      const db = getDb();
      const raw = (
        db as unknown as {
          $client: import("bun:sqlite").Database;
        }
      ).$client;
      const row = raw
        .query("SELECT id FROM task_runs WHERE task_id = ?")
        .get(task.id) as { id: string };
      capturedTaskRunId = row.id;

      // Verify rules are active during execution
      const rules = getTaskRunRules(capturedTaskRunId);
      expect(rules).toHaveLength(1);

      throw new Error("Boom");
    };

    await runTask({ taskId: task.id, workingDir: "/tmp" }, mockProcess);

    // Rules should be cleaned up in finally block
    const rulesAfter = getTaskRunRules(capturedTaskRunId);
    expect(rulesAfter).toHaveLength(0);
  });

  test("throws if task not found", async () => {
    const mockProcess = async (_conversationId: string, _message: string) => {};

    await expect(
      runTask({ taskId: "nonexistent-id", workingDir: "/tmp" }, mockProcess),
    ).rejects.toThrow("Task not found: nonexistent-id");
  });

  test("works with no required tools", async () => {
    const task = createTask({
      title: "Simple Task",
      template: "Just a message",
    });

    const mockProcess = async (_conversationId: string, _message: string) => {};

    const result = await runTask(
      { taskId: task.id, workingDir: "/tmp" },
      mockProcess,
    );

    expect(result.status).toBe("completed");
  });
});
