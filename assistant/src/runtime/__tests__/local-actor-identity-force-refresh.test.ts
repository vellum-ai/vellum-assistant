/**
 * Tests for the cache-bypass option on the local guardian principal lookup.
 *
 * The guardian-delivery reader caches a successful read that finds no binding,
 * and gateway-side binding writes do not invalidate the daemon's cache. A
 * caller polling for a binding it expects to appear (the SSE actor-principal
 * heal) therefore has to force the read, or every attempt re-reads the same
 * empty answer until the TTL lapses.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

let cachedResult: GuardianDelivery[] | null = null;
let freshResult: GuardianDelivery[] | null = null;
let cachedCalls = 0;
let freshCalls = 0;

mock.module("../../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: () => {
    cachedCalls++;
    return Promise.resolve(cachedResult);
  },
  getGuardianDeliveryFresh: () => {
    freshCalls++;
    return Promise.resolve(freshResult);
  },
  peekCachedGuardianDelivery: () => undefined,
  guardianForChannel: (list: GuardianDelivery[]) => list[0],
}));

import {
  findLocalGuardianPrincipalId,
  resolveActorPrincipalIdForLocalGuardian,
} from "../local-actor-identity.js";

afterAll(() => {
  mock.restore();
});

/** Minimal guardian row: only `principalId` is read here. */
function guardian(principalId: string): GuardianDelivery {
  return { principalId } as unknown as GuardianDelivery;
}

describe("local guardian principal lookup — cache bypass", () => {
  beforeEach(() => {
    cachedCalls = 0;
    freshCalls = 0;
    cachedResult = [];
    freshResult = [];
  });

  test("reads the cache by default", async () => {
    cachedResult = [guardian("guardian-cached")];
    freshResult = [guardian("guardian-fresh")];

    expect(await findLocalGuardianPrincipalId()).toBe("guardian-cached");
    expect(cachedCalls).toBe(1);
    expect(freshCalls).toBe(0);
  });

  test("forceRefresh bypasses the cache and sees a binding the cache would miss", async () => {
    // Cached read holds the empty result from before the binding existed.
    cachedResult = [];
    freshResult = [guardian("guardian-fresh")];

    expect(await findLocalGuardianPrincipalId()).toBeUndefined();
    expect(await findLocalGuardianPrincipalId({ forceRefresh: true })).toBe(
      "guardian-fresh",
    );
    expect(freshCalls).toBe(1);
  });

  test("resolveActorPrincipalIdForLocalGuardian threads forceRefresh through", async () => {
    cachedResult = [];
    freshResult = [guardian("guardian-fresh")];

    expect(
      await resolveActorPrincipalIdForLocalGuardian("dev-bypass"),
    ).toBeUndefined();
    expect(
      await resolveActorPrincipalIdForLocalGuardian("dev-bypass", {
        forceRefresh: true,
      }),
    ).toBe("guardian-fresh");
    expect(freshCalls).toBe(1);
  });

  test("a non-dev-bypass principal is passed through without any lookup", async () => {
    expect(
      await resolveActorPrincipalIdForLocalGuardian("actor-123", {
        forceRefresh: true,
      }),
    ).toBe("actor-123");
    expect(cachedCalls).toBe(0);
    expect(freshCalls).toBe(0);
  });
});
