/**
 * Gateway-side trust-verdict stamping tests for `handle-inbound.ts`:
 *
 *  - A normal inbound carries `sourceMetadata.trustVerdict` matching the
 *    actor's gateway-DB ACL (guardian / trusted_contact / unknown).
 *  - The `admissionPolicy` floor stamp coexists unchanged with the new verdict.
 *  - The verification-code intercept short-circuits — no forward, no stamp.
 *  - A resolver failure stamps a `resolutionFailed` sentinel and still forwards
 *    (fail-soft).
 *
 * Module mocks isolate the test from the live runtime client. The
 * verification intercept is mocked per-test so the default path forwards.
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

let interceptResult: { intercepted: boolean; [k: string]: unknown } = {
  intercepted: false,
};
const tryTextVerificationInterceptMock = mock(async () => interceptResult);

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
  tryTextVerificationIntercept: (...args: unknown[]) =>
    tryTextVerificationInterceptMock(...(args as [])),
}));

// Admission enforcement is gated behind `channel-trust-floors`; enable it so
// the floor stamp coexists with the new verdict stamp.
mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (key: string) => key === "channel-trust-floors",
}));

await import("./test-preload.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { AdmissionPolicyStore } =
  await import("../db/admission-policy-store.js");
const { initAdmissionPolicyCache, resetAdmissionPolicyCache } =
  await import("../risk/admission-policy-cache.js");
const { contacts: gwContacts, contactChannels: gwContactChannels } =
  await import("../db/schema.js");
const { handleInbound } = await import("../handlers/handle-inbound.js");

const CHANNEL = "telegram";

function insertContact(args: {
  id: string;
  displayName: string;
  role?: string;
  principalId?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContacts)
    .values({
      id: args.id,
      displayName: args.displayName,
      role: args.role ?? "contact",
      principalId: args.principalId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function insertChannel(args: {
  id: string;
  contactId: string;
  type?: string;
  address: string;
  externalChatId?: string | null;
  status?: string;
  policy?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContactChannels)
    .values({
      id: args.id,
      contactId: args.contactId,
      type: args.type ?? CHANNEL,
      address: args.address,
      externalChatId: args.externalChatId ?? null,
      status: args.status ?? "active",
      policy: args.policy ?? "allow",
      verifiedAt: now,
      verifiedVia: "challenge",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "default-assistant",
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
    unmappedPolicy: "default",
    trustProxy: false,
  } as unknown as GatewayConfig;
}

function makeEvent(
  overrides: Record<string, unknown> = {},
): GatewayInboundEvent {
  return {
    sourceChannel: CHANNEL,
    source: { updateId: "u1", messageId: "m1", chatType: "private" },
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

const ROUTING = {
  routingOverride: { assistantId: "asst-1", routeSource: "default" as const },
};

beforeEach(async () => {
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  // initGatewayDb reconnects to the same on-disk DB; clear leftover rows
  // (channels first — FK cascade from contacts).
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
  const store = new AdmissionPolicyStore();
  for (const row of store.list()) store.remove(row.channelType);
  initAdmissionPolicyCache();
  runtimePayloads = [];
  forwardToRuntimeMock.mockClear();
  interceptResult = { intercepted: false };
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("handle-inbound trust verdict stamping", () => {
  test("active guardian actor → sourceMetadata.trustVerdict.trustClass === 'guardian'", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "The Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      address: "U_USER_1",
      externalChatId: "chat-guardian",
      status: "active",
    });

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.forwarded).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("guardian");
    expect(verdict.canonicalSenderId).toBe("U_USER_1");
    expect(verdict.guardianExternalUserId).toBe("U_USER_1");
  });

  test("active member channel → trustVerdict 'trusted_contact' with member ACL fields", async () => {
    insertContact({ id: "c-member", displayName: "Trusted Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_USER_1",
      externalChatId: "chat-member",
      status: "active",
    });

    await handleInbound(makeConfig(), makeEvent(), ROUTING);

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.status).toBe("active");
    expect(verdict.policy).toBe("allow");
    expect(verdict.contactId).toBe("c-member");
    expect(verdict.channelId).toBe("ch-member");
    expect(verdict.memberDisplayName).toBe("Trusted Member");
  });

  test("unknown actor (no rows) → trustVerdict 'unknown', canonicalSenderId set, not resolutionFailed", async () => {
    await handleInbound(makeConfig(), makeEvent(), ROUTING);

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.canonicalSenderId).toBe("U_USER_1");
    expect(verdict.contactId).toBeUndefined();
    // A real stranger is NOT flagged as a resolver failure.
    expect(verdict.resolutionFailed).toBeUndefined();
  });

  test("admissionPolicy stamp present and unchanged alongside the new trustVerdict", async () => {
    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.forwarded).toBe(true);
    const sm = runtimePayloads[0]!.sourceMetadata!;
    // Default floor (no persisted row) is still attached.
    expect(sm.admissionPolicy).toBe("trusted_contacts");
    expect(sm.trustVerdict!.trustClass).toBe("unknown");
  });

  test("verification-code intercept short-circuits — no forward, no stamp", async () => {
    interceptResult = {
      intercepted: true,
      outcome: "verified",
      trustClass: "guardian",
      pendingReplyText: "Verified!",
    };

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.verificationIntercepted).toBe(true);
    expect(result.forwarded).toBe(false);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(0);
  });

  test("resolver throw → inbound forwards with a resolutionFailed sentinel (fail-soft)", async () => {
    // Drop the gateway DB connection so resolveTrustVerdict's getGatewayDb()
    // throws. The admission cache is in-memory and unaffected, so its floor
    // stamp still flows.
    resetGatewayDb();

    const result = await handleInbound(makeConfig(), makeEvent(), ROUTING);

    expect(result.forwarded).toBe(true);
    expect(forwardToRuntimeMock).toHaveBeenCalledTimes(1);
    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.resolutionFailed).toBe(true);
    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.canonicalSenderId).toBe("U_USER_1");
    expect(verdict.contactId).toBeUndefined();
    // The floor stamp still flows even when verdict resolution fails.
    expect(runtimePayloads[0]!.sourceMetadata!.admissionPolicy).toBe(
      "trusted_contacts",
    );
  });

  test("resolver throw with whitespace-only actor id → sentinel canonicalSenderId is null", async () => {
    resetGatewayDb();

    await handleInbound(
      makeConfig(),
      makeEvent({
        actor: { actorExternalId: "   ", displayName: "Blank", username: "" },
      }),
      ROUTING,
    );

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.resolutionFailed).toBe(true);
    expect(verdict.trustClass).toBe("unknown");
    // Matches a real resolve: whitespace-only id normalizes to absent.
    expect(verdict.canonicalSenderId).toBeNull();
  });
});

describe("handle-inbound sender-authentication downgrade", () => {
  const GUARDIAN_EMAIL = "guardian@example.com";

  function makeEmailEvent(): GatewayInboundEvent {
    return makeEvent({
      sourceChannel: "email",
      actor: {
        actorExternalId: GUARDIAN_EMAIL,
        displayName: "The Guardian",
        username: GUARDIAN_EMAIL,
      },
      message: {
        conversationExternalId: "thread-1",
        externalMessageId: "extmsg-email-1",
        content: "please run this",
      },
    });
  }

  function insertGuardianEmailContact(): void {
    insertContact({
      id: "c-guardian",
      displayName: "The Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      type: "email",
      address: GUARDIAN_EMAIL,
      externalChatId: "thread-guardian",
      status: "active",
    });
  }

  test("forged guardian From: with senderAuthenticated=false → verdict downgraded to stranger", async () => {
    // The address matches the active guardian binding, so absent the auth
    // signal this classifies `guardian`. A spoofed From: that failed
    // SPF/DKIM/DMARC must NOT inherit that trust.
    insertGuardianEmailContact();

    await handleInbound(makeConfig(), makeEmailEvent(), {
      ...ROUTING,
      senderAuthenticated: false,
    });

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("unknown");
    // Guardian + member fields are stripped so no residual trust is rebuilt.
    expect(verdict.guardianExternalUserId).toBeUndefined();
    expect(verdict.guardianPrincipalId).toBeUndefined();
    expect(verdict.contactId).toBeUndefined();
    // A real stranger, not a resolver failure — flows through the normal
    // admission floor + verification lane.
    expect(verdict.resolutionFailed).toBeUndefined();
    // Canonical sender identity is preserved for logging / verification reply.
    expect(verdict.canonicalSenderId).toBe(GUARDIAN_EMAIL);
  });

  test("authenticated guardian From: with senderAuthenticated=true → verdict stays guardian", async () => {
    insertGuardianEmailContact();

    await handleInbound(makeConfig(), makeEmailEvent(), {
      ...ROUTING,
      senderAuthenticated: true,
    });

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("guardian");
    expect(verdict.guardianExternalUserId).toBe(GUARDIAN_EMAIL);
  });

  test("absent signal (senderAuthenticated undefined) preserves the resolved verdict", async () => {
    // Backward-compat: an older platform that sends no signal must not have
    // its senders downgraded (enforcement only engages on an explicit false).
    insertGuardianEmailContact();

    await handleInbound(makeConfig(), makeEmailEvent(), ROUTING);

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("guardian");
  });

  test("forged trusted_contact From: with senderAuthenticated=false → downgraded to stranger", async () => {
    insertContact({ id: "c-member", displayName: "Trusted Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      type: "email",
      address: GUARDIAN_EMAIL,
      externalChatId: "thread-member",
      status: "active",
    });

    await handleInbound(makeConfig(), makeEmailEvent(), {
      ...ROUTING,
      senderAuthenticated: false,
    });

    const verdict = runtimePayloads[0]!.sourceMetadata!.trustVerdict!;
    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.contactId).toBeUndefined();
    expect(verdict.status).toBeUndefined();
  });
});
