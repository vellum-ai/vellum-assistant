import { afterEach, describe, expect, test } from "bun:test";

import { resolveCapabilities } from "./capabilities.js";
import {
  derivePersonaTrustFlags,
  type PersonaTrustFlags,
  trustClassSchema,
} from "./trust-class.js";

describe("derivePersonaTrustFlags", () => {
  test("guardian derives the guardian flag only", () => {
    expect(derivePersonaTrustFlags("guardian")).toEqual({
      trustClass: "guardian",
      isGuardian: true,
      isTrustedContact: false,
      isStranger: false,
    });
  });

  test("trusted_contact and unverified_contact derive identical contact flags", () => {
    // The admission-only equivalence documented on trustClassSchema: the two
    // classes must never drift apart at the persona layer.
    const expected: PersonaTrustFlags = {
      trustClass: "trusted_contact",
      isGuardian: false,
      isTrustedContact: true,
      isStranger: false,
    };
    expect(derivePersonaTrustFlags("trusted_contact")).toEqual(expected);
    expect(derivePersonaTrustFlags("unverified_contact")).toEqual({
      ...expected,
      trustClass: "unverified_contact",
    });
  });

  test("unknown derives the stranger flag only", () => {
    expect(derivePersonaTrustFlags("unknown")).toEqual({
      trustClass: "unknown",
      isGuardian: false,
      isTrustedContact: false,
      isStranger: true,
    });
  });

  test("an unresolved actor (undefined) fails closed to stranger", () => {
    // Disclosure gating must default to the guardrail, never to a guardian
    // exemption, when no actor was resolved for the turn.
    expect(derivePersonaTrustFlags(undefined)).toEqual({
      trustClass: "unknown",
      isGuardian: false,
      isTrustedContact: false,
      isStranger: true,
    });
  });

  test("exactly one flag is true for every trust class", () => {
    // Iterates the Zod enum so a newly added class is covered automatically
    // (the helper itself won't compile until the new class gets a case).
    for (const trustClass of trustClassSchema.options) {
      const flags = derivePersonaTrustFlags(trustClass);
      const trueCount = [
        flags.isGuardian,
        flags.isTrustedContact,
        flags.isStranger,
      ].filter(Boolean).length;
      expect(trueCount).toBe(1);
      expect(flags.trustClass).toBe(trustClass);
    }
  });

  describe("independence from the deployment auth posture", () => {
    const prior = process.env.DISABLE_HTTP_AUTH;

    afterEach(() => {
      if (prior === undefined) {
        delete process.env.DISABLE_HTTP_AUTH;
      } else {
        process.env.DISABLE_HTTP_AUTH = prior;
      }
    });

    test("an unresolved actor stays stranger under DISABLE_HTTP_AUTH", () => {
      // Deliberate divergence from resolveTrustClass, which fail-safes an
      // unresolved turn to guardian under the local auth-bypass for
      // control-plane gates. The disclosure guardrail must instead fail closed
      // — this test exists so the helper is never "unified" onto that bypass.
      process.env.DISABLE_HTTP_AUTH = "true";
      expect(derivePersonaTrustFlags(undefined).isStranger).toBe(true);
      expect(derivePersonaTrustFlags("trusted_contact").isGuardian).toBe(false);
    });
  });

  test("persona partition matches the capability matrix's prompt guidance", () => {
    // The persona flags and resolveCapabilities().promptTrustGuidance encode
    // the same three-way partition (guardian / known contact / stranger) in two
    // homes. Pin them together so persona framing and turn-context guidance
    // can't drift apart when either table changes.
    const guidanceByFlag: Record<string, string> = {
      isGuardian: "none",
      isTrustedContact: "social-engineering-defense",
      isStranger: "stranger-warning",
    };
    for (const trustClass of trustClassSchema.options) {
      const flags = derivePersonaTrustFlags(trustClass);
      const guidance = resolveCapabilities(trustClass).promptTrustGuidance;
      for (const [flag, expected] of Object.entries(guidanceByFlag)) {
        if (flags[flag as keyof PersonaTrustFlags]) {
          expect(guidance).toBe(expected as typeof guidance);
        }
      }
    }
  });
});
