import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { CURRENT_POLICY_EPOCH } from "../policy.js";
import {
  hashToken,
  initAuthSigningKey,
  mintToken,
  verifyToken,
} from "../token-service.js";

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
});

describe("mintToken / verifyToken round-trip", () => {
  test("mint + verify succeeds for valid token targeting vellum-daemon", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:principal-abc",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });

    expect(token).toBeTruthy();
    expect(token.split(".").length).toBe(3);

    const result = verifyToken(token, "vellum-daemon");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe("vellum-auth");
      expect(result.claims.aud).toBe("vellum-daemon");
      expect(result.claims.sub).toBe("actor:self:principal-abc");
      expect(result.claims.scope_profile).toBe("actor_client_v1");
      expect(result.claims.policy_epoch).toBe(CURRENT_POLICY_EPOCH);
      expect(result.claims.iat).toBeDefined();
      expect(result.claims.jti).toBeDefined();
    }
  });

  test("mint + verify succeeds for gateway audience", () => {
    const token = mintToken({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_ingress_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 60,
    });

    const result = verifyToken(token, "vellum-gateway");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.aud).toBe("vellum-gateway");
      expect(result.claims.sub).toBe("svc:gateway:self");
    }
  });

  test("each mint produces a unique jti", () => {
    const params = {
      aud: "vellum-daemon" as const,
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1" as const,
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    };

    const t1 = mintToken(params);
    const t2 = mintToken(params);

    const r1 = verifyToken(t1, "vellum-daemon");
    const r2 = verifyToken(t2, "vellum-daemon");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.claims.jti).not.toBe(r2.claims.jti);
    }
  });
});

describe("verifyToken failure cases", () => {
  test("rejects expired token", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: -10, // already expired
    });

    const result = verifyToken(token, "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("token_expired");
    }
  });

  test("rejects wrong audience", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });

    const result = verifyToken(token, "vellum-gateway");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("audience_mismatch");
    }
  });

  test("rejects malformed token (no dots)", () => {
    const result = verifyToken("not-a-jwt", "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("malformed_token");
    }
  });

  test("rejects malformed token (only 2 parts)", () => {
    const result = verifyToken("part1.part2", "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("malformed_token");
    }
  });

  test("rejects tampered payload", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });

    const parts = token.split(".");
    // Tamper with the payload
    parts[1] = parts[1] + "X";
    const tampered = parts.join(".");

    const result = verifyToken(tampered, "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  test("rejects tampered signature", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });

    const parts = token.split(".");
    parts[2] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const tampered = parts.join(".");

    const result = verifyToken(tampered, "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  test("rejects token with stale policy epoch", () => {
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: 0, // stale
      ttlSeconds: 300,
    });

    const result = verifyToken(token, "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale_policy_epoch");
    }
  });

  test("rejects token signed with a different key", () => {
    // Mint with current key
    const token = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });

    // Switch to a different key
    initAuthSigningKey(Buffer.from("different-key-32-bytes-longXXXX"));

    const result = verifyToken(token, "vellum-daemon");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }

    // Restore original key for remaining tests
    initAuthSigningKey(TEST_KEY);
  });
});

describe("hashToken", () => {
  test("produces consistent SHA-256 hex digest", () => {
    const hash1 = hashToken("test-token");
    const hash2 = hashToken("test-token");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  test("different tokens produce different hashes", () => {
    const t1 = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p1",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
    const t2 = mintToken({
      aud: "vellum-daemon",
      sub: "actor:self:p2",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
    expect(hashToken(t1)).not.toBe(hashToken(t2));
  });
});
