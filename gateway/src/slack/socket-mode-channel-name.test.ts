import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import * as schema from "../db/schema.js";
import type { RuntimeInboundPayload } from "../runtime/client.js";
import type { NormalizedSlackEvent } from "./normalize.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const runtimePayloads: RuntimeInboundPayload[] = [];

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () =>
  makeSlackResponse({ ok: true }),
);

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

mock.module("../verification/text-verification.js", () => ({
  tryTextVerificationIntercept: mock(async () => ({ intercepted: false })),
}));

const { SlackSocketModeClient } = await import("./socket-mode.js");
const { clearChannelInfoCache, clearUserInfoCache } =
  await import("./normalize.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");
import type { SlackSocketModeConfig } from "./socket-mode.js";

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
        key: "C-channel",
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

function makeSlackResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
  runtimePayloads.length = 0;
  clearUserInfoCache();
  clearChannelInfoCache();
  fetchMock = mock(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conversations.info")) {
      return makeSlackResponse({
        ok: true,
        channel: { name: "support-triage" },
      });
    }
    if (url.pathname.endsWith("/users.info")) {
      return makeSlackResponse({
        ok: true,
        user: {
          name: "example-user",
          profile: { display_name: "Example User" },
        },
      });
    }
    return makeSlackResponse({ ok: true });
  });
});

describe("Slack Socket Mode channel names", () => {
  test("forwards resolved channel name in runtime source metadata", async () => {
    const { rawDb, store } = createSlackStore();
    const config = makeConfig();
    const emitted: NormalizedSlackEvent[] = [];
    const client = createHarness(store, (event) => emitted.push(event));
    const ws = makeOpenSocket();

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
              ts: "1700000000.000100",
              channel: "C-channel",
            },
          },
        }),
        ws,
      );
      await flushAsyncEventEmission();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event.source.channelName).toBe("support-triage");

      await handleInbound(config, emitted[0].event, {
        routingOverride: emitted[0].routing,
      });

      expect(runtimePayloads).toHaveLength(1);
      expect(runtimePayloads[0].sourceMetadata?.channelName).toBe(
        "support-triage",
      );
    } finally {
      rawDb.close();
    }
  });
});
