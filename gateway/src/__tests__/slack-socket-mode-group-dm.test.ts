/**
 * LUM-2935: admission for Slack group DMs (multi-person IMs).
 *
 * An MPIM was not classified as direct-like, so nothing in one was admitted
 * without an @-mention or a pre-tracked thread: a human's message and any
 * reaction were dropped by the gateway filter before the daemon saw them, and
 * the conversation never appeared at all.
 *
 * Pinned below alongside the negative cases that keep the fix from widening
 * admission for ordinary channels.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import * as schema from "../db/schema.js";
import type { RuntimeInboundPayload } from "../runtime/client.js";
import type { NormalizedSlackEvent } from "../slack/message-schemas.js";

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
      return { accepted: true, duplicate: false, eventId: "runtime-event-1" };
    },
  ),
}));

mock.module("../logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }),
}));

mock.module("../verification/text-verification.js", () => ({
  tryTextVerificationIntercept: mock(async () => ({ intercepted: false })),
}));

const { SlackSocketModeClient } = await import("../slack/socket-mode.js");
const { clearChannelInfoCache, clearUserInfoCache, clearInFlightFetches } =
  await import("../slack/user-directory.js");
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

/** A regular channel the bot posts into. Deliberately NOT a routing entry. */
const CHANNEL = "C0000000CH1";
/**
 * A bot-opened group DM. `C`-prefixed on purpose: real workspaces mint MPIMs
 * with a plain `C` prefix and `is_mpim: true`, which is why the classifier
 * cannot fall back to an id prefix.
 */
const MPIM = "C0000000MP1";

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
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
    // Intentionally empty: neither CHANNEL nor MPIM is a subscribed
    // conversation_id, so `isChannelSubscribed` cannot mask the fix.
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
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

/** Feed one synthetic events_api envelope through the live ingress path. */
function deliver(
  client: SocketModeHarness,
  ws: WebSocket,
  eventId: string,
  event: Record<string, unknown>,
): void {
  client.handleMessage(
    JSON.stringify({
      envelope_id: `env-${eventId}`,
      type: "events_api",
      payload: { event_id: eventId, event },
    }),
    ws,
  );
}

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  initAdmissionPolicyCache();
  runtimePayloads.length = 0;
  clearUserInfoCache();
  clearChannelInfoCache();
  clearInFlightFetches();
  fetchMock = mock(async () => makeSlackUserResponse());
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("LUM-2935: group DM (MPIM) admission", () => {
  test("admits a reaction on a C-prefixed MPIM the bot opened with a top-level post", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const botPostTs = "1785438192.541729";

    try {
      // The bot opens the MPIM with a top-level chat.postMessage. Slack echoes it
      // back; the self-filter drops the event but learns from it.
      deliver(client, ws, "Ev-bot-open", {
        type: "message",
        user: "UBOT",
        text: "opening a group DM",
        ts: botPostTs,
        channel: MPIM,
        channel_type: "mpim",
      });
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(0);

      // A participant reacts. Reaction payloads carry no channel_type at all.
      deliver(client, ws, "Ev-reaction", {
        type: "reaction_added",
        user: "U0000000AL1",
        reaction: "raised_hands",
        item: { type: "message", channel: MPIM, ts: botPostTs },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.message.callbackData).toBe(
        "reaction:raised_hands",
      );
      expect(emitted[0]?.event.message.conversationExternalId).toBe(MPIM);
    } finally {
      rawDb.close();
    }
  });

  test("admits a reaction in an MPIM on a message the bot did not author", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();
    const humanTs = "1785438300.000100";

    try {
      // Isolates the classification fix from thread arming: this message is
      // authored by a human, so no thread root is ever tracked for its ts.
      deliver(client, ws, "Ev-human-msg", {
        type: "message",
        user: "U0000000AL2",
        text: "what do you think?",
        ts: humanTs,
        channel: MPIM,
        channel_type: "mpim",
      });
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);
      expect(store.hasThread(humanTs)).toBe(false);

      deliver(client, ws, "Ev-reaction-2", {
        type: "reaction_added",
        user: "U0000000AL3",
        reaction: "eyes",
        item: { type: "message", channel: MPIM, ts: humanTs },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.event.message.callbackData).toBe("reaction:eyes");
    } finally {
      rawDb.close();
    }
  });

  test("admits a top-level human message in an MPIM and forwards chatType 'mpim'", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-mpim-msg", {
        type: "message",
        user: "U0000000AL2",
        text: "no mention, no thread",
        ts: "1785438400.000200",
        channel: MPIM,
        channel_type: "mpim",
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      // Not "im": the daemon branches on this value for group-chat etiquette
      // (isGroupChatType) and the `private` permission cell
      // (mapChatTypeToConversationType). Flattening to "im" would suppress
      // both.
      expect(emitted[0]?.event.source.chatType).toBe("mpim");
    } finally {
      rawDb.close();
    }
  });

  test("does not mint a thread-scoped conversation for a top-level MPIM message", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-mpim-flat", {
        type: "message",
        user: "U0000000AL2",
        text: "top level",
        ts: "1785438500.000300",
        channel: MPIM,
        channel_type: "mpim",
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      // An MPIM is one continuous conversation, like a DM: a top-level
      // message must not fall back to its own ts as a thread id, or every
      // message would resolve a separate daemon conversation.
      expect(emitted[0]?.event.source.threadId).toBeUndefined();
    } finally {
      rawDb.close();
    }
  });

  test("still drops an unmentioned top-level message in an ordinary channel", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-channel-msg", {
        type: "message",
        user: "U0000000AL4",
        text: "unrelated channel chatter",
        ts: "1785438600.000400",
        channel: CHANNEL,
        channel_type: "channel",
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("still drops a reaction in an unsubscribed, untracked ordinary channel", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-channel-reaction", {
        type: "reaction_added",
        user: "U0000000AL4",
        reaction: "tada",
        item: {
          type: "message",
          channel: CHANNEL,
          ts: "1785438700.000500",
        },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });
});
