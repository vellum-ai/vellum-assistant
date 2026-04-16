/**
 * Tests for the `assistant conversations wake` CLI command.
 *
 * Mocks wakeAgentForOpportunity at the module boundary so the real
 * CliIpcServer (with auto-registered routes) can be exercised end-to-end
 * without spinning up the full daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { runAssistantCommandFull } from "../../cli/__tests__/run-assistant-command.js";
import { CliIpcServer } from "../cli-server.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockWakeResult = { invoked: true, producedToolCalls: false };
let mockWakeCalls: Array<{
  conversationId: string;
  hint: string;
  source: string;
}> = [];

mock.module("../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async (opts: {
    conversationId: string;
    hint: string;
    source: string;
  }) => {
    mockWakeCalls.push(opts);
    return mockWakeResult;
  },
  registerDefaultWakeResolver: () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: CliIpcServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
  mockWakeResult = { invoked: true, producedToolCalls: false };
  mockWakeCalls = [];
});

async function startServer(): Promise<void> {
  server = new CliIpcServer();
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant conversations wake (CLI)", () => {
  test("successful wake prints confirmation", async () => {
    mockWakeResult = { invoked: true, producedToolCalls: true };
    await startServer();
    process.exitCode = 0;

    const { stdout } = await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-123",
      "--hint",
      "test hint",
    );

    expect(stdout).toContain("Wake produced output on conversation conv-123");
    expect(process.exitCode).toBe(0);
  });

  test("wake invoked but no output", async () => {
    mockWakeResult = { invoked: true, producedToolCalls: false };
    await startServer();
    process.exitCode = 0;

    const { stdout } = await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-456",
      "--hint",
      "quiet check",
    );

    expect(stdout).toContain("no output produced");
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured success", async () => {
    mockWakeResult = { invoked: true, producedToolCalls: true };
    await startServer();
    process.exitCode = 0;

    const { stdout } = await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-789",
      "--hint",
      "json test",
      "--json",
    );

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.invoked).toBe(true);
    expect(parsed.producedToolCalls).toBe(true);
  });

  test("--json outputs structured error when IPC fails", async () => {
    // No server started — socket doesn't exist
    process.exitCode = 0;

    const { stdout } = await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-nope",
      "--hint",
      "will fail",
      "--json",
    );

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(process.exitCode).toBe(1);
  });

  test("conversation not found sets exit code 1", async () => {
    mockWakeResult = { invoked: false, producedToolCalls: false };
    await startServer();
    process.exitCode = 0;

    await runAssistantCommandFull(
      "conversations",
      "wake",
      "nonexistent",
      "--hint",
      "test",
    );

    expect(process.exitCode).toBe(1);
  });

  test("IPC connection error sets exit code 1", async () => {
    // No server started — socket doesn't exist
    process.exitCode = 0;

    await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-nope",
      "--hint",
      "will fail",
    );

    expect(process.exitCode).toBe(1);
  });

  test("--source passes through to IPC handler", async () => {
    mockWakeResult = { invoked: true, producedToolCalls: false };
    await startServer();
    process.exitCode = 0;

    await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-src",
      "--hint",
      "source test",
      "--source",
      "github-ci",
    );

    expect(mockWakeCalls).toHaveLength(1);
    expect(mockWakeCalls[0].source).toBe("github-ci");
  });

  test("defaults source to cli when --source omitted", async () => {
    mockWakeResult = { invoked: true, producedToolCalls: false };
    await startServer();
    process.exitCode = 0;

    await runAssistantCommandFull(
      "conversations",
      "wake",
      "conv-default",
      "--hint",
      "default source",
    );

    expect(mockWakeCalls).toHaveLength(1);
    expect(mockWakeCalls[0].source).toBe("cli");
  });
});
