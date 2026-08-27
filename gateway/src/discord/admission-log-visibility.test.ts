import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { LOG_FILE_JSON_PATTERN, initLogger } from "../logger.js";
import {
  DiscordGatewayClient,
  type GatewaySocketLike,
} from "./gateway-socket.js";
import type { CancelTimer } from "../util/schedule.js";
import "../__tests__/test-preload.js";

/**
 * Asserts admission-gate drops against a real gateway logger rather than a
 * spy. Every gateway stream is built at `level: "info"` (see `logger.ts`), so
 * a `debug` line reaches no sink, and a spy would happily record a call that
 * no configured stream ever writes. Reading the JSONL sidecar back off disk is
 * the only assertion that distinguishes "logged" from "logged somewhere it
 * survives".
 *
 * `initLogger` sets module-global logger state, so this file keeps to itself:
 * the gateway runner gives each test file its own `bun test` invocation, and
 * `afterAll` restores the stdout-only logger in case it does not.
 */

const CHANNEL = "1532468750740357331";
const OTHER_CHANNEL = "800000000000000002";

let logDir: string;

beforeAll(() => {
  logDir = mkdtempSync(join(tmpdir(), "gw-discord-admission-"));
  initLogger({ dir: logDir, retentionDays: 0 });
});

afterAll(() => {
  // Restore the stdout-only logger so a sibling file sharing this process does
  // not keep writing into a directory that is about to be removed.
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

class FakeSocket implements GatewaySocketLike {
  private listeners: Array<(event: { data?: unknown; code?: number }) => void> =
    [];

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    if (type === "message") {
      this.listeners.push(listener);
    }
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

/** A started client whose session is established. */
async function connectedClient(): Promise<FakeSocket> {
  let socket: FakeSocket | undefined;
  const client = new DiscordGatewayClient(
    {
      botToken: "token-abc",
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
  test("a person's un-addressed message is written at a level the streams keep", async () => {
    // A drop that reached no sink would make this log identical to one where
    // no event ever arrived, which is the case an operator cannot diagnose.
    const ws = await connectedClient();
    ws.message(mentionIn(OTHER_CHANNEL, "msg-visible-1", { mentions: [] }));

    const dropped = readLogRecords().filter(
      (record) => record["messageId"] === "msg-visible-1",
    );

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.["reason"]).toBe("bot_not_mentioned");
    expect(dropped[0]?.["channelId"]).toBe(OTHER_CHANNEL);
    // pino: info is 30, debug is 20. The file streams start at info, so a
    // debug record would be absent above rather than present here.
    expect(dropped[0]?.["level"]).toBe(30);
  });

  test("the bot's own echo stays quiet", async () => {
    // Never promoted at any volume: it scales with how much the bot says, and
    // no misconfiguration can cause it.
    const ws = await connectedClient();
    ws.message(mentionIn(CHANNEL, "msg-self-1", { author: { id: "bot-1" } }));

    expect(
      readLogRecords().filter((r) => r["messageId"] === "msg-self-1"),
    ).toHaveLength(0);
  });

  test("repeated drops on the same channel do not keep writing", async () => {
    // The counterweight. A busy community channel produces one drop per
    // message, so promoting all of them would flood the stream the gate exists
    // to keep quiet.
    const ws = await connectedClient();
    ws.message(
      mentionIn("800000000000000777", "msg-repeat-1", { mentions: [] }),
    );
    ws.message(
      mentionIn("800000000000000777", "msg-repeat-2", { mentions: [] }),
    );
    ws.message(
      mentionIn("800000000000000777", "msg-repeat-3", { mentions: [] }),
    );

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
    const ws = await connectedClient();
    ws.message(mentionIn(CHANNEL, "msg-admitted-1"));

    const admitted = readLogRecords().filter(
      (record) => record["messageId"] === "msg-admitted-1",
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.["level"]).toBe(30);
  });
});
