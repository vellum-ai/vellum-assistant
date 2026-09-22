/**
 * Tests for the `vellum` principal trust lookup.
 *
 * The gateway classifies; this module surfaces that classification, caches it
 * per principal, and fails closed. These pin the verdict passthrough for each
 * ACL state, the fail-closed paths (unreachable gateway, could-not-vouch) and
 * that neither is cached, single-flight coalescing, and the fresh bypass.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

type ReadResult =
  | { ok: true; verdict: TrustVerdict; admissionPolicy: null }
  | { ok: false };

let nextResult: ReadResult = { ok: false };
let readCalls: Array<{ channelType: string; actorExternalId?: string }> = [];

/** Set to hold the next gateway read open; consumed by that one read. */
let gate: Promise<void> | null = null;

mock.module("../../calls/inbound-trust-reader.js", () => ({
  readInboundTrust: async (input: {
    channelType: string;
    actorExternalId?: string;
  }) => {
    readCalls.push(input);
    const result = nextResult;
    const held = gate;
    gate = null;
    if (held) {
      await held;
    }
    return result;
  },
}));

function defer(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const {
  resolveVellumPrincipal,
  resolveVellumPrincipalFresh,
  __resetVellumPrincipalCacheForTest,
  __vellumPrincipalCacheSizeForTest,
  MAX_ENTRIES,
} = await import("../vellum-principal-lookup.js");

const PRINCIPAL = "11111111-2222-3333-4444-555555555555";

function verdict(overrides: Partial<TrustVerdict>): ReadResult {
  return {
    ok: true,
    verdict: {
      trustClass: "unknown",
      canonicalSenderId: PRINCIPAL,
      ...overrides,
    },
    admissionPolicy: null,
  };
}

beforeEach(() => {
  readCalls = [];
  nextResult = { ok: false };
  gate = null;
  __resetVellumPrincipalCacheForTest();
});

describe("resolveVellumPrincipal", () => {
  test("asks the gateway for the vellum channel and the principal as actor", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });

    await resolveVellumPrincipal(PRINCIPAL);

    expect(readCalls).toEqual([
      { channelType: "vellum", actorExternalId: PRINCIPAL },
    ]);
  });

  test("a principal with no contact row resolves unknown", async () => {
    nextResult = verdict({ trustClass: "unknown" });

    expect(await resolveVellumPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("the guardian's principal resolves guardian", async () => {
    nextResult = verdict({
      trustClass: "guardian",
      guardianPrincipalId: PRINCIPAL,
      guardianDisplayName: "Owner",
    });

    expect(await resolveVellumPrincipal(PRINCIPAL)).toEqual({
      trustClass: "guardian",
      displayName: "Owner",
    });
  });

  test("an active contact channel resolves trusted_contact with identity", async () => {
    nextResult = verdict({
      trustClass: "trusted_contact",
      contactId: "c-1",
      memberDisplayName: "Alice",
      status: "active",
    });

    expect(await resolveVellumPrincipal(PRINCIPAL)).toEqual({
      trustClass: "trusted_contact",
      contactId: "c-1",
      displayName: "Alice",
    });
  });

  test.each(["pending", "unverified"])(
    "a %s contact channel resolves unverified_contact",
    async (status) => {
      nextResult = verdict({
        trustClass: "unverified_contact",
        contactId: "c-1",
        status,
      });

      expect(await resolveVellumPrincipal(PRINCIPAL)).toMatchObject({
        trustClass: "unverified_contact",
        contactId: "c-1",
      });
    },
  );

  test.each(["revoked", "blocked"])(
    "a %s contact channel resolves unknown",
    async (status) => {
      nextResult = verdict({
        trustClass: "unknown",
        contactId: "c-1",
        status,
      });

      expect((await resolveVellumPrincipal(PRINCIPAL)).trustClass).toBe(
        "unknown",
      );
    },
  );

  test("a blank principal resolves unknown without reading the gateway", async () => {
    expect(await resolveVellumPrincipal("   ")).toEqual({
      trustClass: "unknown",
    });
    expect(readCalls).toEqual([]);
  });
});

describe("fail-closed reads", () => {
  test("an unreachable gateway resolves unknown", async () => {
    nextResult = { ok: false };

    expect(await resolveVellumPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("a could-not-vouch verdict resolves unknown", async () => {
    nextResult = verdict({ trustClass: "unknown", resolutionFailed: true });

    expect(await resolveVellumPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("an unreachable gateway is retried rather than cached", async () => {
    nextResult = { ok: false };
    await resolveVellumPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "trusted_contact" });
    const second = await resolveVellumPrincipal(PRINCIPAL);

    expect(second.trustClass).toBe("trusted_contact");
    expect(readCalls).toHaveLength(2);
  });

  test("a could-not-vouch verdict is retried rather than cached", async () => {
    nextResult = verdict({ trustClass: "unknown", resolutionFailed: true });
    await resolveVellumPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "guardian" });
    const second = await resolveVellumPrincipal(PRINCIPAL);

    expect(second.trustClass).toBe("guardian");
    expect(readCalls).toHaveLength(2);
  });
});

describe("caching", () => {
  test("a resolved principal is served from cache", async () => {
    nextResult = verdict({ trustClass: "trusted_contact", contactId: "c-1" });

    await resolveVellumPrincipal(PRINCIPAL);
    const second = await resolveVellumPrincipal(PRINCIPAL);

    expect(second).toEqual({
      trustClass: "trusted_contact",
      contactId: "c-1",
    });
    expect(readCalls).toHaveLength(1);
  });

  test("concurrent reads coalesce into one gateway call", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });

    const [a, b] = await Promise.all([
      resolveVellumPrincipal(PRINCIPAL),
      resolveVellumPrincipal(PRINCIPAL),
    ]);

    expect(a).toEqual(b);
    expect(readCalls).toHaveLength(1);
  });

  test("an older read does not overwrite a newer verdict", async () => {
    const stale = defer();

    // An ordinary read misses the cache and is still waiting on the gateway.
    nextResult = verdict({ trustClass: "trusted_contact" });
    gate = stale.promise;
    const pending = resolveVellumPrincipal(PRINCIPAL);

    // The contact is revoked; a fresh read starts later and answers first.
    nextResult = verdict({ trustClass: "unknown", status: "revoked" });
    expect((await resolveVellumPrincipalFresh(PRINCIPAL)).trustClass).toBe(
      "unknown",
    );

    stale.release();
    expect((await pending).trustClass).toBe("trusted_contact");

    // The cache must still hold the revocation.
    expect((await resolveVellumPrincipal(PRINCIPAL)).trustClass).toBe(
      "unknown",
    );
    expect(readCalls).toHaveLength(2);
  });

  test("distinct principals are cached separately", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    await resolveVellumPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "trusted_contact" });
    const other = await resolveVellumPrincipal("other-principal");

    expect(other.trustClass).toBe("trusted_contact");
    expect(readCalls).toHaveLength(2);
  });
});

describe("resolveVellumPrincipalFresh", () => {
  test("bypasses a cached entry and re-reads", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });
    await resolveVellumPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "unknown", status: "revoked" });
    const fresh = await resolveVellumPrincipalFresh(PRINCIPAL);

    expect(fresh.trustClass).toBe("unknown");
    expect(readCalls).toHaveLength(2);
  });

  test("repopulates the cache for later cached reads", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    await resolveVellumPrincipalFresh(PRINCIPAL);

    const cached = await resolveVellumPrincipal(PRINCIPAL);

    expect(cached.trustClass).toBe("guardian");
    expect(readCalls).toHaveLength(1);
  });
});

describe("cache bounds", () => {
  test("a burst past the limit is trimmed once the reads settle", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    const burst = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) =>
      resolveVellumPrincipal(`burst-principal-${i}`),
    );

    // Nothing was evictable on insert: every entry is mid-read.
    expect(__vellumPrincipalCacheSizeForTest()).toBeGreaterThan(MAX_ENTRIES);
    await Promise.all(burst);

    await resolveVellumPrincipal("after-the-burst");

    expect(__vellumPrincipalCacheSizeForTest()).toBeLessThanOrEqual(
      MAX_ENTRIES,
    );
  });
});
