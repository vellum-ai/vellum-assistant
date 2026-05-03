import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import * as schema from "../db/schema.js";
import type { NormalizedSlackEvent } from "../slack/normalize.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => {
  return new Response(JSON.stringify({ ok: true, messages: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { SlackSocketModeClient } = await import("../slack/socket-mode.js");
const { clearUserInfoCache } = await import("../slack/normalize.js");
import type { SlackSocketModeConfig } from "../slack/socket-mode.js";

type CatchupHarness = {
  config: SlackSocketModeConfig;
  onEvent: (event: NormalizedSlackEvent) => void;
  store: SlackStore;
  ws: WebSocket | null;
  handleMessage(raw: string, originWs: WebSocket): void;
  replayMissedEvents(ownerWs: WebSocket): Promise<void>;
};

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "ast-default",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [
      {
        type: "conversation_id",
        key: "CROUTED01",
        assistantId: "ast-slack",
      },
    ],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "reject",
    trustProxy: false,
  };
}

function createSlackStore(): { rawDb: Database; store: SlackStore } {
  const rawDb = new Database(":memory:");
  rawDb.exec(`
    CREATE TABLE slack_active_threads (
      thread_ts TEXT PRIMARY KEY,
      channel_id TEXT,
      tracked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE slack_seen_events (
      event_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE slack_last_seen_ts (
      key TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      last_interaction INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return { rawDb, store: new SlackStore(drizzle(rawDb, { schema })) };
}

function createHarness(
  store: SlackStore,
  onEvent: (event: NormalizedSlackEvent) => void,
): CatchupHarness {
  const harness = Object.create(
    SlackSocketModeClient.prototype,
  ) as CatchupHarness;
  harness.config = {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    botUserId: "UBOT",
    botUsername: "assistant",
    teamName: "Example Team",
    gatewayConfig: makeConfig(),
  };
  harness.onEvent = onEvent;
  harness.store = store;
  harness.ws = null;
  return harness;
}

function makeOpenSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: mock(() => {}),
  } as unknown as WebSocket;
}

function flushAsyncEventEmission(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHistoryResponse(messages: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, messages }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearUserInfoCache();
  fetchMock = mock(async () => makeHistoryResponse([]));
});

describe("compound dedup across live and replay paths", () => {
  test("replay of an event whose live event_id was already seen is deduped", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-live",
          type: "events_api",
          payload: {
            event_id: "Ev-live",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> hi",
              ts: "1700000000.000100",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);

      // Same message arrives again via the replay path with a synthetic
      // event_id but the same (channel, ts) — the compound key prevents
      // a second emission.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-replay",
          type: "events_api",
          payload: {
            event_id: "replay:CROUTED01:1700000000.000100",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> hi",
              ts: "1700000000.000100",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);
    } finally {
      rawDb.close();
    }
  });

  test("live event after replay of the same (channel, ts) is deduped", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      // Replay arrives first.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-replay",
          type: "events_api",
          payload: {
            event_id: "replay:CROUTED01:1700000000.000200",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> hi",
              ts: "1700000000.000200",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);

      // Now Slack delivers it live — should be deduped via the message key.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-live",
          type: "events_api",
          payload: {
            event_id: "Ev-live-late",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> hi",
              ts: "1700000000.000200",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);
    } finally {
      rawDb.close();
    }
  });
});

describe("catch-up watermark", () => {
  test("watermark advances monotonically across accepted events", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-1",
          type: "events_api",
          payload: {
            event_id: "Ev-1",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> first",
              ts: "1700000010.000000",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-2",
          type: "events_api",
          payload: {
            event_id: "Ev-2",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> second",
              ts: "1700000020.000000",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(store.getLastSeenTs()).toBe("1700000020.000000");

      // Out-of-order older event must not pull the watermark backwards.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-3",
          type: "events_api",
          payload: {
            event_id: "Ev-3",
            event: {
              type: "app_mention",
              user: "U-author",
              text: "<@UBOT> earlier",
              ts: "1700000005.000000",
              channel: "CROUTED01",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(store.getLastSeenTs()).toBe("1700000020.000000");
    } finally {
      rawDb.close();
    }
  });
});

describe("replayMissedEvents", () => {
  test("bootstraps watermark to now and skips replay on first connect", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    expect(store.getLastSeenTs()).toBeUndefined();
    fetchMock = mock(async () => {
      throw new Error("should not fetch on bootstrap");
    });

    try {
      await client.replayMissedEvents(ws);
      expect(store.getLastSeenTs()).toBeDefined();
      expect(emitted).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    } finally {
      rawDb.close();
    }
  });

  test("bails out when this.ws !== ownerWs (stale generation)", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const oldWs = makeOpenSocket();
    const newWs = makeOpenSocket();

    // Seed a watermark so we wouldn't bootstrap-skip.
    store.setLastSeenTsIfGreater("1700000000.000000");

    client.ws = newWs;
    fetchMock = mock(async () => {
      throw new Error("should not fetch from a stale generation");
    });

    try {
      await client.replayMissedEvents(oldWs);
      expect(emitted).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    } finally {
      rawDb.close();
    }
  });

  test("recovers a missed app_mention from a routed channel", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");

    fetchMock = mock(async (input) => {
      const url = String(input);
      if (url.includes("conversations.history")) {
        return makeHistoryResponse([
          {
            type: "message",
            user: "U-author",
            text: "<@UBOT> recovered",
            ts: "1700000050.000000",
          },
        ]);
      }
      return makeHistoryResponse([]);
    });

    try {
      await client.replayMissedEvents(ws);
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe(
        "replay:CROUTED01:1700000050.000000",
      );
      expect(emitted[0].event.message.content).toContain("recovered");
      expect(store.getLastSeenTs()).toBe("1700000050.000000");
    } finally {
      rawDb.close();
    }
  });

  test("tolerates conversations.history HTTP 429 without throwing", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");

    fetchMock = mock(async () => {
      return new Response("", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    });

    try {
      await client.replayMissedEvents(ws);
      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("aborts remaining catch-up workers after a single 429", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");
    // Many active threads so the worker pool would otherwise issue many
    // requests in parallel; once one 429s we expect the others to bail.
    for (let i = 0; i < 20; i++) {
      store.trackThread(
        `170000000${i}.000000`,
        `CTHREAD${i}`,
        24 * 60 * 60 * 1_000,
      );
    }

    let calls = 0;
    fetchMock = mock(async () => {
      calls++;
      return new Response("", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    });

    try {
      await client.replayMissedEvents(ws);
      // The first 429 trips the abort flag; later workers see `aborted`
      // and skip without firing additional requests. The exact number of
      // pre-flight calls is bounded by the concurrency limit.
      expect(calls).toBeLessThanOrEqual(4);
      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("ignores routing entries whose key is not a Slack conversation ID", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    // Replace the default Slack-shaped routing key with a non-Slack one
    // (Telegram chat IDs are numeric strings, e.g. "123456789").
    client.config = {
      ...client.config,
      gatewayConfig: {
        ...client.config.gatewayConfig,
        routingEntries: [
          {
            type: "conversation_id",
            key: "123456789",
            assistantId: "ast-telegram",
          },
        ],
      },
    };
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");

    const calls: string[] = [];
    fetchMock = mock(async (input) => {
      calls.push(String(input));
      return makeHistoryResponse([]);
    });

    try {
      await client.replayMissedEvents(ws);
      expect(calls.some((u) => u.includes("channel=123456789"))).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("recovers a missed reply from an active thread via conversations.replies", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");
    store.trackThread("1700000000.000000", "CROUTED01", 24 * 60 * 60 * 1_000);

    const calls: string[] = [];
    fetchMock = mock(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("conversations.replies")) {
        return makeHistoryResponse([
          {
            type: "message",
            user: "U-reply",
            text: "<@UBOT> reply caught up",
            ts: "1700000060.000000",
            thread_ts: "1700000000.000000",
          },
        ]);
      }
      return makeHistoryResponse([]);
    });

    try {
      await client.replayMissedEvents(ws);
      await flushAsyncEventEmission();
      expect(calls.some((u) => u.includes("conversations.replies"))).toBe(true);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe(
        "replay:CROUTED01:1700000060.000000",
      );
    } finally {
      rawDb.close();
    }
  });

  test("skips messages with no ts and the bot's own messages", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    client.ws = ws;

    store.setLastSeenTsIfGreater("1700000000.000000");

    fetchMock = mock(async (input) => {
      if (String(input).includes("conversations.history")) {
        return makeHistoryResponse([
          {
            type: "message",
            user: "UBOT",
            text: "from bot",
            ts: "1700000070.000000",
          },
          { type: "message", user: "U-author", text: "no ts here" },
          {
            type: "message",
            subtype: "channel_join",
            user: "U-x",
            ts: "1700000080.000000",
          },
        ]);
      }
      return makeHistoryResponse([]);
    });

    try {
      await client.replayMissedEvents(ws);
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });
});
