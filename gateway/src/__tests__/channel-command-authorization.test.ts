/**
 * Tests for the gateway half of gateway-terminal channel command handling
 * (`/new` today; `/stop` / `/fork` / `/rename` next, per LUM-2937).
 *
 * The gateway owns exactly one decision: the `no_one` kill switch. Everything
 * else (verdict usability, `policy: "deny"`, the admission floor, and the
 * interactive capability) is authorized in the RUNTIME by
 * `handleDeleteConversation`, which has its own suite. These tests pin that
 * the gateway kills when it must, forwards the identity the runtime needs,
 * stays silent on denial, and fails closed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let resetCalls: Array<Record<string, unknown>> = [];
let resetResult: { denied: boolean; reason?: string } = { denied: false };
let resetThrows = false;
mock.module("../runtime/client.js", () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    readonly retryAfterSecs: number;
    constructor(retryAfterSecs: number) {
      super("Circuit breaker is open");
      this.retryAfterSecs = retryAfterSecs;
    }
  },
  resetConversation: async (
    _config: unknown,
    input: Record<string, unknown>,
  ) => {
    if (resetThrows) throw new Error("runtime unreachable");
    resetCalls.push(input);
    return resetResult;
  },
}));

// Admission enforcement is gated behind `channel-trust-floors`. Keep it
// switchable so the flag-off fallback (which must still enforce) is testable.
let flagEnabled = true;
mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (key: string) =>
    key === "channel-trust-floors" && flagEnabled,
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
const { resolveChannelCommandGate, handleNewCommand } =
  await import("../webhook-pipeline.js");

type ChannelIdValue = Parameters<
  InstanceType<typeof AdmissionPolicyStore>["set"]
>[0];
type AdmissionPolicyValue = Parameters<
  InstanceType<typeof AdmissionPolicyStore>["set"]
>[1];

const ACTOR = "actor-1";

const silentLogger = {
  warn: () => {},
  error: () => {},
  info: () => {},
} as unknown as Parameters<typeof handleNewCommand>[0]["logger"];

function seedContact(opts: {
  channelType: string;
  role?: string;
  status?: string;
}): void {
  const now = Date.now();
  const id = `${opts.channelType}-${opts.status ?? "active"}`;
  getGatewayDb()
    .insert(gwContacts)
    .values({
      id: `contact-${id}`,
      displayName: "Test User",
      role: opts.role ?? "contact",
      principalId: opts.role === "guardian" ? "principal-1" : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(gwContactChannels)
    .values({
      id: `channel-${id}`,
      contactId: `contact-${id}`,
      type: opts.channelType,
      address: ACTOR,
      externalChatId: null,
      status: opts.status ?? "active",
      policy: "allow",
      verifiedAt: now,
      verifiedVia: "challenge",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

function setPolicy(
  channelType: ChannelIdValue,
  policy: AdmissionPolicyValue,
): void {
  new AdmissionPolicyStore().set(channelType, policy);
  resetAdmissionPolicyCache();
  initAdmissionPolicyCache();
}

beforeEach(async () => {
  flagEnabled = true;
  resetCalls = [];
  resetResult = { denied: false };
  resetThrows = false;
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
  const store = new AdmissionPolicyStore();
  for (const row of store.list()) {
    store.remove(row.channelType);
  }
  initAdmissionPolicyCache();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("resolveChannelCommandGate", () => {
  test("`no_one` kills the command for everyone, guardian included", async () => {
    seedContact({ channelType: "telegram", role: "guardian" });
    setPolicy("telegram", "no_one");

    const gate = await resolveChannelCommandGate("telegram", ACTOR);

    expect(gate.killed).toBe(true);
  });

  test("forwards the resolved verdict and floor for the runtime to judge", async () => {
    seedContact({ channelType: "telegram" });

    const gate = await resolveChannelCommandGate("telegram", ACTOR);

    expect(gate).toMatchObject({
      killed: false,
      admissionPolicy: "trusted_contacts",
    });
    expect(gate.killed === false && gate.trustVerdict.trustClass).toBe(
      "trusted_contact",
    );
  });

  test("does not decide admission itself: a stranger still passes the gate", async () => {
    // The gateway deliberately forwards rather than judging. The runtime
    // denies this actor; a gateway-side verdict check here would be the
    // second authorization model this design exists to avoid.
    const gate = await resolveChannelCommandGate("telegram", ACTOR);

    expect(gate.killed).toBe(false);
  });

  test("exempt channel `a2a` carries no floor", async () => {
    const gate = await resolveChannelCommandGate("a2a", ACTOR);

    expect(gate).toMatchObject({ killed: false });
    expect(gate.killed === false && gate.admissionPolicy).toBeUndefined();
  });

  test("still resolves a floor when the trust-floors flag is off", async () => {
    // Flag-off message ingress still gets the runtime's ACL enforcement, and
    // so does a command: the fallback floor is forwarded rather than omitted.
    flagEnabled = false;

    const gate = await resolveChannelCommandGate("telegram", ACTOR);

    expect(gate).toMatchObject({
      killed: false,
      admissionPolicy: "trusted_contacts",
    });
  });

  test("is channel-agnostic: same shape across channels", async () => {
    for (const channel of ["telegram", "slack", "whatsapp"] as const) {
      const gate = await resolveChannelCommandGate(channel, ACTOR);
      expect(gate.killed).toBe(false);
    }
  });
});

describe("handleNewCommand", () => {
  function makeRequest() {
    const replies: string[] = [];
    const notices: string[] = [];
    const req = {
      config: {} as never,
      sourceChannel: "telegram" as const,
      conversationExternalId: "C1",
      actorExternalId: ACTOR,
      sendReply: async (text: string) => {
        replies.push(text);
      },
      sendNotice: (text: string) => {
        notices.push(text);
      },
      logger: silentLogger,
    };
    return { req, replies, notices };
  }

  test("a killed channel never reaches the runtime and stays silent", async () => {
    setPolicy("telegram", "no_one");
    const { req, replies, notices } = makeRequest();

    await handleNewCommand(req);

    expect(resetCalls).toEqual([]);
    expect(replies).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("forwards the trust verdict and floor to the runtime", async () => {
    seedContact({ channelType: "telegram" });
    const { req } = makeRequest();

    await handleNewCommand(req);

    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0]).toMatchObject({
      sourceChannel: "telegram",
      conversationExternalId: "C1",
      admissionPolicy: "trusted_contacts",
    });
    expect(
      (resetCalls[0]!.trustVerdict as { trustClass: string }).trustClass,
    ).toBe("trusted_contact");
  });

  test("a runtime denial is silent: no confirmation, no notice", async () => {
    resetResult = { denied: true, reason: "not_interactive" };
    const { req, replies, notices } = makeRequest();

    await handleNewCommand(req);

    expect(replies).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("an authorized reset confirms to the sender", async () => {
    seedContact({ channelType: "telegram" });
    const { req, replies, notices } = makeRequest();

    await handleNewCommand(req);

    expect(replies).toEqual(["Starting a new conversation!"]);
    expect(notices).toEqual([]);
  });

  test("a runtime failure notifies through the throttled sender", async () => {
    resetThrows = true;
    const { req, replies, notices } = makeRequest();

    await handleNewCommand(req);

    expect(replies).toEqual([]);
    expect(notices).toEqual([
      "Failed to reset conversation. Please try again.",
    ]);
  });

  test("fails closed when the gate itself cannot be resolved", async () => {
    // Tearing down the policy cache makes `resolveAdmissionPolicy` throw.
    // Callers may invoke this fire-and-forget (the Slack socket path does),
    // so it must deny rather than surface an unhandled rejection.
    resetAdmissionPolicyCache();
    const { req, replies, notices } = makeRequest();

    await handleNewCommand(req);

    expect(resetCalls).toEqual([]);
    expect(replies).toEqual([]);
    expect(notices).toEqual([
      "Failed to reset conversation. Please try again.",
    ]);
  });
});
