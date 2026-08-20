/**
 * Tests for `assistant conversations search`.
 *
 * Validates IPC plumbing onto `conversations_search`, human vs `--json`
 * output, empty-result copy, and validation of the search term / --limit.
 */

import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { query: "flux", results: [] } };

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitCodeFromIpcResult: (r: { statusCode?: number }) =>
    r.statusCode === undefined
      ? 10
      : r.statusCode >= 500
        ? 3
        : r.statusCode >= 400
          ? 2
          : 1,
  exitFromIpcResult: () => {
    process.exitCode = 1;
  },
}));

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

mock.module("../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
  initLogger: () => {},
  truncateForLog: (v: string) => v,
  pruneOldLogFiles: () => 0,
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
  getCurrentLogFilePath: () => "/tmp/test-assistant.log",
}));

const realFs = { ...nodeFs };
mock.module("node:fs", () => ({ ...realFs }));

const { registerConversationsCommand } = await import("../conversations.js");

const THREE_HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000;

const matchingResult = {
  conversationId: "conv-xyz",
  conversationTitle: "Quarterly metrics",
  conversationUpdatedAt: THREE_HOURS_AGO,
  matchingMessages: [
    {
      messageId: "msg-1",
      role: "user",
      excerpt: "let's review the flux capacitor numbers",
      createdAt: THREE_HOURS_AGO,
    },
    {
      messageId: "msg-2",
      role: "assistant",
      excerpt: "the Q3 flux capacitor spend is on track",
      createdAt: THREE_HOURS_AGO,
    },
  ],
};

async function runSearch(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: (s) => {
      stderrChunks.push(s);
    },
    writeOut: (s) => {
      stdoutChunks.push(s);
    },
  });
  registerConversationsCommand(program);
  try {
    await program.parseAsync(["node", "assistant", "conversations", ...args]);
  } catch (err) {
    const isHelp =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "commander.helpDisplayed";
    if (!isHelp && (process.exitCode === 0 || process.exitCode === undefined)) {
      process.exitCode = 1;
    }
    if (
      !isHelp &&
      err instanceof Error &&
      !stderrChunks.some((s) => s.includes(err.message))
    ) {
      stderrChunks.push(err.message);
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return {
    code,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

beforeEach(() => {
  lastIpcCall = null;
  process.exitCode = 0;
  mockIpcResult = { ok: true, result: { query: "flux", results: [] } };
});

afterEach(() => {
  process.exitCode = 0;
});

describe("conversations search", () => {
  test("forwards the term to conversations_search as queryParams.q", async () => {
    mockIpcResult = {
      ok: true,
      result: { query: "flux capacitor", results: [matchingResult] },
    };
    const { code } = await runSearch(["search", "flux capacitor"]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe("conversations_search");
    expect(lastIpcCall?.params).toEqual({
      queryParams: { q: "flux capacitor" },
    });
  });

  test("passes --limit as a query param string", async () => {
    mockIpcResult = {
      ok: true,
      result: { query: "flux", results: [] },
    };
    const { code } = await runSearch(["search", "flux", "--limit", "5"]);
    expect(code).toBe(0);
    expect(lastIpcCall?.params).toEqual({
      queryParams: { q: "flux", limit: "5" },
    });
  });

  test("prints conversation rows and excerpts in human mode", async () => {
    mockIpcResult = {
      ok: true,
      result: { query: "flux", results: [matchingResult] },
    };
    const { code, stdout } = await runSearch(["search", "flux"]);
    expect(code).toBe(0);
    expect(stdout).toContain("conv-xyz");
    expect(stdout).toContain("Quarterly metrics");
    expect(stdout).toContain("3h ago");
    expect(stdout).toContain("user  let's review the flux capacitor numbers");
    expect(stdout).toContain(
      "assistant  the Q3 flux capacitor spend is on track",
    );
  });

  test("prints Untitled when the conversation title is null", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        query: "flux",
        results: [
          {
            ...matchingResult,
            conversationTitle: null,
            matchingMessages: [],
          },
        ],
      },
    };
    const { code, stdout } = await runSearch(["search", "flux"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Untitled");
  });

  test("prints a no-match line when the daemon returns no results", async () => {
    mockIpcResult = {
      ok: true,
      result: { query: "no-such-term", results: [] },
    };
    const { code, stdout } = await runSearch(["search", "no-such-term"]);
    expect(code).toBe(0);
    expect(lastIpcCall?.method).toBe("conversations_search");
    expect(stdout).toBe('No conversations matched "no-such-term"\n');
  });

  test("--json emits the daemon payload", async () => {
    mockIpcResult = {
      ok: true,
      result: { query: "flux", results: [matchingResult] },
    };
    const { code, stdout } = await runSearch(["search", "flux", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      query: "flux",
      results: [matchingResult],
    });
  });

  test("--json reports IPC failure as { ok: false } and exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "assistant not running" };
    const { code, stdout } = await runSearch(["search", "flux", "--json"]);
    expect(code).toBe(10);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "assistant not running",
    });
  });

  test("rejects a whitespace-only term before IPC", async () => {
    const { code, stderr } = await runSearch(["search", "   "]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(stderr).toContain("Search term must be a non-empty string");
  });

  test("--json rejects a whitespace-only term as { ok: false }", async () => {
    const { code, stdout } = await runSearch(["search", "   ", "--json"]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Search term must be a non-empty string"),
    });
  });

  test("rejects a non-numeric --limit before IPC", async () => {
    const { code, stderr } = await runSearch([
      "search",
      "flux",
      "--limit",
      "all",
    ]);
    expect(code).toBe(1);
    expect(lastIpcCall).toBeNull();
    expect(stderr).toContain("Invalid --limit value");
  });

  test("search --help documents the term, --limit, and examples", async () => {
    const { code, stdout } = await runSearch(["search", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "Search conversations by title and message content",
    );
    expect(stdout).toContain("--limit");
    expect(stdout).toContain(
      'assistant conversations search "project planning"',
    );
    expect(stdout).toContain("--json");
  });
});
