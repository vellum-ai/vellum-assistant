import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "task-compiler-test-"));

mock.module("../util/platform.js", () => ({
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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

mock.module("./indexer.js", () => ({
  indexMessageNow: async () => ({ indexedSegments: 0, enqueuedJobs: 0 }),
}));

import type { Database } from "bun:sqlite";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  compileTaskFromConversation,
  saveCompiledTask,
} from "../tasks/task-compiler.js";
import { renderTemplate } from "../tasks/task-runner.js";
import { getTask } from "../tasks/task-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function createTestConversation(id: string): string {
  const raw = getRawDb();
  const now = Date.now();
  raw
    .query(
      `INSERT INTO conversations (id, title, created_at, updated_at, thread_type, memory_scope_id) VALUES (?, 'Test', ?, ?, 'standard', 'default')`,
    )
    .run(id, now, now);
  return id;
}

function addTestMessage(
  conversationId: string,
  role: string,
  content: string,
): void {
  const raw = getRawDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, role, content, now);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("compileTaskFromConversation", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM task_runs");
    raw.run("DELETE FROM tasks");
    raw.run("DELETE FROM messages");
    raw.run("DELETE FROM conversations");
  });

  test("extracts first user message as template basis", () => {
    const convId = createTestConversation("conv-1");
    addTestMessage(convId, "user", "Please summarize the document for me");
    addTestMessage(convId, "assistant", "Here is the summary...");

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.template).toBe("Please summarize the document for me");
    expect(compiled.title).toBe("Please summarize the document for me");
  });

  test("identifies tool names from assistant messages", () => {
    const convId = createTestConversation("conv-2");
    addTestMessage(convId, "user", "Read this file and fix the bug");
    addTestMessage(
      convId,
      "assistant",
      JSON.stringify([
        { type: "text", text: "Let me read the file." },
        {
          type: "tool_use",
          id: "tu1",
          name: "read_file",
          input: { path: "/tmp/foo.ts" },
        },
      ]),
    );
    addTestMessage(
      convId,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu2",
          name: "write_file",
          input: { path: "/tmp/foo.ts", content: "..." },
        },
      ]),
    );
    // Duplicate tool_use should only appear once
    addTestMessage(
      convId,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu3",
          name: "read_file",
          input: { path: "/tmp/bar.ts" },
        },
      ]),
    );

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.requiredTools).toContain("read_file");
    expect(compiled.requiredTools).toContain("write_file");
    expect(compiled.requiredTools).toHaveLength(2);
  });

  test("replaces file paths in template with placeholders", () => {
    const convId = createTestConversation("conv-3");
    addTestMessage(
      convId,
      "user",
      "Please lint the file at /Users/alice/project/main.ts",
    );
    addTestMessage(convId, "assistant", "Done!");

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.template).toBe("Please lint the file at {{file_path}}");
    expect(compiled.inputSchema).toBeTruthy();
    expect((compiled.inputSchema as Record<string, unknown>).type).toBe(
      "object",
    );
    const props = (compiled.inputSchema as Record<string, unknown>)
      .properties as Record<string, Record<string, string>>;
    expect(props.file_path.type).toBe("string");
  });

  test("replaces URLs in template with placeholders", () => {
    const convId = createTestConversation("conv-4");
    addTestMessage(
      convId,
      "user",
      "Fetch data from https://api.example.com/data and save it",
    );
    addTestMessage(convId, "assistant", "Done!");

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.template).toBe("Fetch data from {{url}} and save it");
    expect(compiled.inputSchema).toBeTruthy();
    const props = (compiled.inputSchema as Record<string, unknown>)
      .properties as Record<string, Record<string, string>>;
    expect(props.url.type).toBe("string");
  });

  test("renderTemplate roundtrip with compiled template", () => {
    const convId = createTestConversation("conv-5");
    addTestMessage(
      convId,
      "user",
      "Deploy /Users/alice/project/app to https://prod.example.com/api",
    );
    addTestMessage(convId, "assistant", "Deployed!");

    const compiled = compileTaskFromConversation(convId);

    // Template should have placeholders
    expect(compiled.template).toContain("{{file_path}}");
    expect(compiled.template).toContain("{{url}}");

    // Render with concrete values
    const rendered = renderTemplate(compiled.template, {
      file_path: "/Users/bob/other/app",
      url: "https://staging.example.com/api",
    });

    expect(rendered).toBe(
      "Deploy /Users/bob/other/app to https://staging.example.com/api",
    );
  });

  test("handles conversation with no tool use", () => {
    const convId = createTestConversation("conv-6");
    addTestMessage(convId, "user", "What is the meaning of life?");
    addTestMessage(convId, "assistant", "42");

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.requiredTools).toEqual([]);
    expect(compiled.template).toBe("What is the meaning of life?");
    expect(compiled.contextFlags).toEqual([]);
  });

  test("throws on empty conversation", () => {
    const convId = createTestConversation("conv-7");

    expect(() => compileTaskFromConversation(convId)).toThrow(
      "No messages found for conversation: conv-7",
    );
  });

  test("throws when no user messages exist", () => {
    const convId = createTestConversation("conv-8");
    addTestMessage(convId, "assistant", "Hello there");

    expect(() => compileTaskFromConversation(convId)).toThrow(
      "No user messages found in conversation: conv-8",
    );
  });

  test("truncates long titles to 60 characters", () => {
    const convId = createTestConversation("conv-9");
    const longMessage = "A".repeat(100);
    addTestMessage(convId, "user", longMessage);

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.title.length).toBe(60);
    expect(compiled.title).toBe("A".repeat(57) + "...");
  });

  test("handles JSON content blocks in user message", () => {
    const convId = createTestConversation("conv-10");
    addTestMessage(
      convId,
      "user",
      JSON.stringify([
        { type: "text", text: "Please analyze this data" },
        { type: "text", text: " and create a report" },
      ]),
    );

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.template).toBe(
      "Please analyze this data\n and create a report",
    );
  });

  test("returns null inputSchema when no placeholders are found", () => {
    const convId = createTestConversation("conv-11");
    addTestMessage(convId, "user", "List all running processes");

    const compiled = compileTaskFromConversation(convId);

    expect(compiled.inputSchema).toBeNull();
  });
});

// ── saveCompiledTask ────────────────────────────────────────────────

describe("saveCompiledTask", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM task_runs");
    raw.run("DELETE FROM tasks");
    raw.run("DELETE FROM messages");
    raw.run("DELETE FROM conversations");
  });

  test("creates a task in the database from compiled output", () => {
    const convId = createTestConversation("conv-save-1");
    addTestMessage(convId, "user", "Read /Users/alice/file.txt and summarize");
    addTestMessage(
      convId,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu1",
          name: "read_file",
          input: { path: "/tmp/x" },
        },
      ]),
    );

    const compiled = compileTaskFromConversation(convId);
    const task = saveCompiledTask(compiled, convId);

    expect(task.id).toBeTruthy();
    expect(task.title).toBe(compiled.title);
    expect(task.template).toBe(compiled.template);
    expect(task.status).toBe("active");
    expect(task.createdFromConversationId).toBe(convId);

    // Verify it persists to DB
    const fetched = getTask(task.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.title).toBe(compiled.title);
    expect(fetched!.template).toBe(compiled.template);

    // Verify required tools are stored as JSON
    const tools = JSON.parse(fetched!.requiredTools!);
    expect(tools).toContain("read_file");
  });
});
