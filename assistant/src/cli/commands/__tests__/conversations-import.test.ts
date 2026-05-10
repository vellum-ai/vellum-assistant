/**
 * Tests for the `assistant conversations import` CLI command.
 *
 * Validates:
 *   - Valid input → cliIpcCall("conversations_import", { conversations: [...] })
 *   - Empty conversations array → cliIpcCall NOT called, human output
 *   - Invalid JSON → cliIpcCall NOT called, process.exitCode = 1
 *   - Missing required fields → cliIpcCall NOT called, process.exitCode = 1
 *   - IPC error → exitFromIpcResult called
 *   - Success + --json → JSON output
 *   - Success without --json → human readable output with skipped/errors
 *   - --file <path> → reads from file
 *   - Missing file → error and process.exitCode = 1
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = {
  ok: true,
  result: {
    ok: true,
    imported: 1,
    skipped: 0,
    messages: 2,
    errors: [],
  },
};

/** Whether exitFromIpcResult was called. */
let exitFromIpcResultCalled = false;

/** Log calls captured by the mocked logger. */
let mockLogInfo: string[] = [];
let mockLogError: string[] = [];

// ---------------------------------------------------------------------------
// Mocks (must be registered before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (_r: unknown) => {
    exitFromIpcResultCalled = true;
    process.exitCode = 1;
  },
}));

mock.module("../../logger.js", () => ({
  log: {
    info: (msg: string) => mockLogInfo.push(msg),
    warn: () => {},
    error: (msg: string) => mockLogError.push(msg),
    debug: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerConversationsImportCommand } = await import(
  "../conversations-import.js"
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Temp directory used for file-based tests. */
let tmpDir: string;

function makeTmpFile(content: string, filename = "import.json"): string {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

async function runCommand(args: string[]): Promise<{ exitCode: number }> {
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    const conversations = program.command("conversations");
    registerConversationsImportCommand(conversations);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode };
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "conv-import-test-"));
  lastIpcCall = null;
  exitFromIpcResultCalled = false;
  mockLogInfo = [];
  mockLogError = [];
  mockIpcResult = {
    ok: true,
    result: {
      ok: true,
      imported: 1,
      skipped: 0,
      messages: 2,
      errors: [],
    },
  };
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Valid import via --file
// ---------------------------------------------------------------------------

describe("conversations import — valid input", () => {
  test("calls conversations_import with conversations from --file", async () => {
    const payload = {
      conversations: [
        {
          title: "Test Chat",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
          ],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("conversations_import");
    expect(
      ((lastIpcCall!.params as Record<string, unknown>).body as Record<string, unknown>).conversations,
    ).toHaveLength(1);
  });

  test("with sourceKey passes it through to IPC", async () => {
    const payload = {
      conversations: [
        {
          sourceKey: "chatgpt:abc123",
          title: "Exported Chat",
          createdAt: 1700000000000,
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand(["conversations", "import", "--file", filePath]);

    expect(lastIpcCall).not.toBeNull();
    const convs = ((lastIpcCall!.params as Record<string, unknown>)
      .body as Record<string, unknown>).conversations as Array<Record<string, unknown>>;
    expect(convs[0]!.sourceKey).toBe("chatgpt:abc123");
    expect(convs[0]!.title).toBe("Exported Chat");
  });
});

// ---------------------------------------------------------------------------
// Empty conversations array
// ---------------------------------------------------------------------------

describe("conversations import — empty array", () => {
  test("does not call cliIpcCall for empty conversations array", async () => {
    const payload = { conversations: [] };
    const filePath = makeTmpFile(JSON.stringify(payload));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeNull();
    expect(mockLogInfo.some((m) => m.includes("No conversations to import"))).toBe(true);
  });

  test("--json outputs JSON for empty array without calling IPC", async () => {
    const payload = { conversations: [] };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
      "--json",
    ]);

    expect(lastIpcCall).toBeNull();
    const jsonOut = mockLogInfo.find((m) => m.startsWith("{"));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.ok).toBe(true);
    expect(parsed.imported).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON
// ---------------------------------------------------------------------------

describe("conversations import — invalid JSON", () => {
  test("does not call cliIpcCall for invalid JSON, sets exitCode=1", async () => {
    const filePath = makeTmpFile("this is not json");

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(mockLogError.some((m) => m.includes("Error:"))).toBe(true);
  });

  test("--json outputs error JSON for invalid JSON", async () => {
    const filePath = makeTmpFile("{bad json}");

    await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
      "--json",
    ]);

    expect(lastIpcCall).toBeNull();
    const jsonOut = mockLogInfo.find((m) => m.startsWith("{"));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("conversations import — validation errors", () => {
  test("missing title sets exitCode=1 and does not call IPC", async () => {
    const payload = {
      conversations: [
        {
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("empty messages array sets exitCode=1", async () => {
    const payload = {
      conversations: [{ title: "Chat", messages: [] }],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("missing message role sets exitCode=1", async () => {
    const payload = {
      conversations: [
        {
          title: "Chat",
          messages: [{ content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("non-object input sets exitCode=1", async () => {
    const filePath = makeTmpFile(JSON.stringify([1, 2, 3]));

    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      filePath,
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

describe("conversations import — file errors", () => {
  test("missing --file path sets exitCode=1", async () => {
    const { exitCode } = await runCommand([
      "conversations",
      "import",
      "--file",
      "/nonexistent/path/import.json",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(
      mockLogError.some((m) => m.includes("File not found")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IPC error
// ---------------------------------------------------------------------------

describe("conversations import — IPC error", () => {
  test("calls exitFromIpcResult on IPC failure", async () => {
    mockIpcResult = {
      ok: false,
      error: "Daemon not running",
      statusCode: undefined,
    };

    const payload = {
      conversations: [
        {
          title: "Test",
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand(["conversations", "import", "--file", filePath]);

    expect(lastIpcCall).not.toBeNull();
    expect(exitFromIpcResultCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Success output formats
// ---------------------------------------------------------------------------

describe("conversations import — output formats", () => {
  test("success without --json outputs human-readable summary", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ok: true,
        imported: 3,
        skipped: 1,
        messages: 10,
        errors: [],
      },
    };

    const payload = {
      conversations: [
        {
          title: "Chat 1",
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand(["conversations", "import", "--file", filePath]);

    const out = mockLogInfo.join("\n");
    expect(out).toContain("Imported 3 conversation(s)");
    expect(out).toContain("10 message(s)");
    expect(out).toContain("Skipped 1");
  });

  test("success with --json outputs structured JSON result", async () => {
    const resultPayload = {
      ok: true,
      imported: 2,
      skipped: 0,
      messages: 5,
      errors: [],
    };
    mockIpcResult = { ok: true, result: resultPayload };

    const payload = {
      conversations: [
        {
          title: "Chat",
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand(["conversations", "import", "--file", filePath, "--json"]);

    const jsonOut = mockLogInfo.find((m) => m.startsWith("{"));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.ok).toBe(true);
    expect(parsed.imported).toBe(2);
    expect(parsed.messages).toBe(5);
  });

  test("includes error count in human-readable output when errors exist", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ok: false,
        imported: 1,
        skipped: 0,
        messages: 2,
        errors: [{ index: 1, error: "something failed" }],
      },
    };

    const payload = {
      conversations: [
        {
          title: "Chat",
          messages: [{ role: "user", content: "Hello" }],
        },
      ],
    };
    const filePath = makeTmpFile(JSON.stringify(payload));

    await runCommand(["conversations", "import", "--file", filePath]);

    const out = mockLogInfo.join("\n");
    expect(out).toContain("Failed: 1 conversation(s)");
  });
});
