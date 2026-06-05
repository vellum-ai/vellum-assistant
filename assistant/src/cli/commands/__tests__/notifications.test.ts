import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: mock logger and IPC client
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
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
let ipcResponse: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = {
  ok: true,
  result: {},
};

const exitCodeFromIpcResult = (r: { statusCode?: number }): number => {
  if (r.statusCode === undefined) return 10;
  if (r.statusCode >= 500) return 3;
  if (r.statusCode >= 400) return 2;
  return 1;
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return ipcResponse;
  },
  exitFromIpcResult: (r: {
    ok: false;
    error?: string;
    statusCode?: number;
  }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = exitCodeFromIpcResult(r);
    return undefined as never;
  },
  exitCodeFromIpcResult,
}));

import { Command } from "commander";

import { registerNotificationsCommand } from "../notifications.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  parsed: Record<string, unknown>;
  stderr: string;
  exitCode: number;
}

interface RawCommandResult {
  stdout: string;
  stderr: string;
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
  const raw = await runRawCommand(["notifications", "--json", ...args]);

  const firstLine = raw.stdout.trim().split("\n")[0];
  const parsed = firstLine
    ? (JSON.parse(firstLine) as Record<string, unknown>)
    : {};

  return { parsed, stderr: raw.stderr, exitCode: raw.exitCode };
}

async function runRawCommand(args: string[]): Promise<RawCommandResult> {
  const chunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.exitCode = 0;

  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Buffer) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;

  try {
    const program = new Command();
    program.exitOverride();
    registerNotificationsCommand(program);
    await program.parseAsync(["node", "test", ...args]);
  } catch {
    // Commander throws on .exitOverride() for --help/errors; ignore
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    stdout: chunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function lastSendBody(): Record<string, unknown> {
  expect(ipcCalls).toHaveLength(1);
  expect(ipcCalls[0].method).toBe("emit_notification_signal");
  return ipcCalls[0].params?.body as Record<string, unknown>;
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

    const body = lastSendBody();
    expect(body.sourceChannel).toBe("assistant_tool");
    expect(body.sourceEventName).toBe("user.send_notification");
    const payload = body.contextPayload as Record<string, unknown>;
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

    const hints = lastSendBody().attentionHints as Record<string, unknown>;
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

    const payload = lastSendBody().contextPayload as Record<string, unknown>;
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

  test("send rejects invalid source-channel", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "water_reminder",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed).toEqual({
      ok: false,
      error:
        'Invalid source-channel "water_reminder". Must be one of: assistant_tool, vellum, phone, telegram, slack, scheduler, watcher',
    });
    expect(ipcCalls).toHaveLength(0);
  });

  test("send help lists source-channel values", async () => {
    const { stdout, exitCode } = await runRawCommand([
      "notifications",
      "send",
      "--help",
    ]);

    expect(exitCode).toBe(0);
    const normalizedHelp = stdout.replace(/\s+/g, " ");
    expect(normalizedHelp).toContain(
      "One of: assistant_tool, vellum, phone, telegram, slack, scheduler, watcher",
    );
    expect(normalizedHelp).toContain("(default: assistant_tool)");
  });

  test("send --conversation-id pins the vellum affinity hint", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hi",
      "--conversation-id",
      "conv-123",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    const body = lastSendBody();
    expect(body.conversationAffinityHint).toEqual({ vellum: "conv-123" });
  });

  test("send omits conversationAffinityHint when --conversation-id not passed", async () => {
    await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hi",
    ]);

    const body = lastSendBody();
    expect(body.conversationAffinityHint).toBeUndefined();
  });

  test("send rejects empty --conversation-id", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hi",
      "--conversation-id",
      "   ",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Conversation ID must be a non-empty string");
    expect(ipcCalls).toHaveLength(0);
  });

  test("send surfaces IPC error response as JSON envelope in --json mode", async () => {
    ipcResponse = {
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    };

    const { parsed, stderr, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
    ]);

    // Transport failure (no statusCode) maps to exit 10 per exitFromIpcResult.
    expect(exitCode).toBe(10);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
    // --json mode keeps error on stdout envelope, not stderr.
    expect(stderr).toBe("");
  });

  test("send maps daemon 4xx to exit 2 while preserving --json envelope", async () => {
    ipcResponse = {
      ok: false,
      error: "Invalid signal payload",
      statusCode: 422,
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

    expect(exitCode).toBe(2);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Invalid signal payload");
  });
});

// ---------------------------------------------------------------------------
// send — minimal-surface ergonomics (--urgent and source defaults)
// ---------------------------------------------------------------------------

describe("notifications send — minimal-surface ergonomics", () => {
  test("--urgent maps to urgency=critical + requiresAction=true", async () => {
    const { exitCode } = await runCommand([
      "send",
      "--message",
      "Pager: prod is down",
      "--urgent",
    ]);

    expect(exitCode).toBe(0);
    const hints = lastSendBody().attentionHints as Record<string, unknown>;
    expect(hints.urgency).toBe("critical");
    expect(hints.requiresAction).toBe(true);
  });

  test("missing --source-channel defaults to 'assistant_tool'", async () => {
    const { exitCode } = await runCommand(["send", "--message", "hello"]);

    expect(exitCode).toBe(0);
    const body = lastSendBody();
    expect(body.sourceChannel).toBe("assistant_tool");
    // The context payload echoes the source channel via requestedBySource.
    const payload = body.contextPayload as Record<string, unknown>;
    expect(payload.requestedBySource).toBe("assistant_tool");
  });

  test("missing --source-event-name defaults to 'assistant.share'", async () => {
    const { exitCode } = await runCommand(["send", "--message", "hello"]);

    expect(exitCode).toBe(0);
    expect(lastSendBody().sourceEventName).toBe("assistant.share");
  });

  test("explicit --urgency high still overrides defaults when --urgent is absent", async () => {
    const { exitCode } = await runCommand([
      "send",
      "--message",
      "stand-up reminder",
      "--urgency",
      "high",
    ]);

    expect(exitCode).toBe(0);
    const hints = lastSendBody().attentionHints as Record<string, unknown>;
    expect(hints.urgency).toBe("high");
    // Without --urgent or --requires-action, requiresAction stays at the new
    // default of false.
    expect(hints.requiresAction).toBe(false);
  });

  test("explicit --urgency wins even when --urgent is also passed (back-compat)", async () => {
    const { exitCode } = await runCommand([
      "send",
      "--message",
      "deploy complete",
      "--urgent",
      "--urgency",
      "medium",
    ]);

    expect(exitCode).toBe(0);
    const hints = lastSendBody().attentionHints as Record<string, unknown>;
    expect(hints.urgency).toBe("medium");
    // --urgent still flips requiresAction since no explicit flag was passed.
    expect(hints.requiresAction).toBe(true);
  });

  test("explicit --no-requires-action wins even when --urgent is passed", async () => {
    const { exitCode } = await runCommand([
      "send",
      "--message",
      "fyi only",
      "--urgent",
      "--no-requires-action",
    ]);

    expect(exitCode).toBe(0);
    const hints = lastSendBody().attentionHints as Record<string, unknown>;
    expect(hints.urgency).toBe("critical");
    expect(hints.requiresAction).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list subcommand
// ---------------------------------------------------------------------------

describe("notifications list", () => {
  const emptyPayload = {
    items: [],
    total: 0,
    returned: 0,
    hasMore: false,
    updatedAt: "2026-05-28T00:00:00.000Z",
  };

  function feedItem(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: "feed-1",
      type: "notification",
      priority: 50,
      summary: "Background sync done",
      timestamp: "2026-05-28T10:00:00.000Z",
      status: "new",
      createdAt: "2026-05-28T10:00:00.000Z",
      ...overrides,
    };
  }

  test("list calls list_home_feed and returns empty payload", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([]);
    expect(parsed.total).toBe(0);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("list_home_feed");
  });

  test("list returns items from IPC", async () => {
    ipcResponse = {
      ok: true,
      result: {
        ...emptyPayload,
        items: [feedItem({ title: "Hello", urgency: "medium" })],
        total: 1,
        returned: 1,
      },
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const items = parsed.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Hello");
  });

  test("list defaults to excluding dismissed (no includeDismissed flag in body)", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand(["list"]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.includeDismissed).toBeUndefined();
    expect(body.statuses).toBeUndefined();
  });

  test("--all sets includeDismissed=true", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand(["list", "--all"]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.includeDismissed).toBe(true);
  });

  test("--status is repeatable and passed as statuses array", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand(["list", "--status", "new", "--status", "acted_on"]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.statuses).toEqual(["new", "acted_on"]);
  });

  test("--status rejects invalid value before IPC call", async () => {
    const { parsed, exitCode } = await runCommand([
      "list",
      "--status",
      "bogus",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("status");
    expect(ipcCalls).toHaveLength(0);
  });

  test("--before and --after are forwarded as ISO strings", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand([
      "list",
      "--after",
      "2026-05-28T00:00:00Z",
      "--before",
      "2026-05-29T00:00:00Z",
    ]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.after).toBe("2026-05-28T00:00:00Z");
    expect(body.before).toBe("2026-05-29T00:00:00Z");
  });

  test("--urgency is repeatable and passed as urgencies array", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand(["list", "--urgency", "high", "--urgency", "critical"]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.urgencies).toEqual(["high", "critical"]);
  });

  test("--urgency rejects invalid value", async () => {
    const { exitCode, parsed } = await runCommand([
      "list",
      "--urgency",
      "extreme",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("urgency");
    expect(ipcCalls).toHaveLength(0);
  });

  test("--category is repeatable and passed as categories array", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand([
      "list",
      "--category",
      "email",
      "--category",
      "scheduling",
    ]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.categories).toEqual(["email", "scheduling"]);
  });

  test("--conversation-id, --from-assistant, --noteworthy forwarded", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand([
      "list",
      "--conversation-id",
      "conv-abc",
      "--from-assistant",
      "--noteworthy",
    ]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-abc");
    expect(body.fromAssistant).toBe(true);
    expect(body.noteworthy).toBe(true);
  });

  test("--limit and --offset are forwarded as integers", async () => {
    ipcResponse = { ok: true, result: emptyPayload };

    await runCommand(["list", "--limit", "5", "--offset", "10"]);

    const body = ipcCalls[0].params?.body as Record<string, unknown>;
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(10);
  });

  test("--limit rejects non-positive integers", async () => {
    const { exitCode, parsed } = await runCommand(["list", "--limit", "0"]);
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("limit");
    expect(ipcCalls).toHaveLength(0);
  });

  test("--limit rejects values above 200", async () => {
    const { exitCode, parsed } = await runCommand(["list", "--limit", "500"]);
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("200");
    expect(ipcCalls).toHaveLength(0);
  });

  test("--offset rejects negative values", async () => {
    const { exitCode, parsed } = await runCommand(["list", "--offset", "-1"]);
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("offset");
    expect(ipcCalls).toHaveLength(0);
  });

  test("empty --conversation-id is rejected", async () => {
    const { exitCode, parsed } = await runCommand([
      "list",
      "--conversation-id",
      "   ",
    ]);
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Conversation ID");
    expect(ipcCalls).toHaveLength(0);
  });

  test("list surfaces IPC error response", async () => {
    ipcResponse = {
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    // Transport failure (no statusCode) maps to exit 10 per exitCodeFromIpcResult.
    expect(exitCode).toBe(10);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });

  test("list maps daemon 4xx to exit 2", async () => {
    ipcResponse = {
      ok: false,
      error: "Invalid filter",
      statusCode: 400,
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(2);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Invalid filter");
  });

  test("list maps daemon 5xx to exit 3", async () => {
    ipcResponse = {
      ok: false,
      error: "Internal daemon error",
      statusCode: 500,
    };

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(3);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Internal daemon error");
  });
});
