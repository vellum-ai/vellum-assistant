import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: mock logger and IPC client
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track cliIpcCall invocations and control responses
const ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> =
  [];
let ipcResponse: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {},
};

mock.module("../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return ipcResponse;
  },
}));

import { Command } from "commander";

import { registerNotificationsCommand } from "../commands/notifications.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  parsed: Record<string, unknown>;
  exitCode: number;
}

/**
 * Run a notifications subcommand and capture the JSON output.
 * Always passes --json to get compact, single-line JSON output and suppress log messages.
 *
 * Follows the same process.exitCode pattern as credential-cli.test.ts:
 * reset to 0, capture, then reset back to 0 so bun test exits cleanly.
 */
async function runCommand(args: string[]): Promise<CommandResult> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;

  process.exitCode = 0;

  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    registerNotificationsCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "notifications",
      "--json",
      ...args,
    ]);
  } catch {
    // Commander throws on .exitOverride() for --help/errors; ignore
  } finally {
    process.stdout.write = originalWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  const output = chunks.join("");
  const firstLine = output.trim().split("\n")[0];
  const parsed = firstLine
    ? (JSON.parse(firstLine) as Record<string, unknown>)
    : {};

  return { parsed, exitCode };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls.length = 0;
  ipcResponse = {
    ok: true,
    result: {
      signalId: "mock-id",
      dispatched: true,
      deduplicated: false,
      reason: "ok",
    },
  };
  process.exitCode = 0;
});

afterAll(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// send subcommand
// ---------------------------------------------------------------------------

describe("notifications send", () => {
  test("send with valid args calls emit_notification_signal via IPC", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.signalId).toBe("mock-id");

    expect(ipcCalls).toHaveLength(1);
    const call = ipcCalls[0];
    expect(call.method).toBe("emit_notification_signal");
    const callBody = call.params?.body as Record<string, unknown>;
    expect(callBody?.sourceChannel).toBe("assistant_tool");
    expect(callBody?.sourceEventName).toBe("user.send_notification");
    const payload = callBody?.contextPayload as Record<string, unknown>;
    expect(payload.requestedMessage).toBe("Hello");
  });

  test("send passes urgency and attention hints", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "scheduler",
      "--source-event-name",
      "schedule.notify",
      "--message",
      "Test",
      "--urgency",
      "high",
      "--requires-action",
      "--is-async-background",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    expect(ipcCalls).toHaveLength(1);
    const emitBody = ipcCalls[0].params?.body as Record<string, unknown>;
    const hints = emitBody?.attentionHints as Record<string, unknown>;
    expect(hints.urgency).toBe("high");
    expect(hints.requiresAction).toBe(true);
    expect(hints.isAsyncBackground).toBe(true);
  });

  test("send passes preferred channels", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
      "--preferred-channels",
      "telegram,slack",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    expect(ipcCalls).toHaveLength(1);
    const dlBody = ipcCalls[0].params?.body as Record<string, unknown>;
    const payload = dlBody?.contextPayload as Record<string, unknown>;
    expect(payload.preferredChannels).toEqual(["telegram", "slack"]);
  });

  test("send rejects invalid urgency", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
      "--urgency",
      "invalid",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("invalid");
    expect(parsed.error).toContain("low");
    expect(parsed.error).toContain("medium");
    expect(parsed.error).toContain("high");

    // Urgency validation is local — no IPC call should have been made
    expect(ipcCalls).toHaveLength(0);
  });

  test("send surfaces IPC error response", async () => {
    ipcResponse = {
      ok: false,
      error: "Daemon rejected the signal",
    };

    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Daemon rejected the signal");
  });
});

// ---------------------------------------------------------------------------
// list subcommand
// ---------------------------------------------------------------------------

describe("notifications list", () => {
  test("list returns empty array when no events", async () => {
    ipcResponse = { ok: true, result: [] };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.events).toEqual([]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("list_notification_events");
  });

  test("list returns events from IPC", async () => {
    ipcResponse = {
      ok: true,
      result: [
        {
          id: "evt-1",
          sourceEventName: "user.send_notification",
          sourceChannel: "assistant_tool",
          sourceContextId: "session-1",
          urgency: "medium",
          dedupeKey: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].sourceEventName).toBe("user.send_notification");
  });

  test("list passes --limit to IPC", async () => {
    ipcResponse = { ok: true, result: [] };

    const { parsed, exitCode } = await runCommand(["list", "--limit", "5"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    expect(ipcCalls).toHaveLength(1);
    expect((ipcCalls[0].params?.body as Record<string, unknown>)?.limit).toBe(5);
  });

  test("list passes --source-event-name to IPC", async () => {
    ipcResponse = { ok: true, result: [] };

    const { parsed, exitCode } = await runCommand([
      "list",
      "--source-event-name",
      "schedule.notify",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    expect(ipcCalls).toHaveLength(1);
    expect(
      (ipcCalls[0].params?.body as Record<string, unknown>)?.sourceEventName,
    ).toBe("schedule.notify");
  });

  test("list surfaces IPC error response", async () => {
    ipcResponse = {
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });
});
