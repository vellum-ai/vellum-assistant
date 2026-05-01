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

function makeSlackUserResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      user: {
        name: "example-user",
        profile: { display_name: "Example User" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () =>
  makeSlackUserResponse(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { SlackSocketModeClient } = await import("../slack/socket-mode.js");
const { clearUserInfoCache, resolveSlackUser } =
  await import("../slack/normalize.js");
import type { SlackSocketModeConfig } from "../slack/socket-mode.js";

type SocketModeHarness = {
  config: SlackSocketModeConfig;
  onEvent: (event: NormalizedSlackEvent) => void;
  store: SlackStore;
  handleMessage(raw: string, originWs: WebSocket): void;
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
        key: "C-thread",
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
      tracked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE slack_seen_events (
      event_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return { rawDb, store: new SlackStore(drizzle(rawDb, { schema })) };
}

function createHarness(
  store: SlackStore,
  onEvent: (event: NormalizedSlackEvent) => void,
): SocketModeHarness {
  const harness = Object.create(
    SlackSocketModeClient.prototype,
  ) as SocketModeHarness;
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

beforeEach(() => {
  clearUserInfoCache();
  fetchMock = mock(async () => makeSlackUserResponse());
});

describe("SlackSocketModeClient thread tracking", () => {
  test("accepts unmentioned thread replies immediately after an app mention", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await Promise.all([
        resolveSlackUser("U-mentioned", "xoxb-test"),
        resolveSlackUser("U-reply", "xoxb-test"),
      ]);

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-mention",
          type: "events_api",
          payload: {
            event_id: "Ev-mention",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> can you help here?",
              ts: "1700000000.000100",
              channel: "C-thread",
              thread_ts: "1700000000.000000",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-mention");
      expect(emitted[0].threadTs).toBe("1700000000.000000");
      expect(emitted[0].event.source.threadId).toBe("1700000000.000000");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-reply",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up without mentioning the bot",
              ts: "1700000000.000200",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: "1700000000.000000",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[1].event.source.updateId).toBe("Ev-reply");
      expect(emitted[1].event.message.content).toBe(
        "following up without mentioning the bot",
      );
      expect(emitted[1].event.source.chatType).toBe("channel");
      expect(emitted[1].threadTs).toBe("1700000000.000000");
      expect(emitted[1].event.source.threadId).toBe("1700000000.000000");
    } finally {
      rawDb.close();
    }
  });

  test("emits a slow app mention before its immediate thread reply", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    let resolveDelayedMention: ((response: Response) => void) | undefined;

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      const userId = url.searchParams.get("user");
      if (userId === "ULEO") {
        return new Promise<Response>((resolve) => {
          resolveDelayedMention = resolve;
        });
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-race-mention",
          type: "events_api",
          payload: {
            event_id: "Ev-race-mention",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> <@ULEO> can you help here?",
              ts: "1700000000.000150",
              channel: "C-thread",
              thread_ts: "1700000000.000140",
            },
          },
        }),
        ws,
      );

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-race-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-race-reply",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up while lookup is still pending",
              ts: "1700000000.000160",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: "1700000000.000140",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);

      expect(resolveDelayedMention).toBeDefined();
      resolveDelayedMention!(makeSlackUserResponse());
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[0].event.source.updateId).toBe("Ev-race-mention");
      expect(emitted[0].event.message.content).toBe(
        "@Example User can you help here?",
      );
      expect(emitted[1].event.source.updateId).toBe("Ev-race-reply");
      expect(emitted[1].event.message.content).toBe(
        "following up while lookup is still pending",
      );
    } finally {
      rawDb.close();
    }
  });

  test("does not pre-track unrouted app mention threads during slow mentioned-user lookup", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    let resolveDelayedMention: ((response: Response) => void) | undefined;

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      const userId = url.searchParams.get("user");
      if (userId === "USLOW") {
        return new Promise<Response>((resolve) => {
          resolveDelayedMention = resolve;
        });
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-unrouted-mention",
          type: "events_api",
          payload: {
            event_id: "Ev-unrouted-mention",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> <@USLOW> can you help here?",
              ts: "1700000000.000250",
              channel: "C-unrouted",
              thread_ts: "1700000000.000240",
            },
          },
        }),
        ws,
      );

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-unrouted-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-unrouted-reply",
            event: {
              type: "message",
              user: "U-reply",
              text: "reply should not be admitted by rejected mention",
              ts: "1700000000.000260",
              channel: "C-unrouted",
              channel_type: "channel",
              thread_ts: "1700000000.000240",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);

      expect(resolveDelayedMention).toBeDefined();
      resolveDelayedMention!(makeSlackUserResponse());
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("accepts unmentioned thread replies after a top-level app mention", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await Promise.all([
        resolveSlackUser("U-mentioned", "xoxb-test"),
        resolveSlackUser("U-reply", "xoxb-test"),
      ]);

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-top-level-mention",
          type: "events_api",
          payload: {
            event_id: "Ev-top-level-mention",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> can you help here?",
              ts: "1700000000.000300",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-top-level-mention");
      expect(emitted[0].threadTs).toBe("1700000000.000300");
      expect(emitted[0].event.source.threadId).toBeUndefined();

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-top-level-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-top-level-reply",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up in the new thread",
              ts: "1700000000.000400",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: "1700000000.000300",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[1].event.source.updateId).toBe("Ev-top-level-reply");
      expect(emitted[1].event.message.content).toBe(
        "following up in the new thread",
      );
      expect(emitted[1].event.source.chatType).toBe("channel");
      expect(emitted[1].threadTs).toBe("1700000000.000300");
      expect(emitted[1].event.source.threadId).toBe("1700000000.000300");
    } finally {
      rawDb.close();
    }
  });

  test("emits direct messages with im chat type for assistant backfill", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-dm", "xoxb-test");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-dm",
          type: "events_api",
          payload: {
            event_id: "Ev-dm",
            event: {
              type: "message",
              user: "U-dm",
              text: "hello from dm",
              ts: "1700000000.000500",
              channel: "D-direct",
              channel_type: "im",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-dm");
      expect(emitted[0].event.source.chatType).toBe("im");
      expect(emitted[0].event.message.conversationExternalId).toBe("D-direct");
      expect(emitted[0].threadTs).toBeUndefined();
      expect(emitted[0].event.source.threadId).toBeUndefined();
    } finally {
      rawDb.close();
    }
  });

  test.each([
    {
      name: "reaction",
      seedEventId: "Ev-reaction",
      seedEvent: {
        type: "reaction_added",
        user: "U-reactor",
        reaction: "eyes",
        item: {
          type: "message",
          channel: "C-thread",
          ts: "1700000000.000500",
        },
        item_user: "U-author",
        event_ts: "1700000000.000501",
      },
      replyThreadTs: "1700000000.000500",
    },
    {
      name: "message edit",
      seedEventId: "Ev-edit",
      seedEvent: {
        type: "message",
        subtype: "message_changed",
        channel: "C-thread",
        channel_type: "channel",
        message: {
          user: "U-editor",
          text: "edited message",
          ts: "1700000000.000600",
          thread_ts: "1700000000.000550",
        },
      },
      replyThreadTs: "1700000000.000550",
    },
    {
      name: "message delete",
      seedEventId: "Ev-delete",
      seedEvent: {
        type: "message",
        subtype: "message_deleted",
        channel: "C-thread",
        channel_type: "channel",
        deleted_ts: "1700000000.000700",
        previous_message: {
          user: "U-author",
          text: "deleted message",
          ts: "1700000000.000700",
          thread_ts: "1700000000.000650",
        },
      },
      replyThreadTs: "1700000000.000650",
    },
  ])(
    "does not arm active thread tracking for admitted $name events",
    async ({ seedEventId, seedEvent, replyThreadTs }) => {
      const { rawDb, store } = createSlackStore();
      const emitted: NormalizedSlackEvent[] = [];
      const client = createHarness(store, (event) => emitted.push(event));
      const ws = makeOpenSocket();

      try {
        await Promise.all([
          resolveSlackUser("U-reactor", "xoxb-test"),
          resolveSlackUser("U-editor", "xoxb-test"),
          resolveSlackUser("U-author", "xoxb-test"),
          resolveSlackUser("U-reply", "xoxb-test"),
        ]);

        client.handleMessage(
          JSON.stringify({
            envelope_id: `env-${seedEventId}`,
            type: "events_api",
            payload: {
              event_id: seedEventId,
              event: seedEvent,
            },
          }),
          ws,
        );
        await flushAsyncEventEmission();

        expect(emitted).toHaveLength(1);
        expect(emitted[0].event.source.updateId).toBe(seedEventId);
        expect(emitted[0].threadTs).toBe(replyThreadTs);

        client.handleMessage(
          JSON.stringify({
            envelope_id: `env-reply-${seedEventId}`,
            type: "events_api",
            payload: {
              event_id: `Ev-reply-${seedEventId}`,
              event: {
                type: "message",
                user: "U-reply",
                text: "unmentioned reply should stay filtered",
                ts: `${replyThreadTs}-reply`,
                channel: "C-thread",
                channel_type: "channel",
                thread_ts: replyThreadTs,
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
    },
  );

  test("renders live app mention user IDs as display-name labels", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      const userId = url.searchParams.get("user");
      if (userId === "ULEO") {
        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              name: "leo",
              profile: { display_name: "Leo" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-mention-label",
          type: "events_api",
          payload: {
            event_id: "Ev-mention-label",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> <@ULEO> please look",
              ts: "1700000000.000800",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.message.content).toBe("@Leo please look");
      expect(emitted[0].event.message.content).not.toContain("<@ULEO>");
      expect(emitted[0].event.message.content).not.toContain("ULEO");
    } finally {
      rawDb.close();
    }
  });
});
