import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { LOG_FILE_JSON_PATTERN, initLogger } from "../logger.js";
import "./test-preload.js";

/**
 * Asserts normalizer drops against a real gateway logger rather than a spy,
 * for the reason `discord/admission-log-visibility.test.ts` gives: every
 * gateway stream is built at `level: "info"`, so a `debug` line reaches no
 * sink, and a spy would record a call no configured stream ever writes.
 *
 * A dropped update is acknowledged with a 200, so Telegram reports nothing
 * pending and no error; the log line is the only place the drop exists.
 *
 * `initLogger` sets module-global logger state, so this file keeps to itself.
 */

mock.module("../fetch.js", () => ({
  // The only call the drop path makes is getMe, so the gate knows who it is.
  fetchImpl: async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { id: 123456789, username: "vellum_bot" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
}));

const { createTelegramWebhookHandler } =
  await import("../http/routes/telegram-webhook.js");

const SECRET = "test-webhook-secret";
const GROUP_CHAT_ID = -1001234567890;

let logDir: string;

beforeAll(() => {
  logDir = mkdtempSync(join(tmpdir(), "gw-telegram-drop-"));
  initLogger({ dir: logDir, retentionDays: 0 });
});

afterAll(() => {
  initLogger({ dir: undefined, retentionDays: 0 });
  rmSync(logDir, { recursive: true, force: true });
});

/** Every record written to the JSONL sidecar so far. */
function readLogRecords(): Array<Record<string, unknown>> {
  return readdirSync(logDir)
    .filter((name) => LOG_FILE_JSON_PATTERN.test(name))
    .flatMap((name) =>
      readFileSync(join(logDir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: false,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
  };
}

function makeCaches() {
  const credentials = {
    get: async (key: string) => {
      if (key === credentialKey("telegram", "webhook_secret")) {
        return SECRET;
      }
      if (key === credentialKey("telegram", "bot_token")) {
        return "123456789:test-secret";
      }
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
  return { credentials };
}

function groupMessage(updateId: number, chatType = "supergroup") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "hello from a group",
      chat: { id: GROUP_CHAT_ID, type: chatType },
      from: { id: 67890, is_bot: false, first_name: "Test" },
    },
  };
}

function webhookRequest(payload: unknown): Request {
  return new Request("http://localhost:7830/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify(payload),
  });
}

describe("telegram webhook: dropped updates are visible", () => {
  test("an unaddressed group message is acknowledged and its drop is written at a level the streams keep", async () => {
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );

    const res = await handler(webhookRequest(groupMessage(9001)));

    // Telegram must still see success, or it retries the update forever.
    expect(res.status).toBe(200);

    const dropped = readLogRecords().filter((r) => r["updateId"] === 9001);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.["reason"]).toBe("bot_not_mentioned");
    expect(dropped[0]?.["chatType"]).toBe("supergroup");
    expect(dropped[0]?.["chatId"]).toBe(String(GROUP_CHAT_ID));
    // pino: info is 30, debug is 20. The file streams start at info, so a
    // debug record would be absent above rather than present here.
    expect(dropped[0]?.["level"]).toBe(30);
  });

  test("repeated drops from the same chat do not keep writing", async () => {
    // One line carries the whole diagnosis; a busy group would otherwise
    // write one line per message.
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );

    await handler(webhookRequest(groupMessage(9101, "group")));
    await handler(webhookRequest(groupMessage(9102, "group")));

    const records = readLogRecords();
    expect(records.filter((r) => r["updateId"] === 9101)).toHaveLength(1);
    expect(records.filter((r) => r["updateId"] === 9102)).toHaveLength(0);
  });

  test("a drop that names no chat is written every time, not once per process", async () => {
    // Nothing to dedup on: a message with no chat id cannot share a key with
    // the next one, so a wave of them stays visible at any process age.
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );

    for (const updateId of [9401, 9402]) {
      const res = await handler(
        webhookRequest({
          update_id: updateId,
          message: { message_id: 1, text: "hi", from: { id: 42 } },
        }),
      );
      expect(res.status).toBe(200);
    }

    const records = readLogRecords();
    for (const updateId of [9401, 9402]) {
      const dropped = records.filter((r) => r["updateId"] === updateId);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.["reason"]).toBe("missing_chat");
      expect(dropped[0]?.["level"]).toBe(30);
    }
  });

  test("ordinary unreadable traffic stays quiet", async () => {
    // A sticker is not a misconfiguration and scales with how chatty a chat
    // is, so it never promotes.
    const { handler } = createTelegramWebhookHandler(
      makeConfig(),
      makeCaches(),
    );

    const res = await handler(
      webhookRequest({
        update_id: 9201,
        message: {
          message_id: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42 },
          sticker: { file_id: "abc" },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(readLogRecords().filter((r) => r["updateId"] === 9201)).toHaveLength(
      0,
    );
  });
});
