/**
 * Tests for the `assistant task` CLI command.
 *
 * Validates:
 *   - Template subcommands: list, save, run, delete
 *   - Queue subcommands: show, add, update, remove, run
 *   - Conversation ID resolution (explicit, __SKILL_CONTEXT_JSON, __CONVERSATION_ID)
 *   - --json output mode for both template and queue commands
 *   - Error propagation (IPC failure -> exitCode 1)
 *   - --required-tools comma-splitting for queue add
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
 
let lastIpcCall: {
  method: string;
  params?: any;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerTaskCommand } = await import("../task.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerTaskCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Saved env vars to restore after each test. */
let savedConvId: string | undefined;
let savedSkillCtx: string | undefined;

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
  process.exitCode = 0;

  // Save and clear env vars that resolveConversationId reads
  savedConvId = process.env.__CONVERSATION_ID;
  savedSkillCtx = process.env.__SKILL_CONTEXT_JSON;
  delete process.env.__CONVERSATION_ID;
  delete process.env.__SKILL_CONTEXT_JSON;
});

// Restore env vars after each test
import { afterEach } from "bun:test";

afterEach(() => {
  if (savedConvId !== undefined) {
    process.env.__CONVERSATION_ID = savedConvId;
  } else {
    delete process.env.__CONVERSATION_ID;
  }
  if (savedSkillCtx !== undefined) {
    process.env.__SKILL_CONTEXT_JSON = savedSkillCtx;
  } else {
    delete process.env.__SKILL_CONTEXT_JSON;
  }
});

// ===========================================================================
// Template subcommands
// ===========================================================================

// ---------------------------------------------------------------------------
// task list
// ---------------------------------------------------------------------------

describe("task list", () => {
  test("calls task/list IPC and succeeds", async () => {
    mockIpcResult = {
      ok: true,
      result: [{ id: "t1", name: "deploy" }],
    };

    const { exitCode } = await runCommand(["task", "list"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_list");
  });

  test("--json outputs { ok: true, result: ... }", async () => {
    mockIpcResult = {
      ok: true,
      result: [{ id: "t1", name: "deploy" }],
    };

    const { exitCode, stdout } = await runCommand(["task", "list", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      result: [{ id: "t1", name: "deploy" }],
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["task", "list"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task save
// ---------------------------------------------------------------------------

describe("task save", () => {
  test("calls task/save with explicit --conversation-id and --title", async () => {
    mockIpcResult = { ok: true, result: { id: "task-1" } };

    const { exitCode } = await runCommand([
      "task",
      "save",
      "--conversation-id",
      "conv-123",
      "--title",
      "My Task",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_save");
    expect(lastIpcCall!.params!.body).toEqual({
      conversation_id: "conv-123",
      title: "My Task",
    });
  });

  test("resolves conversation ID from __CONVERSATION_ID env var", async () => {
    process.env.__CONVERSATION_ID = "env-conv-456";
    mockIpcResult = { ok: true, result: { id: "task-2" } };

    const { exitCode } = await runCommand(["task", "save"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("task_save");
    expect(lastIpcCall!.params!.body!.conversation_id).toBe("env-conv-456");
  });

  test("prefers __SKILL_CONTEXT_JSON over __CONVERSATION_ID", async () => {
    process.env.__CONVERSATION_ID = "env-conv-should-not-use";
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "skill-conv-789",
    });
    mockIpcResult = { ok: true, result: { id: "task-3" } };

    const { exitCode } = await runCommand(["task", "save"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.conversation_id).toBe("skill-conv-789");
  });

  test("exits with error when no conversation ID is available", async () => {
    // No env vars set, no explicit flag
    const { exitCode } = await runCommand(["task", "save"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error when no conversation ID is available", async () => {
    const { exitCode, stdout } = await runCommand(["task", "save", "--json"]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No conversation ID");
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    process.env.__CONVERSATION_ID = "conv-json-test";
    mockIpcResult = { ok: true, result: { id: "task-json" } };

    const { exitCode, stdout } = await runCommand(["task", "save", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { id: "task-json" } });
  });

  test("IPC failure sets exitCode 1", async () => {
    process.env.__CONVERSATION_ID = "conv-fail";
    mockIpcResult = { ok: false, error: "Internal error" };

    const { exitCode } = await runCommand(["task", "save"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task run
// ---------------------------------------------------------------------------

describe("task run", () => {
  test("calls task/run with --name and --inputs", async () => {
    mockIpcResult = { ok: true, result: { conversationId: "c1" } };

    const { exitCode } = await runCommand([
      "task",
      "run",
      "--name",
      "deploy",
      "--inputs",
      '{"env":"prod"}',
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_run");
    expect(lastIpcCall!.params!.body).toEqual({
      task_name: "deploy",
      inputs: { env: "prod" },
    });
  });

  test("calls task/run with --id", async () => {
    mockIpcResult = { ok: true, result: { conversationId: "c2" } };

    const { exitCode } = await runCommand([
      "task",
      "run",
      "--id",
      "task_abc123",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body).toEqual({ task_id: "task_abc123" });
  });

  test("exits with error on invalid JSON --inputs", async () => {
    const { exitCode } = await runCommand([
      "task",
      "run",
      "--name",
      "deploy",
      "--inputs",
      "{bad json}",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error on invalid --inputs", async () => {
    const { exitCode, stdout } = await runCommand([
      "task",
      "run",
      "--name",
      "deploy",
      "--inputs",
      "{bad}",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid JSON for --inputs");
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = { ok: true, result: { conversationId: "c3" } };

    const { exitCode, stdout } = await runCommand([
      "task",
      "run",
      "--name",
      "deploy",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      result: { conversationId: "c3" },
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Task not found" };

    const { exitCode } = await runCommand([
      "task",
      "run",
      "--name",
      "nonexistent",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task delete
// ---------------------------------------------------------------------------

describe("task delete", () => {
  test("passes variadic IDs as task_ids array", async () => {
    mockIpcResult = { ok: true, result: { deleted: 2 } };

    const { exitCode } = await runCommand(["task", "delete", "id1", "id2"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_delete");
    expect(lastIpcCall!.params!.body).toEqual({ task_ids: ["id1", "id2"] });
  });

  test("passes single ID as task_ids array", async () => {
    mockIpcResult = { ok: true, result: { deleted: 1 } };

    const { exitCode } = await runCommand(["task", "delete", "id1"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body).toEqual({ task_ids: ["id1"] });
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = { ok: true, result: { deleted: 1 } };

    const { exitCode, stdout } = await runCommand([
      "task",
      "delete",
      "id1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { deleted: 1 } });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand(["task", "delete", "id1"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode, stdout } = await runCommand([
      "task",
      "delete",
      "id1",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Not found" });
  });
});

// ===========================================================================
// Queue subcommands
// ===========================================================================

// ---------------------------------------------------------------------------
// task queue show
// ---------------------------------------------------------------------------

describe("task queue show", () => {
  test("calls task/queue/show IPC with no params", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "No items in queue" },
    };

    const { exitCode } = await runCommand(["task", "queue", "show"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_queue_show");
    expect(lastIpcCall!.params!.body).toEqual({});
  });

  test("passes --status filter", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "1 queued item" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "show",
      "--status",
      "queued",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body).toEqual({ status: "queued" });
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "items" },
    };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "show",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { content: "items" } });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["task", "queue", "show"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task queue add
// ---------------------------------------------------------------------------

describe("task queue add", () => {
  test("maps flags to snake_case params", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Added" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Fix bug",
      "--priority",
      "0",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_queue_add");
    expect(lastIpcCall!.params!.body!.title).toBe("Fix bug");
    expect(lastIpcCall!.params!.body!.priority_tier).toBe(0);
  });

  test("splits --required-tools by comma", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Added" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Build",
      "--required-tools",
      "host_bash,host_file_read",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.required_tools).toEqual([
      "host_bash",
      "host_file_read",
    ]);
  });

  test("handles --required-tools with spaces after commas", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Added" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Build",
      "--required-tools",
      "host_bash, host_file_read, browser",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.required_tools).toEqual([
      "host_bash",
      "host_file_read",
      "browser",
    ]);
  });

  test("passes --if-exists strategy", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Reused" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Deploy",
      "--if-exists",
      "reuse_existing",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.if_exists).toBe("reuse_existing");
  });

  test("passes --name as task_name", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Added" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--name",
      "Deploy workflow",
      "--title",
      "Deploy v2",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.task_name).toBe("Deploy workflow");
    expect(lastIpcCall!.params!.body!.title).toBe("Deploy v2");
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Added item" },
    };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Test",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { content: "Added item" } });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Internal error" };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "add",
      "--title",
      "Test",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task queue update
// ---------------------------------------------------------------------------

describe("task queue update", () => {
  test("passes --work-item-id and --status", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Updated" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "update",
      "--work-item-id",
      "wi-1",
      "--status",
      "done",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_queue_update");
    expect(lastIpcCall!.params!.body!.work_item_id).toBe("wi-1");
    expect(lastIpcCall!.params!.body!.status).toBe("done");
  });

  test("passes --priority as priority_tier", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Updated" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "update",
      "--work-item-id",
      "wi-2",
      "--priority",
      "1",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.priority_tier).toBe(1);
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Updated" },
    };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "update",
      "--work-item-id",
      "wi-1",
      "--status",
      "done",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { content: "Updated" } });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "update",
      "--work-item-id",
      "wi-1",
      "--status",
      "done",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task queue remove
// ---------------------------------------------------------------------------

describe("task queue remove", () => {
  test("passes --title filter", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Removed" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "remove",
      "--title",
      "Fix bug",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_queue_remove");
    expect(lastIpcCall!.params!.body!.title).toBe("Fix bug");
  });

  test("passes --work-item-id", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Removed" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "remove",
      "--work-item-id",
      "wi-abc",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.body!.work_item_id).toBe("wi-abc");
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Removed 1 item" },
    };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "remove",
      "--title",
      "Fix bug",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      result: { content: "Removed 1 item" },
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "Queue error" };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "remove",
      "--title",
      "Fix bug",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task queue run
// ---------------------------------------------------------------------------

describe("task queue run", () => {
  test("calls task/queue/run with --work-item-id", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Running" },
    };

    const { exitCode } = await runCommand([
      "task",
      "queue",
      "run",
      "--work-item-id",
      "wi-1",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("task_queue_run");
    expect(lastIpcCall!.params!.body!.work_item_id).toBe("wi-1");
  });

  test("calls task/queue/run with no params (next eligible)", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Running next item" },
    };

    const { exitCode } = await runCommand(["task", "queue", "run"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("task_queue_run");
    expect(lastIpcCall!.params!.body).toEqual({});
  });

  test("--json outputs { ok: true, result: ... } on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Running" },
    };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "run",
      "--work-item-id",
      "wi-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, result: { content: "Running" } });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResult = { ok: false, error: "No items available" };

    const { exitCode } = await runCommand(["task", "queue", "run"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "No items available" };

    const { exitCode, stdout } = await runCommand([
      "task",
      "queue",
      "run",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "No items available" });
  });
});
