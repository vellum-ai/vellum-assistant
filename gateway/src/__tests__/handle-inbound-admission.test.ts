/**
 * Gateway-side admission policy tests for `handle-inbound.ts`:
 *
 *  - `no_one` kill switch hard-denies pre-forward (P3 §4.2)
 *  - Exempt channels (`vellum`, `platform`, `a2a`) skip the kill switch
 *  - `admissionPolicy` flows into `sourceMetadata` on forward
 *  - Default `trusted_contacts` is attached when no row is persisted
 *
 * Module mocks isolate the test from the live runtime client and the
 * verification intercept so the test exercises only the admission gate.
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
const { AdmissionPolicyStore } = await import("../db/admission-policy-store.js");
const {
  initAdmissionPolicyCache,
  resetAdmissionPolicyCache,
} = await import("../risk/admission-policy-cache.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");

let store: InstanceType<typeof AdmissionPolicyStore>;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "default-assistant",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "default",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

function makeEvent(
  overrides: Record<string, unknown> = {},
): GatewayInboundEvent {
  return {
    sourceChannel: "telegram",
    source: {
      updateId: "u1",
      messageId: "m1",
      chatType: "private",
    },
    actor: {
      actorExternalId: "U_USER_1",
      displayName: "User One",
      username: "userone",
    },
    message: {
      conversationExternalId: "C_CHAT_1",
      externalMessageId: "extmsg-1",
      content: "hi",
    },
    ...overrides,
  } as GatewayInboundEvent;
}

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  store = new AdmissionPolicyStore();
  for (const row of store.list()) store.remove(row.channelType);
  initAdmissionPolicyCache();
  runtimePayloads = [];
  forwardToRuntimeMock.mockClear();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("handle-inbound admission policy", () => {
  test("no_one policy hard-denies and never reaches forwardToRuntime", async () => {
    store.set("telegram", "no_one", "off");
    resetAdmissionPolicyCache();
    initAdmissionPolicyCache();

    const result = await handleInbound(makeConfig(), makeEvent(), {
      routingOverride: { assistantId: "asst-1", routeSource: "default" },
    });

    expect(result.forwarded).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe("admission_no_one");
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
  });

  test("default policy (no row) attaches `trusted_contacts` to sourceMetadata.admissionPolicy", async () => {
    const result = await handleInbound(makeConfig(), makeEvent(), {
      routingOverride: { assistantId: "asst-1", routeSource: "default" },
    });

    expect(result.forwarded).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(runtimePayloads[0]!.sourceMetadata!.admissionPolicy).toBe(
      "trusted_contacts",
    );
  });

  test("attaches the persisted policy to sourceMetadata.admissionPolicy", async () => {
    store.set("telegram", "guardian_only");
    resetAdmissionPolicyCache();
    initAdmissionPolicyCache();

    await handleInbound(makeConfig(), makeEvent(), {
      routingOverride: { assistantId: "asst-1", routeSource: "default" },
    });

    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(runtimePayloads[0]!.sourceMetadata!.admissionPolicy).toBe(
      "guardian_only",
    );
  });

  test("§8.1: exempt channel `vellum` skips kill switch even when `no_one` is persisted", async () => {
    store.set("vellum", "no_one");
    resetAdmissionPolicyCache();
    initAdmissionPolicyCache();

    const result = await handleInbound(
      makeConfig(),
      makeEvent({ sourceChannel: "vellum" }),
      { routingOverride: { assistantId: "asst-1", routeSource: "default" } },
    );

    expect(result.forwarded).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    // Defense in depth: nothing is attached for exempt channels — the
    // runtime's own exempt-channel short-circuit then admits.
    expect(
      runtimePayloads[0]!.sourceMetadata!.admissionPolicy,
    ).toBeUndefined();
  });

  test("§8.1: exempt channel `a2a` does not attach an admissionPolicy", async () => {
    const result = await handleInbound(
      makeConfig(),
      makeEvent({ sourceChannel: "a2a" }),
      { routingOverride: { assistantId: "asst-1", routeSource: "default" } },
    );

    expect(result.forwarded).toBe(true);
    expect(
      runtimePayloads[0]!.sourceMetadata!.admissionPolicy,
    ).toBeUndefined();
  });
});
