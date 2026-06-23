/**
 * Unit tests for the narrow reset-drift trust-recovery helper
 * `reResolveTrustOnResetDrift`.
 *
 * The real helper runs against mocked leaf deps: the gateway guardian read
 * (`getGuardianDelivery`/`guardianForChannel`), the local-mirror heal
 * (`findGuardianForChannel`/`updateContactPrincipalAndChannel`, which the real
 * `healGuardianBindingDrift` drives), and the local trust resolver
 * (`resolveTrustContext`). Heal invocations are observed via the contact-store
 * write mock.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockGuardianList: Array<Record<string, unknown>> | null = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardianList,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// Local mirror the real heal reads/writes. `findGuardianForChannel` returns the
// stored guardian; `updateContactPrincipalAndChannel` records heal writes.
let mockLocalGuardian: {
  contact: { id: string; principalId: string };
  channel: { id: string };
} | null = null;
const healWrites: Array<{ principalId: string }> = [];

mock.module("../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => mockLocalGuardian,
  updateContactPrincipalAndChannel: (
    _contactId: string,
    _channelId: string,
    principalId: string,
  ) => {
    healWrites.push({ principalId });
    return true;
  },
}));

// The local trust resolver returns guardian for the actor; the gate threads
// sourceChannel via the real withSourceChannel wrapper.
mock.module("../../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: (input: { actorExternalId?: string }) => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
    resolvedActor: input.actorExternalId,
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: Record<string, unknown>) => ({
    ...ctx,
    sourceChannel,
  }),
}));

const { reResolveTrustOnResetDrift } = await import(
  "../guardian-vellum-migration.js"
);

function gatewayGuardian(principalId: string): Record<string, unknown> {
  return {
    channelType: "vellum",
    contactId: "guardian-contact",
    principalId,
    address: principalId,
    status: "active",
  };
}

function localGuardian(principalId: string) {
  return {
    contact: { id: "contact-1", principalId },
    channel: { id: "channel-1" },
  };
}

describe("reResolveTrustOnResetDrift", () => {
  beforeEach(() => {
    mockGuardianList = [];
    mockLocalGuardian = null;
    healWrites.length = 0;
  });

  test("reset drift: heals and returns the re-resolved guardian ctx", async () => {
    // Stale local mirror still holds the pre-reset principal; the incoming JWT
    // carries the old one. Heal repairs the mirror toward the incoming actor.
    mockGuardianList = [gatewayGuardian("vellum-principal-new")];
    mockLocalGuardian = localGuardian("vellum-principal-stale");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "vellum",
    );

    expect(ctx?.trustClass).toBe("guardian");
    expect(healWrites).toEqual([{ principalId: "vellum-principal-old" }]);
  });

  test("repeat drift where heal no-ops still returns the guardian ctx", async () => {
    // Local mirror already matches the incoming principal, so heal's write is
    // skipped, but the gate still passes and the re-resolve yields guardian.
    mockGuardianList = [gatewayGuardian("vellum-principal-new")];
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "vellum",
    );

    expect(ctx?.trustClass).toBe("guardian");
    expect(healWrites).toEqual([]);
  });

  test("gateway unreachable (null): returns null, heal not called", async () => {
    mockGuardianList = null;
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "vellum",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("empty/revoked gateway (no active guardian): returns null, heal not called", async () => {
    mockGuardianList = [];
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "vellum",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("gateway guardian is a real (non vellum-principal-*) id: returns null", async () => {
    mockGuardianList = [gatewayGuardian("user@example.com")];
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "vellum",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("incoming principal is not vellum-principal-*: returns null", async () => {
    mockGuardianList = [gatewayGuardian("vellum-principal-new")];
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift("user@example.com", "vellum");

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("threads sourceChannel into the returned ctx", async () => {
    mockGuardianList = [gatewayGuardian("vellum-principal-new")];
    mockLocalGuardian = localGuardian("vellum-principal-old");

    const ctx = await reResolveTrustOnResetDrift(
      "vellum-principal-old",
      "telegram",
    );

    expect(ctx?.sourceChannel).toBe("telegram");
  });
});
