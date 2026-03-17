import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-notifications-test-"));

mock.module("../../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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

// Track emitNotificationSignal calls
const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-id",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

mock.module("../../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum", "telegram", "slack"],
  getChannelPolicy: () => ({
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "start_new_conversation",
    },
    invite: { codeRedemptionEnabled: false },
  }),
  isNotificationDeliverable: () => true,
  getConversationStrategy: () => "start_new_conversation",
  getChannelInvitePolicy: () => ({ codeRedemptionEnabled: false }),
  isInviteCodeRedemptionEnabled: () => false,
}));

import { Command } from "commander";

import { getDb, initializeDb, resetDb } from "../../memory/db.js";
import { createEvent } from "../../notifications/events-store.js";
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

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  emitSignalCalls.length = 0;
  process.exitCode = 0;
});

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// send subcommand
// ---------------------------------------------------------------------------

describe("notifications send", () => {
  test("send with valid args emits signal", async () => {
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

    expect(emitSignalCalls).toHaveLength(1);
    const call = emitSignalCalls[0];
    expect(call.sourceChannel).toBe("assistant_tool");
    expect(call.sourceEventName).toBe("user.send_notification");
    const payload = call.contextPayload as Record<string, unknown>;
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

    expect(emitSignalCalls).toHaveLength(1);
    const hints = emitSignalCalls[0].attentionHints as Record<string, unknown>;
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

    expect(emitSignalCalls).toHaveLength(1);
    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.preferredChannels).toEqual(["telegram", "slack"]);
  });

  test("send rejects invalid source channel", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "bogus",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("bogus");
    // Should list valid channels from the registry
    expect(parsed.error).toContain("assistant_tool");
    expect(parsed.error).toContain("scheduler");
    expect(parsed.error).toContain("watcher");
  });

  test("send rejects invalid source event name", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "bogus.event",
      "--message",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("bogus.event");
    // Should list valid event names from the registry
    expect(parsed.error).toContain("user.send_notification");
    expect(parsed.error).toContain("schedule.notify");
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
  });

  test("send rejects invalid preferred channel", async () => {
    const { parsed, exitCode } = await runCommand([
      "send",
      "--source-channel",
      "assistant_tool",
      "--source-event-name",
      "user.send_notification",
      "--message",
      "Hello",
      "--preferred-channels",
      "badchannel",
    ]);

    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("badchannel");
    // Should list valid deliverable channels from the mock
    expect(parsed.error).toContain("vellum");
    expect(parsed.error).toContain("telegram");
    expect(parsed.error).toContain("slack");
  });
});

// ---------------------------------------------------------------------------
// list subcommand
// ---------------------------------------------------------------------------

describe("notifications list", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM notification_events");
  });

  test("list returns empty array when no events", async () => {
    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.events).toEqual([]);
  });

  test("list returns events", async () => {
    createEvent({
      id: `evt-${Date.now()}-1`,
      sourceEventName: "user.send_notification",
      sourceChannel: "assistant_tool",
      sourceContextId: "session-1",
      attentionHints: {
        requiresAction: true,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      payload: { requestedMessage: "Test event" },
    });

    const { parsed, exitCode } = await runCommand(["list"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].sourceEventName).toBe("user.send_notification");
  });

  test("list respects --limit", async () => {
    for (let i = 0; i < 5; i++) {
      createEvent({
        id: `evt-limit-${Date.now()}-${i}`,
        sourceEventName: "user.send_notification",
        sourceChannel: "assistant_tool",
        sourceContextId: `session-limit-${i}`,
        attentionHints: {
          requiresAction: true,
          urgency: "medium",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        payload: { requestedMessage: `Limit test ${i}` },
      });
    }

    const { parsed, exitCode } = await runCommand(["list", "--limit", "2"]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
  });

  test("list filters by --source-event-name", async () => {
    createEvent({
      id: `evt-filter-notif-${Date.now()}`,
      sourceEventName: "user.send_notification",
      sourceChannel: "assistant_tool",
      sourceContextId: "session-filter-1",
      attentionHints: {
        requiresAction: true,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      payload: { requestedMessage: "Notification event" },
    });

    createEvent({
      id: `evt-filter-reminder-${Date.now()}`,
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "session-filter-2",
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      payload: { requestedMessage: "Reminder event" },
    });

    const { parsed, exitCode } = await runCommand([
      "list",
      "--source-event-name",
      "user.send_notification",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(event.sourceEventName).toBe("user.send_notification");
    }
  });

  test("list accepts custom (non-registered) source event names", async () => {
    createEvent({
      id: `evt-custom-${Date.now()}`,
      sourceEventName: "custom.my_event",
      sourceChannel: "assistant_tool",
      sourceContextId: "session-custom",
      attentionHints: {
        requiresAction: true,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      payload: { requestedMessage: "Custom event" },
    });

    const { parsed, exitCode } = await runCommand([
      "list",
      "--source-event-name",
      "custom.my_event",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const events = parsed.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(event.sourceEventName).toBe("custom.my_event");
    }
  });

  test("list returns empty for non-matching custom event name", async () => {
    const { parsed, exitCode } = await runCommand([
      "list",
      "--source-event-name",
      "nonexistent.event",
    ]);

    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.events).toEqual([]);
  });
});
