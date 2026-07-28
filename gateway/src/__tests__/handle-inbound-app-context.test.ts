/**
 * Gateway-side `app_context` forwarding tests for `handle-inbound.ts`.
 *
 * `handleInbound` builds `sourceMetadata` by picking fields off `event.source`
 * one at a time, so a field the Slack normalizer sets is silently dropped until
 * it is picked here. These tests assert the pick exists: without it the runtime
 * never learns what the sender had open, and the whole `app_context`
 * subscription is inert.
 *
 * Module mocks isolate the test from the live runtime client and the
 * verification intercept so only the forwarding path is exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type {
  RuntimeInboundPayload,
  RuntimeInboundResponse,
} from "../runtime/client.js";
import type { GatewayInboundEvent } from "../types.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);
let runtimePayloads: RuntimeInboundPayload[] = [];
const forwardToRuntimeMock = mock(
  async (
    _config: GatewayConfig,
    payload: RuntimeInboundPayload,
  ): Promise<RuntimeInboundResponse> => {
    runtimePayloads.push(payload);
    return { accepted: true, duplicate: false, eventId: "runtime-event-1" };
  },
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

mock.module("../runtime/client.js", () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    readonly retryAfterSecs: number;
    constructor(retryAfterSecs: number) {
      super("Circuit breaker is open");
      this.retryAfterSecs = retryAfterSecs;
    }
  },
  forwardToRuntime: (...args: Parameters<typeof forwardToRuntimeMock>) =>
    forwardToRuntimeMock(...args),
}));

mock.module("../verification/text-verification.js", () => ({
  tryTextVerificationIntercept: async () => ({ intercepted: false }),
}));

await import("./test-preload.js");
const { initGatewayDb, resetGatewayDb } = await import("../db/connection.js");
const { initAdmissionPolicyCache, resetAdmissionPolicyCache } =
  await import("../risk/admission-policy-cache.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");

const APP_CONTEXT = {
  entities: [
    { type: "slack#/types/channel_id", value: "C0123ABC" },
    {
      type: "slack#/types/message_context",
      value: { channelId: "C0123ABC", messageTs: "1700000000.000100" },
    },
  ],
};

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: { default: 50 * 1024 * 1024 },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    trustProxy: false,
  } as unknown as GatewayConfig;
}

function makeSlackEvent(
  source: Record<string, unknown> = {},
): GatewayInboundEvent {
  return {
    sourceChannel: "slack",
    source: {
      messageId: "1700000000.000200",
      chatType: "im",
      ...source,
    },
    actor: {
      actorExternalId: "U_USER_1",
      displayName: "User One",
      username: "userone",
    },
    message: {
      conversationExternalId: "D_CHAT_1",
      externalMessageId: "1700000000.000200",
      content: "summarize this",
    },
  } as GatewayInboundEvent;
}

const ROUTING = {
  routingOverride: { assistantId: "asst-1", routeSource: "default" as const },
};

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  initAdmissionPolicyCache();
  runtimePayloads = [];
  forwardToRuntimeMock.mockClear();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("handle-inbound app context", () => {
  test("forwards source.appContext onto sourceMetadata verbatim", async () => {
    await handleInbound(
      makeConfig(),
      makeSlackEvent({ appContext: APP_CONTEXT }),
      ROUTING,
    );

    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    // Verbatim: the runtime validates entity shapes itself, so the gateway must
    // not reshape or filter them on the way through.
    expect(runtimePayloads[0]!.sourceMetadata!.appContext).toEqual(APP_CONTEXT);
  });

  test("omits appContext entirely when the event carries none", async () => {
    await handleInbound(makeConfig(), makeSlackEvent(), ROUTING);

    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(runtimePayloads[0]!.sourceMetadata).not.toHaveProperty("appContext");
  });
});
