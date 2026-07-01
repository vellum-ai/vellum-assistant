import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import * as schema from "../db/schema.js";
import type { RuntimeInboundPayload } from "../runtime/client.js";
import type { NormalizedSlackEvent } from "../slack/normalize.js";
import {
  SLACK_THREAD_ALREADY_MUTED,
  SLACK_THREAD_MUTE_SUCCESS,
} from "../webhook-copy.js";

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
const runtimePayloads: RuntimeInboundPayload[] = [];
const warnLogs: Array<{
  payload: unknown;
  message: string | undefined;
}> = [];

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

mock.module("../runtime/client.js", () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    readonly retryAfterSecs: number;

    constructor(retryAfterSecs: number) {
      super("Circuit breaker is open");
      this.name = "CircuitBreakerOpenError";
      this.retryAfterSecs = retryAfterSecs;
    }
  },
  forwardToRuntime: mock(
    async (_config: GatewayConfig, payload: RuntimeInboundPayload) => {
      runtimePayloads.push(payload);
      return {
        accepted: true,
        duplicate: false,
        eventId: "runtime-event-1",
      };
    },
  ),
}));

mock.module("../logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: (payload: unknown, message?: string) => {
      warnLogs.push({ payload, message });
    },
  }),
}));

mock.module("../verification/text-verification.js", () => ({
  tryTextVerificationIntercept: mock(async () => ({ intercepted: false })),
}));

const { SlackSocketModeClient } = await import("../slack/socket-mode.js");
const { clearChannelInfoCache, clearUserInfoCache, resolveSlackUser } =
  await import("../slack/normalize.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");
const { initGatewayDb, resetGatewayDb } = await import("../db/connection.js");
const { initAdmissionPolicyCache, resetAdmissionPolicyCache } =
  await import("../risk/admission-policy-cache.js");
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
      channel_id TEXT,
      tracked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      detached_at INTEGER
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
    CREATE TABLE channel_bot_identity (
      channel_type TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      metadata TEXT,
      updated_at INTEGER NOT NULL
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
    threadMode: "mention_then_thread",
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

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  initAdmissionPolicyCache();
  runtimePayloads.length = 0;
  warnLogs.length = 0;
  clearUserInfoCache();
  clearChannelInfoCache();
  fetchMock = mock(async () => makeSlackUserResponse());
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("SlackSocketModeClient thread tracking", () => {
  test("handles app mention mute without forwarding or re-tracking the thread", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000000.000000";
    const postBodies: Array<Record<string, unknown>> = [];

    fetchMock = mock(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        postBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, ts: "1700000000.000300" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      store.trackThread(threadTs, "C-thread", 60_000);

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-mute",
          type: "events_api",
          payload: {
            event_id: "Ev-mute",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000000.000100",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
      expect(postBodies).toEqual([
        {
          channel: "C-thread",
          thread_ts: threadTs,
          text: SLACK_THREAD_MUTE_SUCCESS,
        },
      ]);

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-muted-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-muted-reply",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up without mentioning the bot",
              ts: "1700000000.000200",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("acknowledges mute commands for already untracked threads", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000000.000010";
    const postBodies: Array<Record<string, unknown>> = [];

    fetchMock = mock(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        postBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, ts: "1700000000.000030" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-already-muted",
          type: "events_api",
          payload: {
            event_id: "Ev-already-muted",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000000.000020",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
      expect(postBodies).toEqual([
        {
          channel: "C-thread",
          thread_ts: threadTs,
          text: SLACK_THREAD_ALREADY_MUTED,
        },
      ]);
    } finally {
      rawDb.close();
    }
  });

  test("logs Slack mute confirmation API failures", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000000.000040";

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        return new Response(
          JSON.stringify({ ok: false, error: "channel_not_found" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      store.trackThread(threadTs, "C-thread", 60_000);

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-confirmation-failure",
          type: "events_api",
          payload: {
            event_id: "Ev-confirmation-failure",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000000.000050",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
      const warning = warnLogs.find(
        (entry) =>
          entry.message ===
          "Slack thread muted, but confirmation message failed",
      );
      expect(warning).toBeDefined();
      expect(
        String((warning?.payload as { err?: Error })?.err?.message),
      ).toContain("channel_not_found");
    } finally {
      rawDb.close();
    }
  });

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

  test("stamps payload-level team_id onto events lacking an inner team", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-mentioned", "xoxb-test");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-team-wrapper",
          type: "events_api",
          payload: {
            event_id: "Ev-team-wrapper",
            team_id: "T-WORKSPACE",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> hello",
              ts: "1700000000.000100",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.actor.teamId).toBe("T-WORKSPACE");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-team-inner",
          type: "events_api",
          payload: {
            event_id: "Ev-team-inner",
            team_id: "T-WORKSPACE",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> hello again",
              ts: "1700000000.000200",
              channel: "C-thread",
              team: "T-CONNECT-HOME",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[1].event.actor.teamId).toBe("T-CONNECT-HOME");
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
        "@Example User @Example User can you help here?",
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

  test("tracks the thread when the bot posts the first reply, so later replies are admitted (JARVIS-1086)", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    // Thread parent posted by another bot — never tracked, never ingested.
    const threadTs = "1700000000.000500";

    try {
      await resolveSlackUser("U-reply", "xoxb-test");

      // The assistant proactively replies in the thread (e.g. a skill-driven
      // chat.postMessage). The bot's own message echoes back over Socket
      // Mode as a plain `message` event authored by the bot user.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-bot-own-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-bot-own-reply",
            event: {
              type: "message",
              user: "UBOT",
              text: "proactive triage context for <@U-human>",
              ts: "1700000000.000600",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      // The bot's own message is never forwarded, but it must arm the
      // thread so catch-up and the active-thread filter cover it.
      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(true);

      // A human follow-up in that thread (no @-mention) is now admitted.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-human-followup",
          type: "events_api",
          payload: {
            event_id: "Ev-human-followup",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up in the assistant-initiated thread",
              ts: "1700000000.000700",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-human-followup");
      expect(emitted[0].threadTs).toBe(threadTs);
      expect(emitted[0].event.source.threadId).toBe(threadTs);
    } finally {
      rawDb.close();
    }
  });

  test("tracks the bot's first thread reply in actor-routed workspaces, so later replies are admitted (JARVIS-1086)", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    // Workspace routes by actor, not by channel: no conversation_id entry
    // exists for any channel, and unmappedPolicy stays "reject". The key
    // must look like a real Slack user ID (uppercase, U-prefixed) — that's
    // how the tracking check tells Slack actor routes apart from other
    // channels' actor keys in the shared routingEntries list.
    client.config.gatewayConfig.routingEntries = [
      { type: "actor_id", key: "UHUMAN01", assistantId: "ast-actor" },
    ];
    const threadTs = "1700000001.000100";

    try {
      await resolveSlackUser("UHUMAN01", "xoxb-test");

      // The bot's own thread reply echoes back. Its author is the BOT user,
      // which never matches a human actor_id route — the echo must still arm
      // the thread because routed humans can reply here.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-bot-actor-routed-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-bot-actor-routed-reply",
            event: {
              type: "message",
              user: "UBOT",
              text: "proactive update for <@U-human>",
              ts: "1700000001.000200",
              channel: "C-actor-routed",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      // Tracking-only: the echo itself is never forwarded.
      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(true);

      // A routed human's follow-up (no @-mention) is now admitted and
      // resolves through their actor_id route at normalize time.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-actor-routed-followup",
          type: "events_api",
          payload: {
            event_id: "Ev-actor-routed-followup",
            event: {
              type: "message",
              user: "UHUMAN01",
              text: "following up in the assistant-initiated thread",
              ts: "1700000001.000300",
              channel: "C-actor-routed",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-actor-routed-followup");
      expect(emitted[0].threadTs).toBe(threadTs);
      expect(emitted[0].routing).toEqual({
        assistantId: "ast-actor",
        routeSource: "actor_id",
      });

      // An unrouted human's reply in the armed thread is still dropped at
      // normalize time — arming the thread must not loosen forwarding.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-unrouted-actor-followup",
          type: "events_api",
          payload: {
            event_id: "Ev-unrouted-actor-followup",
            event: {
              type: "message",
              user: "USTRANGER9",
              text: "reply from a user with no actor route",
              ts: "1700000001.000400",
              channel: "C-actor-routed",
              channel_type: "channel",
              thread_ts: threadTs,
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

  test("does not track bot replies when the only actor routes belong to other channels (non-Slack keys)", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    // routingEntries is shared across channels; a Telegram-style numeric
    // actor key must not make Slack channels eligible for thread tracking.
    client.config.gatewayConfig.routingEntries = [
      { type: "actor_id", key: "123456789", assistantId: "ast-telegram" },
    ];
    const threadTs = "1700000001.000500";

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-bot-nonslack-actor-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-bot-nonslack-actor-reply",
            event: {
              type: "message",
              user: "UBOT",
              text: "bot reply with only non-Slack actor routes configured",
              ts: "1700000001.000600",
              channel: "C-unrouted",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("does not track bot replies in unrouted channels", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000000.000800";

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-bot-unrouted-reply",
          type: "events_api",
          payload: {
            event_id: "Ev-bot-unrouted-reply",
            event: {
              type: "message",
              user: "UBOT",
              text: "bot reply in a channel with no routing entry",
              ts: "1700000000.000900",
              channel: "C-unrouted",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("does not re-arm a just-muted thread when the mute confirmation echo arrives", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000002.000100";
    const confirmationTs = "1700000002.000300";
    const postBodies: Array<Record<string, unknown>> = [];

    fetchMock = mock(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        postBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: confirmationTs }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return makeSlackUserResponse();
    });

    try {
      // The routed thread is actively tracked (e.g. armed by the bot's
      // own first reply or a prior app mention).
      store.trackThread(threadTs, "C-thread", 60_000);

      // A human mutes the thread: the gateway detaches it and posts a
      // confirmation reply into the same thread.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-mute-then-echo",
          type: "events_api",
          payload: {
            event_id: "Ev-mute-then-echo",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000002.000200",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
      expect(postBodies).toEqual([
        {
          channel: "C-thread",
          thread_ts: threadTs,
          text: SLACK_THREAD_MUTE_SUCCESS,
        },
      ]);

      // The confirmation echoes back over Socket Mode as a bot-authored
      // thread reply. It must NOT re-arm the just-muted thread.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-mute-confirmation-echo",
          type: "events_api",
          payload: {
            event_id: "Ev-mute-confirmation-echo",
            event: {
              type: "message",
              user: "UBOT",
              text: SLACK_THREAD_MUTE_SUCCESS,
              ts: confirmationTs,
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(threadTs)).toBe(false);

      // A later unmentioned human reply stays muted — not forwarded.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-reply-after-mute-echo",
          type: "events_api",
          payload: {
            event_id: "Ev-reply-after-mute-echo",
            event: {
              type: "message",
              user: "U-reply",
              text: "following up without mentioning the bot",
              ts: "1700000002.000400",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("a fresh human @-mention re-arms a muted thread after the confirmation echo", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000003.000100";
    const confirmationTs = "1700000003.000300";

    fetchMock = mock(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        void init;
        return new Response(JSON.stringify({ ok: true, ts: confirmationTs }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return makeSlackUserResponse();
    });

    try {
      await resolveSlackUser("U-mentioned", "xoxb-test");
      await resolveSlackUser("U-reply", "xoxb-test");

      store.trackThread(threadTs, "C-thread", 60_000);

      // Mute the thread, then deliver the bot's confirmation echo.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-rearm-mute",
          type: "events_api",
          payload: {
            event_id: "Ev-rearm-mute",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000003.000200",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-rearm-mute-echo",
          type: "events_api",
          payload: {
            event_id: "Ev-rearm-mute-echo",
            event: {
              type: "message",
              user: "UBOT",
              text: SLACK_THREAD_MUTE_SUCCESS,
              ts: confirmationTs,
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);

      // A human explicitly @-mentions the bot in the muted thread — mute
      // must not be permanent dead state. The mention is forwarded and
      // re-arms the thread per the existing app_mention behavior.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-rearm-mention",
          type: "events_api",
          payload: {
            event_id: "Ev-rearm-mention",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> picking this back up",
              ts: "1700000003.000400",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-rearm-mention");
      expect(store.hasThread(threadTs)).toBe(true);

      // Unmentioned follow-up replies are admitted again.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-rearm-followup",
          type: "events_api",
          payload: {
            event_id: "Ev-rearm-followup",
            event: {
              type: "message",
              user: "U-reply",
              text: "great, continuing the thread",
              ts: "1700000003.000500",
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[1].event.source.updateId).toBe("Ev-rearm-followup");
    } finally {
      rawDb.close();
    }
  });

  test("a mute confirmation echo does not arm a never-tracked thread", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const threadTs = "1700000004.000100";
    const confirmationTs = "1700000004.000300";

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true, ts: confirmationTs }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return makeSlackUserResponse();
    });

    try {
      // Mute command in a thread that was never tracked ("already muted"
      // acknowledgement path).
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-untracked-mute",
          type: "events_api",
          payload: {
            event_id: "Ev-untracked-mute",
            event: {
              type: "app_mention",
              user: "U-mentioned",
              text: "<@UBOT> mute",
              ts: "1700000004.000200",
              channel: "C-thread",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();
      expect(store.hasThread(threadTs)).toBe(false);

      // The "already muted" confirmation echo must not arm the thread.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-untracked-mute-echo",
          type: "events_api",
          payload: {
            event_id: "Ev-untracked-mute-echo",
            event: {
              type: "message",
              user: "UBOT",
              text: SLACK_THREAD_ALREADY_MUTED,
              ts: confirmationTs,
              channel: "C-thread",
              channel_type: "channel",
              thread_ts: threadTs,
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(threadTs)).toBe(false);
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

  test("emits a DM thread reply that omits channel_type via the DM path", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-dm", "xoxb-test");

      // A reply inside a DM thread (e.g. answering an async/cron message the
      // assistant posted). Slack omits `channel_type` on this sub-event and
      // the thread was never armed, so DM-ness must come from the "D" channel
      // ID prefix — otherwise the reply is silently dropped.
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-dm-thread",
          type: "events_api",
          payload: {
            event_id: "Ev-dm-thread",
            event: {
              type: "message",
              user: "U-dm",
              text: "yes, go ahead",
              ts: "1700000000.000600",
              channel: "D-direct",
              thread_ts: "1700000000.000500",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-dm-thread");
      expect(emitted[0].event.source.chatType).toBe("im");
      expect(emitted[0].event.message.conversationExternalId).toBe("D-direct");
      expect(emitted[0].threadTs).toBe("1700000000.000500");
      expect(emitted[0].event.source.threadId).toBe("1700000000.000500");
      // DMs route to the default assistant even when the channel is unmapped.
      expect(emitted[0].routing).toEqual({
        assistantId: "ast-default",
        routeSource: "default",
      });
    } finally {
      rawDb.close();
    }
  });

  test("emits a top-level DM that omits channel_type via the DM path", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-dm", "xoxb-test");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-dm-no-type",
          type: "events_api",
          payload: {
            event_id: "Ev-dm-no-type",
            event: {
              type: "message",
              user: "U-dm",
              text: "hello from dm",
              ts: "1700000000.000700",
              channel: "D-direct",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-dm-no-type");
      expect(emitted[0].event.source.chatType).toBe("im");
      expect(emitted[0].threadTs).toBeUndefined();
    } finally {
      rawDb.close();
    }
  });

  test("admits a DM message edit that omits channel_type", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-dm", "xoxb-test");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-dm-edit",
          type: "events_api",
          payload: {
            event_id: "Ev-dm-edit",
            event: {
              type: "message",
              subtype: "message_changed",
              channel: "D-direct",
              message: {
                user: "U-dm",
                text: "edited in a dm",
                ts: "1700000000.000800",
              },
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-dm-edit");
      expect(emitted[0].event.message.isEdit).toBe(true);
    } finally {
      rawDb.close();
    }
  });

  test("admits a DM message delete that omits channel_type", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await resolveSlackUser("U-dm", "xoxb-test");

      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-dm-delete",
          type: "events_api",
          payload: {
            event_id: "Ev-dm-delete",
            event: {
              type: "message",
              subtype: "message_deleted",
              channel: "D-direct",
              deleted_ts: "1700000000.000900",
              previous_message: {
                user: "U-dm",
                text: "deleted in a dm",
                ts: "1700000000.000900",
              },
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.updateId).toBe("Ev-dm-delete");
      expect(emitted[0].event.message.callbackData).toBe("message_deleted");
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
      expect(emitted[0].event.message.content).toBe(
        "@Example User @Leo please look",
      );
      expect(emitted[0].event.message.content).not.toContain("<@ULEO>");
      expect(emitted[0].event.message.content).not.toContain("ULEO");
    } finally {
      rawDb.close();
    }
  });

  test("renders live app mention channel refs as channel-name labels", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/conversations.info")) {
        expect(url.searchParams.get("channel")).toBe("CFEEDBACK");
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: "CFEEDBACK", name: "user-feedback" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-channel-label",
          type: "events_api",
          payload: {
            event_id: "Ev-channel-label",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> continue in <#CFEEDBACK>",
              ts: "1700000000.000900",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.message.content).toBe(
        "@Example User continue in #user-feedback",
      );
      expect(emitted[0].event.message.content).not.toContain("CFEEDBACK");
    } finally {
      rawDb.close();
    }
  });

  test("emits a plain app mention without resolving the event channel name", async () => {
    const { rawDb, store } = createSlackStore();
    const config = makeConfig();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const conversationInfoChannels: string[] = [];

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/conversations.info")) {
        const channelId = url.searchParams.get("channel");
        if (channelId) {
          conversationInfoChannels.push(channelId);
        }
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: channelId, name: "support-triage" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-channel-name",
          type: "events_api",
          payload: {
            event_id: "Ev-channel-name",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> please summarize this",
              ts: "1700000000.000950",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.channelName).toBeUndefined();
      expect(conversationInfoChannels).toEqual([]);

      await handleInbound(config, emitted[0].event, {
        routingOverride: emitted[0].routing,
      });

      expect(runtimePayloads).toHaveLength(1);
      expect(runtimePayloads[0].sourceMetadata?.channelName).toBeUndefined();
    } finally {
      rawDb.close();
    }
  });

  test("keeps embedded Slack channel labels without conversations.info lookup", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const conversationInfoChannels: string[] = [];

    fetchMock = mock(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/conversations.info")) {
        const channelId = url.searchParams.get("channel");
        if (channelId) {
          conversationInfoChannels.push(channelId);
        }
        return new Response(
          JSON.stringify({
            ok: true,
            channel: { id: channelId, name: "private-name" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return makeSlackUserResponse();
    });

    try {
      client.handleMessage(
        JSON.stringify({
          envelope_id: "env-channel-embedded-label",
          type: "events_api",
          payload: {
            event_id: "Ev-channel-embedded-label",
            event: {
              type: "app_mention",
              user: "U-actor",
              text: "<@UBOT> continue in <#CFEEDBACK|visible-name>",
              ts: "1700000000.001000",
              channel: "C-thread",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.message.content).toBe(
        "@Example User continue in #visible-name",
      );
      expect(conversationInfoChannels).toEqual([]);
    } finally {
      rawDb.close();
    }
  });
});
