/**
 * Unit tests for the in-memory member-verdict cache: set→get round-trip, TTL
 * expiry, memberless verdicts not cached, and max-size eviction.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import {
  __resetMemberVerdictCacheForTest,
  getCachedMemberAcl,
  setMemberVerdict,
} from "../member-verdict-cache.js";

const PHONE = "+15559871234";

function memberVerdict(
  overrides: Partial<TrustVerdict> = {},
): TrustVerdict {
  return {
    trustClass: "trusted_contact",
    canonicalSenderId: PHONE,
    contactId: "contact-1",
    channelId: "ch-1",
    status: "active",
    policy: "allow",
    ...overrides,
  };
}

const realNow = Date.now;

describe("member-verdict-cache", () => {
  beforeEach(() => {
    __resetMemberVerdictCacheForTest();
  });

  afterEach(() => {
    Date.now = realNow;
  });

  test("set then get returns the derived ACL view", () => {
    setMemberVerdict("phone", PHONE, memberVerdict());
    expect(getCachedMemberAcl("phone", PHONE)).toEqual({
      status: "active",
      policy: "allow",
    });
  });

  test("read canonicalizes the actor id like the write", () => {
    // Phone numbers normalize to E.164; a raw-format write is readable by the
    // same raw-format read.
    setMemberVerdict("phone", "(555) 987-1234", memberVerdict());
    expect(getCachedMemberAcl("phone", "(555) 987-1234")).toBeDefined();
  });

  test("empty actor id is a no-op on set and get", () => {
    setMemberVerdict("phone", undefined, memberVerdict());
    expect(getCachedMemberAcl("phone", undefined)).toBeUndefined();
    expect(getCachedMemberAcl("phone", "   ")).toBeUndefined();
  });

  test("memberless verdict is not cached", () => {
    setMemberVerdict(
      "phone",
      PHONE,
      memberVerdict({ contactId: undefined, channelId: undefined }),
    );
    expect(getCachedMemberAcl("phone", PHONE)).toBeUndefined();
  });

  test("memberless verdict clears a stale active entry for the actor", () => {
    setMemberVerdict("phone", PHONE, memberVerdict());
    expect(getCachedMemberAcl("phone", PHONE)).toBeDefined();
    // A later memberless verdict (deleted contact / stranger) must invalidate
    // the stale active ACL, not leave it readable for the rest of the TTL.
    setMemberVerdict(
      "phone",
      PHONE,
      memberVerdict({ contactId: undefined, channelId: undefined }),
    );
    expect(getCachedMemberAcl("phone", PHONE)).toBeUndefined();
  });

  test("expired entry returns undefined", () => {
    const t0 = realNow();
    Date.now = () => t0;
    setMemberVerdict("phone", PHONE, memberVerdict());
    Date.now = () => t0 + 300_001;
    expect(getCachedMemberAcl("phone", PHONE)).toBeUndefined();
  });

  test("evicts the oldest-expiring entry past the bound", () => {
    const t0 = realNow();
    // telegram IDs pass through unchanged, so each key is distinct. Fill past
    // capacity with monotonically increasing expiry stamps.
    for (let i = 0; i < 2001; i++) {
      Date.now = () => t0 + i;
      setMemberVerdict("telegram", `tg-${i}`, memberVerdict());
    }
    Date.now = () => t0 + 2001;
    // The oldest-expiring entry is evicted on the over-capacity insert; the
    // latest survives.
    expect(getCachedMemberAcl("telegram", "tg-0")).toBeUndefined();
    expect(getCachedMemberAcl("telegram", "tg-2000")).toBeDefined();
  });
});
