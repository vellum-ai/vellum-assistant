/**
 * Tests for the channel-command authorization seam
 * (`authorizeChannelCommand` in `webhook-pipeline.ts`) — the single gate for
 * gateway-terminal commands (`/new` today; `/stop` / `/fork` / `/rename`
 * next, per LUM-2937).
 *
 * The seam resolves authorization through the SAME primitives a channel
 * message does — the admission-policy floor, the canonical
 * `resolveTrustVerdict` classifier, and the shared `enforceAdmissionPolicy`
 * the runtime admission stage evaluates. These tests pin that it is
 * channel-agnostic (telegram / slack / whatsapp behave identically for the
 * same ACL + floor) and that it never grows a per-channel branch.
 *
 * Trust rows are seeded in the real gateway DB rather than mocking the
 * resolver, so the test exercises the actual classification path.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
const { authorizeChannelCommand } = await import("../webhook-pipeline.js");

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
} as unknown as Parameters<typeof authorizeChannelCommand>[2];

function seedContact(opts: {
  channelType: string;
  role?: string;
  status?: string;
  address?: string;
}): void {
  const now = Date.now();
  const id = `${opts.channelType}-${opts.status ?? "active"}-${opts.role ?? "contact"}`;
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
      address: opts.address ?? ACTOR,
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
  resetGatewayDb();
  resetAdmissionPolicyCache();
  await initGatewayDb();
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
  const store = new AdmissionPolicyStore();
  for (const row of store.list()) store.remove(row.channelType);
  initAdmissionPolicyCache();
});

afterEach(() => {
  resetAdmissionPolicyCache();
  resetGatewayDb();
});

describe("authorizeChannelCommand", () => {
  test("denies a stranger under the default `trusted_contacts` floor", async () => {
    const result = await authorizeChannelCommand(
      "telegram",
      ACTOR,
      silentLogger,
    );

    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({
      reason: "admission_policy_trusted_contacts",
    });
  });

  test("admits an active contact under the default floor", async () => {
    seedContact({ channelType: "telegram" });

    const result = await authorizeChannelCommand(
      "telegram",
      ACTOR,
      silentLogger,
    );

    expect(result.allowed).toBe(true);
  });

  test("`no_one` denies the guardian too — the kill switch is off for everyone", async () => {
    seedContact({ channelType: "telegram", role: "guardian" });
    setPolicy("telegram", "no_one");

    const result = await authorizeChannelCommand(
      "telegram",
      ACTOR,
      silentLogger,
    );

    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: "admission_policy_no_one" });
  });

  test("blocked and revoked members are denied even under the `strangers` floor", async () => {
    // Rank alone would clear floor 1; the raw-status hard-deny is what keeps
    // the explicit per-channel governance action winning.
    for (const status of ["blocked", "revoked"] as const) {
      getGatewayDb().delete(gwContactChannels).run();
      getGatewayDb().delete(gwContacts).run();
      seedContact({ channelType: "telegram", status });
      setPolicy("telegram", "strangers");

      const result = await authorizeChannelCommand(
        "telegram",
        ACTOR,
        silentLogger,
      );

      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ reason: `member_${status}` });
    }
  });

  test("`strangers` floor admits an unknown actor — admission, not a guardian gate", async () => {
    setPolicy("telegram", "strangers");

    const result = await authorizeChannelCommand(
      "telegram",
      ACTOR,
      silentLogger,
    );

    expect(result.allowed).toBe(true);
  });

  test("`guardian_only` admits the guardian and denies a plain contact", async () => {
    setPolicy("telegram", "guardian_only");
    seedContact({ channelType: "telegram" });

    expect(
      (await authorizeChannelCommand("telegram", ACTOR, silentLogger)).allowed,
    ).toBe(false);

    getGatewayDb().delete(gwContactChannels).run();
    getGatewayDb().delete(gwContacts).run();
    seedContact({ channelType: "telegram", role: "guardian" });

    expect(
      (await authorizeChannelCommand("telegram", ACTOR, silentLogger)).allowed,
    ).toBe(true);
  });

  test("an actor with no id resolves as unknown and is denied", async () => {
    const result = await authorizeChannelCommand(
      "telegram",
      undefined,
      silentLogger,
    );

    expect(result.allowed).toBe(false);
  });

  test("exempt channel `a2a` skips the check entirely", async () => {
    // `platform`, the other exempt id, is not a `ChannelId` and so cannot
    // reach this seam at all — `a2a` is the reachable exempt case.
    const result = await authorizeChannelCommand("a2a", ACTOR, silentLogger);

    expect(result.allowed).toBe(true);
  });

  test("enforces with the fallback floor when the trust-floors flag is off", async () => {
    // Flag-off message ingress still gets the runtime's ACL enforcement, but
    // a gateway-terminal command has no runtime backstop — so the seam
    // applies the read-path safety default rather than skipping the gate.
    flagEnabled = false;

    expect(
      (await authorizeChannelCommand("telegram", ACTOR, silentLogger)).allowed,
    ).toBe(false);

    seedContact({ channelType: "telegram" });
    expect(
      (await authorizeChannelCommand("telegram", ACTOR, silentLogger)).allowed,
    ).toBe(true);
  });

  test("fails closed (and does not reject) when authorization cannot be resolved", async () => {
    // Tearing down the policy cache makes `resolveAdmissionPolicy` throw.
    // Callers may invoke the seam fire-and-forget (the Slack socket path
    // does), so this must deny rather than surface an unhandled rejection.
    resetAdmissionPolicyCache();

    const result = await authorizeChannelCommand(
      "telegram",
      ACTOR,
      silentLogger,
    );

    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: "authorization_unavailable" });
  });

  test("is channel-agnostic: same ACL + floor decide identically across channels", async () => {
    // The invariant that keeps this from being a Telegram-shaped fix — a
    // Slack or Discord command routes through the same seam unchanged.
    for (const channel of ["telegram", "slack", "whatsapp"] as const) {
      expect(
        (await authorizeChannelCommand(channel, ACTOR, silentLogger)).allowed,
      ).toBe(false);
    }

    for (const channel of ["telegram", "slack", "whatsapp"] as const) {
      seedContact({ channelType: channel });
      expect(
        (await authorizeChannelCommand(channel, ACTOR, silentLogger)).allowed,
      ).toBe(true);
    }
  });

  test("trust is channel-local: a contact on one channel does not authorize another", async () => {
    seedContact({ channelType: "telegram" });

    expect(
      (await authorizeChannelCommand("telegram", ACTOR, silentLogger)).allowed,
    ).toBe(true);
    expect(
      (await authorizeChannelCommand("slack", ACTOR, silentLogger)).allowed,
    ).toBe(false);
  });
});
