import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { LOG_FILE_JSON_PATTERN, initLogger } from "../logger.js";
import {
  DiscordGatewayClient,
  type CancelTimer,
  type GatewaySocketLike,
} from "./gateway-socket.js";
import "../__tests__/test-preload.js";

/**
 * Asserts the admission-gate drop against a real gateway logger rather than a
 * spy, because the defect being pinned here is a level mismatch and a spy
 * would happily record a line that no configured stream ever writes.
 *
 * Every gateway stream is built at `level: "info"` (see `logger.ts`), so a
 * `debug` drop line reaches no sink at all. Reading the JSONL sidecar back off
 * disk is the only assertion that can tell "logged" from "logged somewhere it
 * survives".
 *
 * This lives in its own file so `initLogger`, which sets module-global logger
 * state, does not redirect the rest of the Discord suite's output. The gateway
 * runner executes each test file in its own `bun test` invocation.
 */

const CHANNEL = "1532468750740357331";
const UNLISTED_CHANNEL = "800000000000000002";

let logDir: string;

beforeAll(() => {
  logDir = mkdtempSync(join(tmpdir(), "gw-discord-admission-"));
  initLogger({ dir: logDir, retentionDays: 0 });
});

afterAll(() => {
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

class FakeSocket implements GatewaySocketLike {
  private listeners: Array<(event: { data?: unknown; code?: number }) => void> =
    [];

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    if (type === "message") this.listeners.push(listener);
  }

  send(): void {}
  close(): void {}

  message(payload: unknown): void {
    for (const listener of this.listeners) {
      listener({ data: JSON.stringify(payload) });
    }
  }
}

const schedule: (fn: () => void, delayMs: number) => CancelTimer =
  () => () => {};

/** A started client whose session is established, with the given allow-list. */
async function connectedClient(allowed: string[]): Promise<FakeSocket> {
  let socket: FakeSocket | undefined;
  const client = new DiscordGatewayClient(
    {
      botToken: "token-abc",
      readAllowedChannelIds: () => new Set(allowed),
      fetchFn: (async () =>
        new Response(JSON.stringify({ url: "wss://gateway.test" }), {
          status: 200,
        })) as unknown as typeof fetch,
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
      schedule,
      random: () => 0.5,
      now: () => 1_000_000,
    },
    () => {},
  );

  await client.start();
  const ws = socket as FakeSocket;
  ws.message({ op: 10, d: { heartbeat_interval: 41_250 } });
  ws.message({
    op: 0,
    t: "READY",
    s: 1,
    d: {
      session_id: "sess-1",
      resume_gateway_url: "wss://resume.test",
      user: { id: "bot-1" },
    },
  });
  return ws;
}

function mentionIn(
  channelId: string,
  messageId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: {
      id: messageId,
      channel_id: channelId,
      guild_id: "670819210053681162",
      content: "<@bot-1> hey",
      author: { id: "user-1", username: "boss" },
      mentions: [{ id: "bot-1" }],
      ...overrides,
    },
  };
}

describe("admission drop visibility", () => {
  test("a channel_not_allowed drop is written at a level the streams keep", async () => {
    // The Jul 30 smoke test in miniature: the bot is mentioned, the allow-list
    // is empty, and before this change the resulting drop was logged at debug
    // and therefore written nowhere. The log was indistinguishable from one
    // where no event ever arrived, which is what sent the investigation after
    // intents, the dispatcher table, and the handshake.
    const ws = await connectedClient([]);
    ws.message(mentionIn(UNLISTED_CHANNEL, "msg-visible-1"));

    const dropped = readLogRecords().filter(
      (record) => record["messageId"] === "msg-visible-1",
    );

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.["reason"]).toBe("channel_not_allowed");
    expect(dropped[0]?.["channelId"]).toBe(UNLISTED_CHANNEL);
    // pino: warn is 40, info is 30, debug is 20. The file streams start at
    // info, so a debug record would be absent above rather than present here.
    // This reason warns because it is the operator-actionable one.
    expect(dropped[0]?.["level"]).toBe(40);
  });

  test("the bot's own echo stays quiet", async () => {
    // Never promoted at any volume: it scales with how much the bot says, and
    // no misconfiguration can cause it.
    const ws = await connectedClient([CHANNEL]);
    ws.message(mentionIn(CHANNEL, "msg-self-1", { author: { id: "bot-1" } }));

    expect(
      readLogRecords().filter((r) => r["messageId"] === "msg-self-1"),
    ).toHaveLength(0);
  });

  test("repeated drops on the same channel do not keep writing", async () => {
    // The counterweight. A busy community channel produces one drop per
    // message, so promoting all of them would flood the stream the gate exists
    // to keep quiet.
    const ws = await connectedClient([]);
    ws.message(mentionIn("800000000000000777", "msg-repeat-1"));
    ws.message(mentionIn("800000000000000777", "msg-repeat-2"));
    ws.message(mentionIn("800000000000000777", "msg-repeat-3"));

    const records = readLogRecords();
    expect(
      records.filter((r) => r["messageId"] === "msg-repeat-1"),
    ).toHaveLength(1);
    expect(
      records.filter((r) => r["messageId"] === "msg-repeat-2"),
    ).toHaveLength(0);
    expect(
      records.filter((r) => r["messageId"] === "msg-repeat-3"),
    ).toHaveLength(0);
  });

  test("an admitted message still logs its admission", async () => {
    // Guards the other direction: the drop path going quiet must not be
    // achieved by making the whole gate quiet.
    const ws = await connectedClient([CHANNEL]);
    ws.message(mentionIn(CHANNEL, "msg-admitted-1"));

    const admitted = readLogRecords().filter(
      (record) => record["messageId"] === "msg-admitted-1",
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.["level"]).toBe(30);
  });
});
