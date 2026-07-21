/**
 * Unit tests for the `enforceAdmissionPolicy` pure function.
 *
 * Drives the floor-vs-rank logic in isolation — no I/O, no mocks needed.
 * Integration-level coverage lives in the gateway's
 * `handle-inbound-admission.test.ts` and in the full inbound-message
 * handler integration tests.
 */
import { describe, expect, test } from "bun:test";

import type { AdmissionPolicyInput } from "./admission-policy.js";
import { enforceAdmissionPolicy } from "./admission-policy.js";

function makeInput(
  overrides: Partial<AdmissionPolicyInput>,
): AdmissionPolicyInput {
  return {
    sourceChannel: "telegram",
    trustClass: "unknown",
    memberStatus: undefined,
    policy: "trusted_contacts",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §8.1 exempt channels — always admit
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — exempt channels", () => {
  test("a2a short-circuits to admitted regardless of policy", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        sourceChannel: "a2a",
        trustClass: "unknown",
        policy: "no_one",
      }),
    );
    expect(result.admitted).toBe(true);
  });

  test("phone is enforced (not exempt): the floor applies", () => {
    // Voice ingress is wired, so `phone` is no longer exempt — an `unknown`
    // caller is denied under `no_one`.
    const result = enforceAdmissionPolicy(
      makeInput({
        sourceChannel: "phone",
        trustClass: "unknown",
        policy: "no_one",
      }),
    );
    expect(result.admitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8 revoked members — denied regardless of policy
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — revoked member denial", () => {
  test("revoked member is denied even under `strangers` (most permissive policy)", () => {
    // Before the §8 fix, a revoked member with trustClass `unknown` (rank 1)
    // would pass the `strangers` floor (floor 1, rank ≥ floor). The defense-
    // in-depth short-circuit in this function now denies them regardless.
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unknown",
        memberStatus: "revoked",
        policy: "strangers",
      }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toBe("member_revoked");
      expect(result.shouldChallenge).toBe(false);
    }
  });

  test("revoked member is denied under `any_contact`", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unknown",
        memberStatus: "revoked",
        policy: "any_contact",
      }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.reason).toBe("member_revoked");
  });

  test("revoked member is denied under `trusted_contacts`", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unknown",
        memberStatus: "revoked",
        policy: "trusted_contacts",
      }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.reason).toBe("member_revoked");
  });
});

// ---------------------------------------------------------------------------
// §8 blocked members — denied regardless of policy (existing behavior)
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — blocked member denial", () => {
  test("blocked member is denied under `strangers`", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ memberStatus: "blocked", policy: "strangers" }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.reason).toBe("member_blocked");
  });
});

// ---------------------------------------------------------------------------
// Rank-vs-floor: non-revoked, non-blocked members
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — rank vs floor", () => {
  test("guardian admitted under any policy including guardian_only", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ trustClass: "guardian", policy: "guardian_only" }),
    );
    expect(result.admitted).toBe(true);
  });

  test("trusted_contact admitted under trusted_contacts", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ trustClass: "trusted_contact", policy: "trusted_contacts" }),
    );
    expect(result.admitted).toBe(true);
  });

  test("unverified_contact admitted under any_contact floor", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ trustClass: "unverified_contact", policy: "any_contact" }),
    );
    expect(result.admitted).toBe(true);
  });

  test("unknown (non-member) admitted under strangers floor", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unknown",
        memberStatus: undefined,
        policy: "strangers",
      }),
    );
    expect(result.admitted).toBe(true);
  });

  test("unknown denied under trusted_contacts floor", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ trustClass: "unknown", policy: "trusted_contacts" }),
    );
    expect(result.admitted).toBe(false);
  });

  test("pending member (unverified_contact) admitted under strangers floor", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unverified_contact",
        memberStatus: "pending",
        policy: "strangers",
      }),
    );
    expect(result.admitted).toBe(true);
  });
});
