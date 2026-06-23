/**
 * Regression: the SSE subscribe path must resolve the actor principal from the
 * SAME guardian source as the send/result routes.
 *
 * The send/result routes resolve the actor principal via the async,
 * gateway-first `findLocalGuardianPrincipalId`. The SSE eager-subscribe path
 * cannot await and uses the sync `findLocalGuardianPrincipalIdFromStore`. When
 * the gateway binding is canonical but the local contact row is stale/missing
 * (after a guardian reset or gateway-owned binding update), the sync path must
 * still land on the gateway principal — otherwise the event hub registers the
 * SSE client under a DIFFERENT principal than the turn/result paths use, and
 * targeted result submissions 403.
 *
 * These tests pin the invariant by priming the gateway-delivery cache with a
 * principal that differs from the stale local store and asserting both
 * resolvers agree; and that a cold cache falls back to the local store.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

// ── Controllable IPC mock (drives the gateway-delivery cache) ────────────────

let ipcGuardians: GuardianDelivery[] = [];

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async () => ({ guardians: ipcGuardians }),
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

// ── Local store mock (the stale fallback source) ─────────────────────────────

let storePrincipalId: string | undefined;

mock.module("../contacts/contact-store.js", () => ({
  findGuardianForChannel: (channelType: string) =>
    storePrincipalId && channelType === "vellum"
      ? { contact: { principalId: storePrincipalId }, channel: {} }
      : null,
}));

import {
  __resetGuardianDeliveryCacheForTest,
  getGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import {
  findLocalGuardianPrincipalId,
  findLocalGuardianPrincipalIdFromStore,
} from "../runtime/local-actor-identity.js";

const gatewayVellumGuardian: GuardianDelivery = {
  channelType: "vellum",
  contactId: "contact-gw",
  principalId: "guardian-from-gateway",
  address: "vellum:self",
  status: "active",
};

describe("SSE actor principal resolves from the same guardian source as send/result routes", () => {
  beforeEach(() => {
    __resetGuardianDeliveryCacheForTest();
    ipcGuardians = [];
    storePrincipalId = undefined;
  });

  test("warm gateway cache: sync (SSE) and async (send/result) resolve the SAME principal despite a stale local store", async () => {
    // Gateway binding is canonical; local store row is stale (different id).
    ipcGuardians = [gatewayVellumGuardian];
    storePrincipalId = "guardian-stale-local";

    // Prime the cache the way the async hot paths do.
    const asyncPrincipalId = await findLocalGuardianPrincipalId();
    expect(asyncPrincipalId).toBe("guardian-from-gateway");

    // SSE's sync resolver reads the same cached gateway snapshot, NOT the
    // stale store — so the principals match and host-proxy targeting works.
    expect(findLocalGuardianPrincipalIdFromStore()).toBe(asyncPrincipalId);
  });

  test("cold cache: sync resolver falls back to the local store as before", () => {
    // Nothing primed the cache; only the local store has a binding.
    storePrincipalId = "guardian-stale-local";

    expect(findLocalGuardianPrincipalIdFromStore()).toBe("guardian-stale-local");
  });

  test("cold cache with no store binding: sync resolver returns undefined", () => {
    expect(findLocalGuardianPrincipalIdFromStore()).toBeUndefined();
  });

  test("warm gateway cache primes via the vellum-filtered read the async path uses", async () => {
    ipcGuardians = [gatewayVellumGuardian];

    // The async path filters by channelType vellum; the sync peek must read
    // the same cache key, not the unfiltered "ALL" entry.
    await getGuardianDelivery({ channelTypes: ["vellum"] });

    expect(findLocalGuardianPrincipalIdFromStore()).toBe("guardian-from-gateway");
  });
});
