/**
 * Unit tests for the `enforceAdmissionPolicy` pure function.
 *
 * Drives the floor-vs-rank logic in isolation — no I/O, no mocks needed.
 * Integration-level coverage lives in the gateway's
 * `handle-inbound-admission.test.ts` and in the full inbound-message
 * handler integration tests.
 */
import { describe, expect,test } from "bun:test";

import type { AdmissionPolicyInput } from "./admission-policy.js";
import { enforceAdmissionPolicy } from "./admission-policy.js";

function makeInput(overrides: Partial<AdmissionPolicyInput>): AdmissionPolicyInput {
  return {
    sourceChannel: "telegram",
    trustClass: "unknown",
    memberStatus: undefined,
    policy: "trusted_contacts",
    conversationOverride: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §8.1 exempt channels — always admit
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — exempt channels", () => {
  test("vellum short-circuits to admitted regardless of policy", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ sourceChannel: "vellum", trustClass: "unknown", policy: "no_one" }),
    );
    expect(result.admitted).toBe(true);
  });

  test("phone short-circuits to admitted (§8.4: voice ingress not wired)", () => {
    const result = enforceAdmissionPolicy(
      makeInput({ sourceChannel: "phone", trustClass: "unknown", policy: "no_one" }),
    );
    expect(result.admitted).toBe(true);
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
      makeInput({ trustClass: "unknown", memberStatus: undefined, policy: "strangers" }),
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
      makeInput({ trustClass: "unverified_contact", memberStatus: "pending", policy: "strangers" }),
    );
    expect(result.admitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §8.3 per-conversation override — override beats the channel-type floor
// ---------------------------------------------------------------------------

describe("enforceAdmissionPolicy — per-conversation override (§8.3)", () => {
  test("override `any_contact` admits unverified_contact even when the type floor (trusted_contacts) would deny", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unverified_contact", // rank 2
        policy: "trusted_contacts", // floor 3 → would deny
        conversationOverride: "any_contact", // floor 2 → admits
      }),
    );
    expect(result.admitted).toBe(true);
  });

  test("override stricter than the type floor denies (guardian_only over trusted_contacts)", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "trusted_contact", // rank 3 → clears the type floor
        policy: "trusted_contacts",
        conversationOverride: "guardian_only", // floor 4 → denies
      }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      // Deny reason + effective policy reflect the override, not the type floor.
      expect(result.reason).toBe("admission_policy_guardian_only");
      expect(result.effectivePolicy).toBe("guardian_only");
      // §8.2: stricter floors never advertise an upgrade path.
      expect(result.shouldChallenge).toBe(false);
    }
  });

  test("null override falls back to the type floor", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "trusted_contact",
        policy: "trusted_contacts",
        conversationOverride: null,
      }),
    );
    expect(result.admitted).toBe(true);
  });

  test("§8.2: a denial under an override of `strangers`/`any_contact` still challenges (reads the effective floor)", () => {
    const result = enforceAdmissionPolicy(
      makeInput({
        trustClass: "unknown", // rank 1
        policy: "trusted_contacts", // type floor would be silent on deny
        conversationOverride: "any_contact", // floor 2 → still denies rank 1, but is upgradeable
      }),
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.effectivePolicy).toBe("any_contact");
      expect(result.shouldChallenge).toBe(true);
    }
  });
});
