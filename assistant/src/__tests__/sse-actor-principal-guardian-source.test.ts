/**
 * Regression: the SSE subscribe path must resolve the actor principal from the
 * SAME guardian source as the send/result routes.
 *
 * The send/result routes resolve the actor principal via the async
 * `findLocalGuardianPrincipalId`. The SSE eager-subscribe path cannot await and
 * uses the sync `findLocalGuardianPrincipalIdFromStore`. Both read the
 * gateway-owned guardian binding — async via the cached IPC read, sync via the
 * IO-free cache snapshot — so the event hub registers the SSE client under the
 * SAME principal the turn/result paths use; otherwise targeted result
 * submissions 403.
 *
 * These tests pin the invariant by priming the gateway-delivery cache and
 * asserting both resolvers agree; and that a cold cache yields no principal.
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
  });

  test("warm gateway cache: sync (SSE) and async (send/result) resolve the SAME principal", async () => {
    ipcGuardians = [gatewayVellumGuardian];

    // Prime the cache the way the async hot paths do.
    const asyncPrincipalId = await findLocalGuardianPrincipalId();
    expect(asyncPrincipalId).toBe("guardian-from-gateway");

    // SSE's sync resolver reads the same cached gateway snapshot — so the
    // principals match and host-proxy targeting works.
    expect(findLocalGuardianPrincipalIdFromStore()).toBe(asyncPrincipalId);
  });

  test("cold cache: sync resolver returns undefined", () => {
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
