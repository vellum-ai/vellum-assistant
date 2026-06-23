import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

let mockGuardians: GuardianDelivery[] | null = null;
let authDisabled = false;

mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardians,
  // Real active-status selector so the auth gate enforces status==="active".
  guardianForChannel: (list: GuardianDelivery[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
}));

import { requireBoundGuardian } from "../require-bound-guardian.js";
import type { AuthContext } from "../types.js";

function ctx(actorPrincipalId?: string): AuthContext {
  return {
    subject: "sub",
    principalType: "actor",
    assistantId: "self",
    actorPrincipalId,
    scopeProfile: "actor_client_v1",
    scopes: new Set(),
    policyEpoch: 0,
  };
}

function guardian(principalId: string): GuardianDelivery {
  return {
    channelType: "vellum",
    contactId: "guardian-contact",
    principalId,
    address: principalId,
    status: "active",
  };
}

describe("requireBoundGuardian", () => {
  beforeEach(() => {
    mockGuardians = null;
    authDisabled = false;
  });

  test("admits the bound guardian", async () => {
    mockGuardians = [guardian("vellum-principal-abc")];
    const result = await requireBoundGuardian(ctx("vellum-principal-abc"));
    expect(result).toBeNull();
  });

  test("denies a non-guardian actor", async () => {
    mockGuardians = [guardian("vellum-principal-abc")];
    const result = await requireBoundGuardian(ctx("vellum-principal-other"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("denies when actor principal is missing", async () => {
    mockGuardians = [guardian("vellum-principal-abc")];
    const result = await requireBoundGuardian(ctx(undefined));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("fails closed on a null list (gateway unreachable)", async () => {
    mockGuardians = null;
    const result = await requireBoundGuardian(ctx("vellum-principal-abc"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("denies when no vellum guardian is bound", async () => {
    mockGuardians = [];
    const result = await requireBoundGuardian(ctx("vellum-principal-abc"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("denies a non-active (revoked) vellum row matching the actor", async () => {
    mockGuardians = [
      { ...guardian("vellum-principal-abc"), status: "revoked" },
    ];
    const result = await requireBoundGuardian(ctx("vellum-principal-abc"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("dev bypass admits when auth is disabled", async () => {
    authDisabled = true;
    mockGuardians = null;
    const result = await requireBoundGuardian(ctx(undefined));
    expect(result).toBeNull();
  });
});
