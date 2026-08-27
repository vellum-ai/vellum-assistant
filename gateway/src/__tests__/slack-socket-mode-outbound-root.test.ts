/**
 * LUM-2941: wake on replies under the assistant's own top-level posts.
 *
 * When the assistant posted a top-level message into a channel (a heartbeat or
 * triage turn, via the Slack skill's raw `chat.postMessage`), nothing was
 * armed: `maybeTrackBotOwnPost` only tracked echoes that carried a
 * `thread_ts`. A human replying in the thread under that post then failed the
 * active-thread filter and was dropped before the daemon saw it.
 *
 * A top-level echo now arms the post's own `ts` as a *speculative* thread
 * root. Pinned below with the four properties that make that safe to ship:
 * roots are armed only where they buy admission, only for real posts, at a
 * shorter TTL than an inbound thread, and excluded from reconnect catch-up
 * enumeration until a human actually replies.
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
  resolveBotIdentity(): Promise<void>;
};

/** An ordinary channel the assistant posts into. Deliberately unsubscribed. */
const CHANNEL = "C0000000CH1";
/** A 1:1 DM, where every message is admitted without a tracked thread. */
const DM = "D0000000DM1";
/** A group DM. `C`-prefixed, as real workspaces mint MPIMs. */
const MPIM = "C0000000MP1";

/** The assistant's top-level post, from the LUM-2935 live report. */
const BOT_POST_TS = "1785437318.595479";

/** Our app's own `bot_id`, as `auth.test` reports it. */
const OUR_BOT_ID = "B0000000SELF";
/** Another app in the same workspace. Its posts are never ours. */
const OTHER_BOT_ID = "B0000000OTHR";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

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
    // Intentionally empty: no conversation_id entry for CHANNEL, so
    // `isChannelSubscribed` cannot mask the arming behaviour under test.
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
      detached_at INTEGER,
      speculative_root_at INTEGER
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

type ThreadRow = {
  channel_id: string | null;
  expires_at: number;
  speculative_root_at: number | null;
};

/** Raw row read, so the TTL and the speculative marker are both observable. */
function threadRow(rawDb: Database, threadTs: string): ThreadRow | undefined {
  return rawDb
    .prepare(
      "SELECT channel_id, expires_at, speculative_root_at FROM slack_active_threads WHERE thread_ts = ?",
    )
    .get(threadTs) as ThreadRow | undefined;
}

function createHarness(
  store: SlackStore,
  onEvent: (event: NormalizedSlackEvent) => void,
  overrides: Partial<SlackSocketModeConfig> = {},
): SocketModeHarness {
  const harness = Object.create(
    SlackSocketModeClient.prototype,
  ) as SocketModeHarness;
  harness.config = {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    botUserId: "UBOT",
    botId: OUR_BOT_ID,
    botUsername: "assistant",
    teamName: "Example Team",
    gatewayConfig: makeConfig(),
    threadMode: "mention_then_thread",
    ...overrides,
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

/** The Socket Mode echo of a top-level `chat.postMessage` by the assistant. */
function botTopLevelPost(
  channel: string,
  channelType: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    user: "UBOT",
    text: "heartbeat: three PRs are waiting on review",
    ts: BOT_POST_TS,
    channel,
    channel_type: channelType,
    ...extra,
  };
}

/** A human's unmentioned reply in the thread under the assistant's post. */
function humanReply(
  channel: string,
  ts = "1785437359.111100",
): Record<string, unknown> {
  return {
    type: "message",
    user: "U0000000AL1",
    text: "which one is blocking the release?",
    ts,
    channel,
    channel_type: "channel",
    thread_ts: BOT_POST_TS,
  };
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

describe("LUM-2941: arming the assistant's own top-level posts", () => {
  test("admits a human reply under a top-level post the assistant made", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      // The echo itself is never forwarded, but it arms the root.
      expect(emitted).toHaveLength(0);
      expect(store.hasThread(BOT_POST_TS)).toBe(true);

      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.source.updateId).toBe("Ev-human-reply");
      expect(emitted[0]?.threadTs).toBe(BOT_POST_TS);
    } finally {
      rawDb.close();
    }
  });

  test("arms the root at the speculative TTL, then promotes it on the first human reply", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      const armedAt = Date.now();
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      const armed = threadRow(rawDb, BOT_POST_TS);
      expect(armed?.channel_id).toBe(CHANNEL);
      expect(armed?.speculative_root_at).not.toBeNull();
      // Four hours, not the 24h an inbound thread gets. The ceiling is read
      // after delivery so the bound holds however long the write took.
      expect(armed?.expires_at).toBeLessThanOrEqual(Date.now() + FOUR_HOURS_MS);
      expect(armed?.expires_at).toBeGreaterThan(armedAt);

      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      // The reply is real engagement: the row is no longer speculative and
      // carries the full inbound TTL.
      const promoted = threadRow(rawDb, BOT_POST_TS);
      expect(promoted?.speculative_root_at).toBeNull();
      expect(promoted?.expires_at).toBeGreaterThan(armedAt + FOUR_HOURS_MS);
    } finally {
      rawDb.close();
    }
  });

  test("keeps speculative roots out of reconnect catch-up enumeration until a human replies", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      // Every row here costs one tier-3 conversations.replies call on every
      // reconnect. The assistant posts continuously, so roots nobody replied
      // to must not enter the fan-out.
      expect(store.listActiveThreadsWithChannel()).toEqual([]);

      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      expect(store.listActiveThreadsWithChannel()).toEqual([
        { threadTs: BOT_POST_TS, channelId: CHANNEL },
      ]);
    } finally {
      rawDb.close();
    }
  });

  test("arms the assistant's own thread reply at the full TTL, not as a root", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();
    const threadTs = "1785437000.000100";

    try {
      const armedAt = Date.now();
      deliver(client, ws, "Ev-bot-thread-reply", {
        type: "message",
        user: "UBOT",
        text: "picking up this thread",
        ts: "1785437010.000200",
        channel: CHANNEL,
        channel_type: "channel",
        thread_ts: threadTs,
      });
      await flushAsyncEventEmission();

      // The bot joining an existing thread is a participation signal as strong
      // as an inbound one: full TTL, and covered by catch-up.
      const row = threadRow(rawDb, threadTs);
      expect(row?.speculative_root_at).toBeNull();
      expect(row?.expires_at).toBeGreaterThan(armedAt + FOUR_HOURS_MS);
      expect(store.listActiveThreadsWithChannel()).toEqual([
        { threadTs, channelId: CHANNEL },
      ]);
    } finally {
      rawDb.close();
    }
  });

  test("the assistant threading under its own root does not promote it into catch-up", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      const armedAt = Date.now();
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      // The assistant follows up in the thread under its own post (chunked
      // output, a progress update). Nobody has replied to it yet.
      deliver(client, ws, "Ev-bot-followup", {
        type: "message",
        user: "UBOT",
        text: "and here is the detail",
        ts: "1785437330.000100",
        channel: CHANNEL,
        channel_type: "channel",
        thread_ts: BOT_POST_TS,
      });
      await flushAsyncEventEmission();

      // Talking to itself is not engagement: the row stays speculative and out
      // of the fan-out, but its window is refreshed so admission survives for
      // as long as the assistant keeps posting.
      const row = threadRow(rawDb, BOT_POST_TS);
      expect(row?.speculative_root_at).not.toBeNull();
      expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + FOUR_HOURS_MS);
      expect(row?.expires_at).toBeGreaterThanOrEqual(armedAt);
      expect(store.hasThread(BOT_POST_TS)).toBe(true);
      expect(store.listActiveThreadsWithChannel()).toEqual([]);

      // A human reply still promotes it.
      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      expect(threadRow(rawDb, BOT_POST_TS)?.speculative_root_at).toBeNull();
      expect(store.listActiveThreadsWithChannel()).toEqual([
        { threadTs: BOT_POST_TS, channelId: CHANNEL },
      ]);
    } finally {
      rawDb.close();
    }
  });

  test("arms a root without spending any Slack API call", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();
    const calls: string[] = [];

    try {
      fetchMock = mock(async (input) => {
        calls.push(String(input));
        return makeSlackUserResponse();
      });

      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(true);
      // The direct-like guard reads the payload's own `channel_type`. Routing
      // it through the observed-kind cache instead would fire a background
      // `conversations.info` per channel per cache TTL, on a path whose whole
      // point is not to spend Slack's rate limit.
      expect(calls).toEqual([]);
    } finally {
      rawDb.close();
    }
  });

  test("does not arm a root for a bot-authored system subtype", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      // `classifySlackEvent` reports kind "message" for system subtypes too.
      // The assistant being added to a channel opens no conversation.
      deliver(
        client,
        ws,
        "Ev-bot-join",
        botTopLevelPost(CHANNEL, "channel", {
          subtype: "channel_join",
          text: "<@UBOT> has joined the channel",
        }),
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("arms a root for a top-level file_share the assistant posted", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      // A file post is still the assistant saying something repliable.
      deliver(
        client,
        ws,
        "Ev-bot-file",
        botTopLevelPost(CHANNEL, "channel", { subtype: "file_share" }),
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(true);
    } finally {
      rawDb.close();
    }
  });

  test("does not arm a root in a DM", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-bot-dm", botTopLevelPost(DM, "im"));
      await flushAsyncEventEmission();

      // A DM admits every message without a tracked thread, so a root buys
      // nothing and only adds a row.
      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("does not arm a root in a group DM", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-bot-mpim", botTopLevelPost(MPIM, "mpim"));
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("does not arm a root when the ts carries an explicit-detach marker", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      store.detachThread(BOT_POST_TS, CHANNEL);

      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
      expect(store.isThreadDetached(BOT_POST_TS)).toBe(true);
    } finally {
      rawDb.close();
    }
  });

  test("does not arm a root in mention_only thread mode", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {}, {
      threadMode: "mention_only",
    });
    const ws = makeOpenSocket();

    try {
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("a re-delivered echo does not downgrade a root a human already replied into", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();

    try {
      const armedAt = Date.now();
      deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
      await flushAsyncEventEmission();
      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      // Reconnect catch-up can replay the assistant's own post after the reply
      // was already admitted. Re-arming would put the promoted thread back to
      // speculative and drop it out of catch-up again.
      deliver(
        client,
        ws,
        "Ev-bot-post-again",
        botTopLevelPost(CHANNEL, "channel"),
      );
      await flushAsyncEventEmission();

      const row = threadRow(rawDb, BOT_POST_TS);
      expect(row?.speculative_root_at).toBeNull();
      expect(row?.expires_at).toBeGreaterThan(armedAt + FOUR_HOURS_MS);
    } finally {
      rawDb.close();
    }
  });
});

/**
 * The other shape Slack uses for the assistant's own posts.
 *
 * A plain `chat.postMessage` with a bot token is attributed to the bot *user*
 * and carries `user`. A post made with a `username` / `icon_*` override, sent
 * through an incoming webhook, or made by a classic app arrives as
 * `subtype: "bot_message"` with `bot_id` and **no** `user` at all. That shape
 * matched nothing in the `user`-keyed self-filter, so it armed no root and was
 * not even recognized as our own echo.
 */
describe("LUM-2941: the assistant's own bot_message echoes", () => {
  /** The `bot_message` echo shape: `bot_id`, `username`, and no `user`. */
  function botMessagePost(
    channel: string,
    channelType: string,
    botId: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "message",
      subtype: "bot_message",
      bot_id: botId,
      username: "Vex",
      text: "heartbeat: three PRs are waiting on review",
      ts: BOT_POST_TS,
      channel,
      channel_type: channelType,
      ...extra,
    };
  }

  test("arms a root from our own bot_message post, so the human reply is admitted", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      deliver(
        client,
        ws,
        "Ev-bot-message",
        botMessagePost(CHANNEL, "channel", OUR_BOT_ID),
      );
      await flushAsyncEventEmission();

      // Still dropped as our own echo, but now recognized as ours.
      expect(emitted).toHaveLength(0);
      expect(store.hasThread(BOT_POST_TS)).toBe(true);
      expect(threadRow(rawDb, BOT_POST_TS)?.speculative_root_at).not.toBeNull();

      deliver(client, ws, "Ev-human-reply", humanReply(CHANNEL));
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.threadTs).toBe(BOT_POST_TS);
    } finally {
      rawDb.close();
    }
  });

  test("arms the thread from our own bot_message thread reply", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {});
    const ws = makeOpenSocket();
    const threadTs = "1785437000.000100";

    try {
      deliver(
        client,
        ws,
        "Ev-bot-message-reply",
        botMessagePost(CHANNEL, "channel", OUR_BOT_ID, {
          ts: "1785437010.000200",
          thread_ts: threadTs,
        }),
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(threadTs)).toBe(true);
      expect(threadRow(rawDb, threadTs)?.speculative_root_at).toBeNull();
    } finally {
      rawDb.close();
    }
  });

  test("another app's bot_message is not treated as ours", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      // The match is on the exact `bot_id`. A different app posting into the
      // same channel must not arm a root, or the assistant would start waking
      // on threads under other bots' posts in channels it merely observes.
      deliver(
        client,
        ws,
        "Ev-other-bot",
        botMessagePost(CHANNEL, "channel", OTHER_BOT_ID),
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
      // Unsubscribed, unmentioned, untracked: the ordinary filter drops it.
      expect(emitted).toHaveLength(0);
    } finally {
      rawDb.close();
    }
  });

  test("keeps retrying auth.test until bot_id lands, so a bad upgrade self-heals", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {}, {
      botUserId: undefined,
      botId: undefined,
      botUsername: undefined,
    });

    try {
      // The pre-upgrade persisted identity: user id and username, written
      // before `botId` existed.
      store.setBotIdentity({
        userId: "UBOT",
        username: "assistant",
        metadata: { teamName: "Example Team" },
      });

      // First resolution happens during a Slack blip, so it falls back to that
      // persisted row and comes up without a bot_id.
      let authCalls = 0;
      fetchMock = mock(async (input) => {
        if (String(input).includes("auth.test")) {
          authCalls++;
          return new Response(
            JSON.stringify({ ok: false, error: "internal_error" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return makeSlackUserResponse();
      });
      await client.resolveBotIdentity();

      expect(authCalls).toBe(1);
      expect(client.config.botUserId).toBe("UBOT");
      expect(client.config.botId).toBeUndefined();

      // Slack recovers. The next reconnect must retry rather than short-circuit
      // on the populated user fields, or the bot_message self-filter would stay
      // disabled until a full restart.
      fetchMock = mock(async (input) => {
        if (String(input).includes("auth.test")) {
          authCalls++;
          return new Response(
            JSON.stringify({
              ok: true,
              user_id: "UBOT",
              user: "assistant",
              team: "Example Team",
              bot_id: OUR_BOT_ID,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return makeSlackUserResponse();
      });
      await client.resolveBotIdentity();

      expect(authCalls).toBe(2);
      expect(client.config.botId).toBe(OUR_BOT_ID);
      // Persisted, so the next process starts with it.
      expect(
        (store.getBotIdentity("slack")?.metadata as { botId?: string })?.botId,
      ).toBe(OUR_BOT_ID);

      // Now that the answer is authoritative, further reconnects short-circuit.
      await client.resolveBotIdentity();
      expect(authCalls).toBe(2);
    } finally {
      rawDb.close();
    }
  });

  test("fails closed when our bot_id has not been resolved yet", async () => {
    const { rawDb, store } = createSlackStore();
    const client = createHarness(store, () => {}, { botId: undefined });
    const ws = makeOpenSocket();

    try {
      // `auth.test` predating the bot_id field, or a transient resolution
      // failure, must not turn into "every bot_message is ours".
      deliver(
        client,
        ws,
        "Ev-bot-message-no-identity",
        botMessagePost(CHANNEL, "channel", OUR_BOT_ID),
      );
      await flushAsyncEventEmission();

      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });

  test("treats a delete of our own bot_message post like a delete of our own user post", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      // This is a real behaviour change, made for consistency rather than as a
      // side effect. `normalizeSlackMessageDelete` does not require an author
      // (it falls back to "slack-system"), so a delete of a `bot_message`-shaped
      // post used to reach the daemon while the identical delete of a
      // user-attributed assistant post was already self-filtered on
      // `previous_message.user`. Both shapes now behave the same way.
      deliver(client, ws, "Ev-del-ours-botmsg", {
        type: "message",
        subtype: "message_deleted",
        channel: DM,
        channel_type: "im",
        deleted_ts: BOT_POST_TS,
        previous_message: {
          bot_id: OUR_BOT_ID,
          text: "heartbeat",
          ts: BOT_POST_TS,
        },
      });
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(0);

      // A delete of someone else's message in the same DM still forwards, so
      // the filter narrowed to our own posts and nothing wider.
      deliver(client, ws, "Ev-del-theirs", {
        type: "message",
        subtype: "message_deleted",
        channel: DM,
        channel_type: "im",
        deleted_ts: "1785430000.000900",
        previous_message: {
          user: "U0000000AL1",
          text: "their message",
          ts: "1785430000.000900",
        },
      });
      await flushAsyncEventEmission();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.message.eventKind).toBe("delete");
    } finally {
      rawDb.close();
    }
  });

  test("does not forward our own bot_message DM echo back to the daemon", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      // This one held before the bot_id arm too, but only by luck of a later
      // guard: a DM admits every message unconditionally, so the echo passed
      // the admission filter and was caught downstream by
      // `normalizeSlackDirectMessage`, which returns null for both a non
      // `file_share` subtype and a missing `user`. It is now recognized as
      // ours at the self-filter, where every other echo is handled. Pinned so
      // a change to either normalizer guard cannot quietly start feeding the
      // assistant its own posts.
      deliver(
        client,
        ws,
        "Ev-bot-message-dm",
        botMessagePost(DM, "im", OUR_BOT_ID),
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(0);
      expect(store.hasThread(BOT_POST_TS)).toBe(false);
    } finally {
      rawDb.close();
    }
  });
});

/**
 * Arming a root widens three more filters for the root's TTL, because they all
 * consult `hasThread` on the target message's ts. In an ordinary unsubscribed
 * channel a reaction, edit, or delete on the assistant's own post now reaches
 * the daemon where it previously did not. That is the intended reading of
 * "wake on responses to what the assistant said", and is pinned here so it
 * stays a decision rather than a side effect. Each case is paired with the
 * same event on a message the assistant did not post, which still drops.
 */
describe("LUM-2941: filters widened by an armed root", () => {
  async function armRoot(client: SocketModeHarness, ws: WebSocket) {
    deliver(client, ws, "Ev-bot-post", botTopLevelPost(CHANNEL, "channel"));
    await flushAsyncEventEmission();
  }

  test("admits a reaction on the assistant's own top-level post", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await armRoot(client, ws);

      deliver(client, ws, "Ev-reaction", {
        type: "reaction_added",
        user: "U0000000AL1",
        reaction: "eyes",
        item: { type: "message", channel: CHANNEL, ts: BOT_POST_TS },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.message.reaction?.emoji).toBe("eyes");
      expect(emitted[0]?.event.message.reaction?.op).toBe("added");

      // Same channel, a message the assistant never posted: still dropped.
      deliver(client, ws, "Ev-reaction-other", {
        type: "reaction_added",
        user: "U0000000AL1",
        reaction: "tada",
        item: { type: "message", channel: CHANNEL, ts: "1785430000.000900" },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
    } finally {
      rawDb.close();
    }
  });

  test("admits an edit of the assistant's own top-level post", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await armRoot(client, ws);

      deliver(client, ws, "Ev-edit", {
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL,
        channel_type: "channel",
        message: {
          user: "U0000000AL1",
          text: "edited in the assistant's thread",
          ts: BOT_POST_TS,
        },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.message.eventKind).toBe("edit");

      deliver(client, ws, "Ev-edit-other", {
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL,
        channel_type: "channel",
        message: {
          user: "U0000000AL1",
          text: "unrelated edit",
          ts: "1785430000.000900",
        },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
    } finally {
      rawDb.close();
    }
  });

  test("admits a delete of the assistant's own top-level post", async () => {
    const { rawDb, store } = createSlackStore();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

    try {
      await armRoot(client, ws);

      deliver(client, ws, "Ev-del", {
        type: "message",
        subtype: "message_deleted",
        channel: CHANNEL,
        channel_type: "channel",
        deleted_ts: BOT_POST_TS,
        previous_message: {
          user: "U0000000AL1",
          text: "gone",
          ts: BOT_POST_TS,
        },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event.message.eventKind).toBe("delete");

      deliver(client, ws, "Ev-del-other", {
        type: "message",
        subtype: "message_deleted",
        channel: CHANNEL,
        channel_type: "channel",
        deleted_ts: "1785430000.000900",
        previous_message: {
          user: "U0000000AL1",
          text: "unrelated",
          ts: "1785430000.000900",
        },
      });
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
    } finally {
      rawDb.close();
    }
  });
});
