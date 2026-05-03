import { describe, expect, mock, test } from "bun:test";

import type { InlineCommandResult } from "../skills/inline-command-runner.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: true,
  },
  auditLog: { retentionDays: 0 },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../tools/terminal/safe-env.js", () => ({
  buildSanitizedEnv: () => ({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
  }),
}));

import { runInlineCommand } from "../skills/inline-command-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = process.cwd();

function expectOk(result: InlineCommandResult): void {
  expect(result.ok).toBe(true);
  expect(result.failureReason).toBeUndefined();
}

function expectFailure(
  result: InlineCommandResult,
  reason: InlineCommandResult["failureReason"],
): void {
  expect(result.ok).toBe(false);
  expect(result.failureReason).toBe(reason);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInlineCommand", () => {
  // ── Successful execution ─────────────────────────────────────────────────

  describe("successful execution", () => {
    test("captures stdout from a simple echo", async () => {
      const result = await runInlineCommand("echo hello-world", CWD);

      expectOk(result);
      expect(result.output).toBe("hello-world");
    });

    test("captures multi-line stdout", async () => {
      const result = await runInlineCommand(
        "printf 'line1\\nline2\\nline3'",
        CWD,
      );

      expectOk(result);
      expect(result.output).toContain("line1");
      expect(result.output).toContain("line2");
      expect(result.output).toContain("line3");
    });

    test("returns empty string for command with no output", async () => {
      const result = await runInlineCommand("true", CWD);

      expectOk(result);
      expect(result.output).toBe("");
    });
  });

  // ── ANSI stripping ──────────────────────────────────────────────────────

  describe("ANSI stripping", () => {
    test("strips SGR color codes from output", async () => {
      const result = await runInlineCommand(
        "printf '\\033[31mred\\033[0m normal'",
        CWD,
      );

      expectOk(result);
      expect(result.output).toBe("red normal");
      expect(result.output).not.toContain("\x1b");
    });

    test("strips cursor movement sequences", async () => {
      const result = await runInlineCommand("printf '\\033[2Ahello'", CWD);

      expectOk(result);
      expect(result.output).toBe("hello");
    });
  });

  // ── Binary output rejection ──────────────────────────────────────────────

  describe("binary output rejection", () => {
    test("rejects binary-ish output", async () => {
      // Generate output with >10% control characters
      const result = await runInlineCommand(
        "printf '\\x00\\x01\\x02\\x03\\x04\\x05\\x06\\x07abc'",
        CWD,
      );

      expectFailure(result, "binary_output");
      expect(result.output).toBe("Inline command produced binary output.");
    });
  });

  // ── Output clamping ──────────────────────────────────────────────────────

  describe("output clamping", () => {
    test("truncates output exceeding the cap", async () => {
      // Generate output larger than a small cap
      const result = await runInlineCommand("printf '%0.s-' {1..200}", CWD, {
        maxOutputChars: 50,
      });

      expectOk(result);
      expect(result.output.length).toBeLessThanOrEqual(
        50 + "\n[output truncated]".length,
      );
      expect(result.output).toContain("[output truncated]");
    });

    test("does not truncate output under the cap", async () => {
      const result = await runInlineCommand("echo short", CWD, {
        maxOutputChars: 1000,
      });

      expectOk(result);
      expect(result.output).toBe("short");
      expect(result.output).not.toContain("[output truncated]");
    });
  });

  // ── Timeout handling ─────────────────────────────────────────────────────

  describe("timeout handling", () => {
    test("produces deterministic timeout result", async () => {
      const result = await runInlineCommand("sleep 60", CWD, {
        timeoutMs: 200,
      });

      expectFailure(result, "timeout");
      expect(result.output).toBe("Inline command timed out after 200ms.");
    });
  });

  // ── Non-zero exit ────────────────────────────────────────────────────────

  describe("non-zero exit", () => {
    test("produces deterministic failure for exit code 1", async () => {
      const result = await runInlineCommand("exit 1", CWD);

      expectFailure(result, "non_zero_exit");
      expect(result.output).toBe("Inline command failed (exit code 1).");
    });

    test("produces deterministic failure for exit code 127", async () => {
      const result = await runInlineCommand(
        "nonexistent_command_that_does_not_exist_xyz",
        CWD,
      );

      expectFailure(result, "non_zero_exit");
      expect(result.output).toMatch(
        /Inline command failed \(exit code \d+\)\./,
      );
    });

    test("does not expose stderr in the error result", async () => {
      const result = await runInlineCommand("echo err-msg >&2 && exit 1", CWD);

      expectFailure(result, "non_zero_exit");
      expect(result.output).not.toContain("err-msg");
      expect(result.output).toBe("Inline command failed (exit code 1).");
    });
  });

  // ── Spawn failures ───────────────────────────────────────────────────────

  describe("spawn failures", () => {
    test("returns spawn_failure when cwd does not exist", async () => {
      // When the working directory doesn't exist, the child process fails to
      // start (ENOENT from posix_spawn). The runner should catch this and
      // return a deterministic spawn_failure result.
      const result = await runInlineCommand(
        "echo hello",
        "/nonexistent/path/that/does/not/exist",
      );

      expectFailure(result, "spawn_failure");
      expect(result.output).toBe("Inline command could not be started.");
    });
  });

  // ── stderr suppression ─────────────────────────────────────────────────

  describe("stderr suppression", () => {
    test("does not include stderr in successful output", async () => {
      const result = await runInlineCommand(
        "echo stdout-only && echo stderr-msg >&2",
        CWD,
      );

      // Command may succeed (exit 0) — stderr should not leak into output
      expectOk(result);
      expect(result.output).toBe("stdout-only");
      expect(result.output).not.toContain("stderr-msg");
    });
  });
});
