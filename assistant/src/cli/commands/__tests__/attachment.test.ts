/**
 * Tests for the `assistant attachment` CLI command.
 *
 * Validates:
 *   - Subcommand registration (register, lookup)
 *   - Help text rendering with examples
 *   - `register` success and error paths (JSON + plain)
 *   - `lookup` success and error paths (JSON + plain)
 *   - Exit codes on IPC failures
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
} = { ok: true, result: { id: "att-123" } };

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

const { registerAttachmentCommand } = await import("../attachment.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerAttachmentCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { id: "att-123" } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("attachment help", () => {
  test("attachment --help renders the command group with examples", async () => {
    const { stdout } = await runCommand(["attachment", "--help"]);
    expect(stdout).toContain("Manage file attachments");
    expect(stdout).toContain("register");
    expect(stdout).toContain("lookup");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("assistant attachment register");
    expect(stdout).toContain("assistant attachment lookup");
  });

  test("attachment register --help renders argument docs and examples", async () => {
    const { stdout } = await runCommand(["attachment", "register", "--help"]);
    expect(stdout).toContain("--path");
    expect(stdout).toContain("--mime");
    expect(stdout).toContain("--filename");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("must remain");
    expect(stdout).toContain("on disk");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("assistant attachment register --path");
  });

  test("attachment lookup --help renders argument docs and examples", async () => {
    const { stdout } = await runCommand(["attachment", "lookup", "--help"]);
    expect(stdout).toContain("--source");
    expect(stdout).toContain("--conversation");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("assistant conversations list");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("assistant attachment lookup");
  });
});

// ---------------------------------------------------------------------------
// register — success
// ---------------------------------------------------------------------------

describe("attachment register", () => {
  test("success: calls IPC and prints attachment ID", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "att-123",
        originalFilename: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        kind: "video",
        filePath: "/tmp/clip.mp4",
        createdAt: 1700000000000,
      },
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/clip.mp4",
      "--mime",
      "video/mp4",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("attachment_register");
    expect(lastIpcCall!.params).toEqual({
      body: {
        path: "/tmp/clip.mp4",
        mimeType: "video/mp4",
        filename: undefined,
      },
    });
    expect(stdout).toContain("att-123");
  });

  test("success with --json: outputs structured result", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "att-456",
        originalFilename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        kind: "image",
        filePath: "/tmp/screen.png",
        createdAt: 1700000000000,
      },
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/screen.png",
      "--mime",
      "image/png",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe("att-456");
    expect(parsed.originalFilename).toBe("screen.png");
    expect(parsed.mimeType).toBe("image/png");
    expect(parsed.sizeBytes).toBe(2048);
    expect(parsed.kind).toBe("image");
    expect(parsed.filePath).toBe("/tmp/screen.png");
  });

  test("passes --filename to IPC params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "att-789",
        originalFilename: "recording.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4096,
        kind: "video",
        filePath: "/tmp/clip.mp4",
        createdAt: 1700000000000,
      },
    };

    await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/clip.mp4",
      "--mime",
      "video/mp4",
      "--filename",
      "recording.mp4",
    ]);

    expect(
      (lastIpcCall!.params!.body as Record<string, unknown>).filename,
    ).toBe("recording.mp4");
  });

  // ── register errors ──────────────────────────────────────────────

  test("error (daemon not running): exits 1 with error message", async () => {
    mockIpcResult = {
      ok: false,
      error:
        "Could not connect to assistant. Is it running? Try 'vellum wake'.",
    };

    const { exitCode } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/clip.mp4",
      "--mime",
      "video/mp4",
    ]);

    expect(exitCode).toBe(1);
  });

  test("error (daemon not running) --json: outputs structured error", async () => {
    mockIpcResult = {
      ok: false,
      error:
        "Could not connect to assistant. Is it running? Try 'vellum wake'.",
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/clip.mp4",
      "--mime",
      "video/mp4",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });

  test("error (file not found): exits 1 with actionable error", async () => {
    mockIpcResult = {
      ok: false,
      error: "File not found: /tmp/nonexistent.mp4",
    };

    const { exitCode } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/nonexistent.mp4",
      "--mime",
      "video/mp4",
    ]);

    expect(exitCode).toBe(1);
  });

  test("error (file not found) --json: outputs structured error", async () => {
    mockIpcResult = {
      ok: false,
      error: "File not found: /tmp/nonexistent.mp4",
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "register",
      "--path",
      "/tmp/nonexistent.mp4",
      "--mime",
      "video/mp4",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("File not found");
    expect(parsed.error).toContain("/tmp/nonexistent.mp4");
  });
});

// ---------------------------------------------------------------------------
// lookup — success
// ---------------------------------------------------------------------------

describe("attachment lookup", () => {
  test("success: calls IPC and prints file path", async () => {
    mockIpcResult = {
      ok: true,
      result: { filePath: "/path/to/stored/file.mp4" },
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "lookup",
      "--source",
      "/original/path/file.mp4",
      "--conversation",
      "conv_123",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("attachment_lookup");
    expect(lastIpcCall!.params).toEqual({
      body: {
        sourcePath: "/original/path/file.mp4",
        conversationId: "conv_123",
      },
    });
    expect(stdout).toContain("/path/to/stored/file.mp4");
  });

  test("success with --json: outputs structured result", async () => {
    mockIpcResult = {
      ok: true,
      result: { filePath: "/path/to/stored/file.mp4" },
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "lookup",
      "--source",
      "/original/path/file.mp4",
      "--conversation",
      "conv_123",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.filePath).toBe("/path/to/stored/file.mp4");
  });

  // ── lookup errors ────────────────────────────────────────────────

  test("error (not found): exits 1 with error", async () => {
    mockIpcResult = {
      ok: false,
      error:
        "No attachment found for source path: /tmp/missing.mp4 in conversation conv_456. Run 'assistant attachment register' to register a file first.",
    };

    const { exitCode } = await runCommand([
      "attachment",
      "lookup",
      "--source",
      "/tmp/missing.mp4",
      "--conversation",
      "conv_456",
    ]);

    expect(exitCode).toBe(1);
  });

  test("error (not found) --json: outputs structured error", async () => {
    mockIpcResult = {
      ok: false,
      error:
        "No attachment found for source path: /tmp/missing.mp4 in conversation conv_456. Run 'assistant attachment register' to register a file first.",
    };

    const { exitCode, stdout } = await runCommand([
      "attachment",
      "lookup",
      "--source",
      "/tmp/missing.mp4",
      "--conversation",
      "conv_456",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No attachment found");
  });
});
