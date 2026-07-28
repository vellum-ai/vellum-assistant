/**
 * Tests for the `resolve_inbound_trust` IPC route.
 *
 * Seeds the gateway ACL DB directly (contacts + contact_channels) and invokes
 * the route handler with params, asserting the returned verdict matches the
 * resolver output for guardian / member / unknown actors and that the
 * envelope carries the channel admission policy from the same store
 * `get_channel_admission_policy` reads.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AdmissionPolicy } from "@vellumai/gateway-client";

await import("../../__tests__/test-preload.js");

// Leak-safe snapshot-spread delegating mock: only resolveAdmissionPolicy is
// overridden, and it delegates to a per-test implementation.
const actualAdmissionPolicyCache = await import(
  "../../risk/admission-policy-cache.js"
);
let resolveAdmissionPolicyImpl: (channelType: string) => AdmissionPolicy | null =
  () => null;
mock.module("../../risk/admission-policy-cache.js", () => ({
  ...actualAdmissionPolicyCache,
  resolveAdmissionPolicy: (channelType: string) =>
    resolveAdmissionPolicyImpl(channelType),
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } = await import(
  "../../db/connection.js"
);
const { contacts: gwContacts, contactChannels: gwContactChannels } =
  await import("../../db/schema.js");
const { resolveTrustVerdict } = await import(
  "../../risk/trust-verdict-resolver.js"
);
const { trustVerdictRoutes } = await import("../trust-verdict-handlers.js");

const CHANNEL = "telegram";

const route = trustVerdictRoutes.find(
  (r) => r.method === "resolve_inbound_trust",
)!;

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

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
  resolveAdmissionPolicyImpl = () => null;
});

afterEach(() => {
  resetGatewayDb();
});

describe("resolve_inbound_trust route", () => {
  test("registers the resolve_inbound_trust method with a schema", () => {
    expect(route.method).toBe("resolve_inbound_trust");
    expect(route.schema).toBeDefined();
  });

  test("guardian actor → verdict matching the resolver output", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "The Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      address: "U_GUARDIAN",
      externalChatId: "chat-guardian",
    });

    const params = { channelType: CHANNEL, actorExternalId: "U_GUARDIAN" };
    const result = (await route.handler(params)) as { verdict: unknown };
    const expected = await resolveTrustVerdict(params);

    expect(result.verdict).toEqual(expected);
    expect((result.verdict as { trustClass: string }).trustClass).toBe(
      "guardian",
    );
  });

  test("active member → trusted_contact verdict matching the resolver", async () => {
    insertContact({ id: "c-member", displayName: "Trusted Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_MEMBER",
      status: "active",
    });

    const params = { channelType: CHANNEL, actorExternalId: "U_MEMBER" };
    const result = (await route.handler(params)) as { verdict: unknown };
    const expected = await resolveTrustVerdict(params);

    expect(result.verdict).toEqual(expected);
    expect((result.verdict as { trustClass: string }).trustClass).toBe(
      "trusted_contact",
    );
  });

  test("unknown actor → unknown verdict matching the resolver, not resolutionFailed", async () => {
    const params = { channelType: CHANNEL, actorExternalId: "U_STRANGER" };
    const result = (await route.handler(params)) as { verdict: unknown };
    const expected = await resolveTrustVerdict(params);

    expect(result.verdict).toEqual(expected);
    expect((result.verdict as { trustClass: string }).trustClass).toBe(
      "unknown",
    );
    // A real stranger is NOT flagged as a resolver failure.
    expect(
      (result.verdict as { resolutionFailed?: boolean }).resolutionFailed,
    ).toBeUndefined();
  });

  test("response envelope carries the channel's resolved admission policy", async () => {
    resolveAdmissionPolicyImpl = (channelType) =>
      channelType === CHANNEL ? "guardian_only" : null;

    const result = (await route.handler({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    })) as { admissionPolicy: unknown };

    expect(result.admissionPolicy).toBe("guardian_only");
  });

  test("no-enforcement channel → explicit null admission policy on the envelope", async () => {
    const result = (await route.handler({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    })) as { admissionPolicy: unknown };

    expect(result.admissionPolicy).toBeNull();
  });

  test("a thrown admission-policy read fails the whole call (fail closed, no fabricated null)", async () => {
    resolveAdmissionPolicyImpl = () => {
      throw new Error("admission cache not initialized");
    };

    expect(
      route.handler({ channelType: CHANNEL, actorExternalId: "U_STRANGER" }),
    ).rejects.toThrow("admission cache not initialized");
  });

  test("resolver throw → resolutionFailed sentinel verdict, policy still carried", async () => {
    // Drop the gateway DB connection so resolveTrustVerdict's getGatewayDb()
    // throws.
    resetGatewayDb();
    resolveAdmissionPolicyImpl = () => "trusted_contacts";

    const params = { channelType: CHANNEL, actorExternalId: "U_STRANGER" };
    const result = (await route.handler(params)) as {
      verdict: {
        trustClass: string;
        canonicalSenderId: string | null;
        resolutionFailed?: boolean;
      };
      admissionPolicy: unknown;
    };

    expect(result.verdict.resolutionFailed).toBe(true);
    expect(result.verdict.trustClass).toBe("unknown");
    expect(result.verdict.canonicalSenderId).toBe("U_STRANGER");
    expect(result.admissionPolicy).toBe("trusted_contacts");
  });

  test("resolver throw with whitespace-only actor id → sentinel canonicalSenderId is null", async () => {
    resetGatewayDb();

    const params = { channelType: CHANNEL, actorExternalId: "   " };
    const result = (await route.handler(params)) as {
      verdict: {
        trustClass: string;
        canonicalSenderId: string | null;
        resolutionFailed?: boolean;
      };
    };

    expect(result.verdict.resolutionFailed).toBe(true);
    expect(result.verdict.trustClass).toBe("unknown");
    // Matches a real resolve: whitespace-only id normalizes to absent.
    expect(result.verdict.canonicalSenderId).toBeNull();
  });
});
