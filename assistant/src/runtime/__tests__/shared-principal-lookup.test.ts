/**
 * Tests for the shared-conversation principal trust lookup.
 *
 * The gateway classifies; this module surfaces that classification, caches it
 * per principal, and fails closed. These pin the verdict passthrough for each
 * ACL state, the fail-closed paths (unreachable gateway, could-not-vouch) and
 * that neither is cached, single-flight coalescing, and the fresh bypass
 * superseding the cached entry.
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
  resolveSharedPrincipal,
  resolveSharedPrincipalFresh,
  __resetSharedPrincipalCacheForTest,
  __sharedPrincipalCacheSizeForTest,
  MAX_ENTRIES,
} = await import("../shared-principal-lookup.js");

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
  __resetSharedPrincipalCacheForTest();
});

describe("resolveSharedPrincipal", () => {
  test("asks the gateway for the vellum-shared channel and the principal as actor", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });

    await resolveSharedPrincipal(PRINCIPAL);

    expect(readCalls).toEqual([
      { channelType: "vellum-shared", actorExternalId: PRINCIPAL },
    ]);
  });

  test("a principal with no contact row resolves unknown", async () => {
    nextResult = verdict({ trustClass: "unknown" });

    expect(await resolveSharedPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("the guardian's principal resolves guardian", async () => {
    nextResult = verdict({
      trustClass: "guardian",
      guardianPrincipalId: PRINCIPAL,
      guardianDisplayName: "Owner",
    });

    expect(await resolveSharedPrincipal(PRINCIPAL)).toEqual({
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

    expect(await resolveSharedPrincipal(PRINCIPAL)).toEqual({
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

      expect(await resolveSharedPrincipal(PRINCIPAL)).toMatchObject({
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

      expect((await resolveSharedPrincipal(PRINCIPAL)).trustClass).toBe(
        "unknown",
      );
    },
  );

  test("a blank principal resolves unknown without reading the gateway", async () => {
    expect(await resolveSharedPrincipal("   ")).toEqual({
      trustClass: "unknown",
    });
    expect(readCalls).toEqual([]);
  });
});

describe("fail-closed reads", () => {
  test("an unreachable gateway resolves unknown", async () => {
    nextResult = { ok: false };

    expect(await resolveSharedPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("a could-not-vouch verdict resolves unknown", async () => {
    nextResult = verdict({ trustClass: "unknown", resolutionFailed: true });

    expect(await resolveSharedPrincipal(PRINCIPAL)).toEqual({
      trustClass: "unknown",
    });
  });

  test("an unreachable gateway is retried rather than cached", async () => {
    nextResult = { ok: false };
    await resolveSharedPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "trusted_contact" });
    const second = await resolveSharedPrincipal(PRINCIPAL);

    expect(second.trustClass).toBe("trusted_contact");
    expect(readCalls).toHaveLength(2);
  });

  test("a could-not-vouch verdict is retried rather than cached", async () => {
    nextResult = verdict({ trustClass: "unknown", resolutionFailed: true });
    await resolveSharedPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "guardian" });
    const second = await resolveSharedPrincipal(PRINCIPAL);

    expect(second.trustClass).toBe("guardian");
    expect(readCalls).toHaveLength(2);
  });
});

describe("caching", () => {
  test("a resolved principal is served from cache", async () => {
    nextResult = verdict({ trustClass: "trusted_contact", contactId: "c-1" });

    await resolveSharedPrincipal(PRINCIPAL);
    const second = await resolveSharedPrincipal(PRINCIPAL);

    expect(second).toEqual({
      trustClass: "trusted_contact",
      contactId: "c-1",
    });
    expect(readCalls).toHaveLength(1);
  });

  test("concurrent reads coalesce into one gateway call", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });

    const [a, b] = await Promise.all([
      resolveSharedPrincipal(PRINCIPAL),
      resolveSharedPrincipal(PRINCIPAL),
    ]);

    expect(a).toEqual(b);
    expect(readCalls).toHaveLength(1);
  });

  test("an older read does not overwrite a newer verdict", async () => {
    const stale = defer();

    // An ordinary read misses the cache and is still waiting on the gateway.
    nextResult = verdict({ trustClass: "trusted_contact" });
    gate = stale.promise;
    const pending = resolveSharedPrincipal(PRINCIPAL);

    // The contact is revoked; a fresh read starts later and answers first.
    nextResult = verdict({ trustClass: "unknown", status: "revoked" });
    expect((await resolveSharedPrincipalFresh(PRINCIPAL)).trustClass).toBe(
      "unknown",
    );

    stale.release();
    expect((await pending).trustClass).toBe("trusted_contact");

    // The cache must still hold the revocation.
    expect((await resolveSharedPrincipal(PRINCIPAL)).trustClass).toBe(
      "unknown",
    );
    expect(readCalls).toHaveLength(2);
  });

  test("distinct principals are cached separately", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    await resolveSharedPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "trusted_contact" });
    const other = await resolveSharedPrincipal("other-principal");

    expect(other.trustClass).toBe("trusted_contact");
    expect(readCalls).toHaveLength(2);
  });
});

describe("resolveSharedPrincipalFresh", () => {
  test("bypasses a cached entry and re-reads", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });
    await resolveSharedPrincipal(PRINCIPAL);

    nextResult = verdict({ trustClass: "unknown", status: "revoked" });
    const fresh = await resolveSharedPrincipalFresh(PRINCIPAL);

    expect(fresh.trustClass).toBe("unknown");
    expect(readCalls).toHaveLength(2);
  });

  test("cached reads made while it is pending share its result", async () => {
    nextResult = verdict({ trustClass: "trusted_contact" });
    await resolveSharedPrincipal(PRINCIPAL);

    const refresh = defer();
    nextResult = verdict({ trustClass: "unknown", status: "revoked" });
    gate = refresh.promise;
    const fresh = resolveSharedPrincipalFresh(PRINCIPAL);
    const cached = resolveSharedPrincipal(PRINCIPAL);

    refresh.release();
    expect((await fresh).trustClass).toBe("unknown");
    expect((await cached).trustClass).toBe("unknown");
    expect(readCalls).toHaveLength(2);
  });

  test.each([
    ["an unreachable gateway", { ok: false } as ReadResult],
    [
      "a could-not-vouch verdict",
      verdict({ trustClass: "unknown", resolutionFailed: true }),
    ],
  ])(
    "a refresh that meets %s does not leave the cached verdict in place",
    async (_label, failure) => {
      nextResult = verdict({ trustClass: "trusted_contact" });
      await resolveSharedPrincipal(PRINCIPAL);

      nextResult = failure;
      expect((await resolveSharedPrincipalFresh(PRINCIPAL)).trustClass).toBe(
        "unknown",
      );

      expect((await resolveSharedPrincipal(PRINCIPAL)).trustClass).toBe(
        "unknown",
      );
      expect(readCalls).toHaveLength(3);
    },
  );

  test("repopulates the cache for later cached reads", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    await resolveSharedPrincipalFresh(PRINCIPAL);

    const cached = await resolveSharedPrincipal(PRINCIPAL);

    expect(cached.trustClass).toBe("guardian");
    expect(readCalls).toHaveLength(1);
  });
});

describe("cache bounds", () => {
  test("a burst past the limit is trimmed once the reads settle", async () => {
    nextResult = verdict({ trustClass: "guardian" });
    const burst = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) =>
      resolveSharedPrincipal(`burst-principal-${i}`),
    );

    // Nothing was evictable on insert: every entry is mid-read.
    expect(__sharedPrincipalCacheSizeForTest()).toBeGreaterThan(MAX_ENTRIES);

    await Promise.all(burst);

    // No later lookup is needed to bring it back down.
    expect(__sharedPrincipalCacheSizeForTest()).toBeLessThanOrEqual(
      MAX_ENTRIES,
    );
  });
});
