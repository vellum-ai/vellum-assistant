import { describe, expect, test } from "bun:test";

import type { TrustClass } from "./actor-trust-resolver.js";
import { type CapabilitySet, resolveCapabilities } from "./capabilities.js";

/**
 * The capability matrix — the single source of truth for what each trust class
 * may do. If a call site's behavior changes during migration, it changes here
 * (reviewed in one diff) instead of across the ~40 inline conditionals.
 */
const MATRIX: Record<TrustClass, CapabilitySet> = {
  guardian: {
    canSelfApproveTools: true,
    sensitiveToolApproval: "self",
    canManageSchedules: true,
    canUseVerificationControlPlane: true,
    canArchiveBySender: true,
    canAccessMemory: true,
    canAccessPrivilegedDocuments: true,
    unsandboxedShell: true,
    mayBeInteractive: true,
    canActUnderDiskPressureCleanup: true,
    promptTrustGuidance: "none",
  },
  trusted_contact: {
    canSelfApproveTools: false,
    sensitiveToolApproval: "escalate-and-wait",
    canManageSchedules: false,
    canUseVerificationControlPlane: false,
    canArchiveBySender: false,
    canAccessMemory: false,
    canAccessPrivilegedDocuments: false,
    unsandboxedShell: false,
    mayBeInteractive: true,
    canActUnderDiskPressureCleanup: false,
    promptTrustGuidance: "social-engineering-defense",
  },
  unverified_contact: {
    canSelfApproveTools: false,
    sensitiveToolApproval: "escalate-and-wait",
    canManageSchedules: false,
    canUseVerificationControlPlane: false,
    canArchiveBySender: false,
    canAccessMemory: false,
    canAccessPrivilegedDocuments: false,
    unsandboxedShell: false,
    mayBeInteractive: true,
    canActUnderDiskPressureCleanup: false,
    promptTrustGuidance: "social-engineering-defense",
  },
  unknown: {
    canSelfApproveTools: false,
    sensitiveToolApproval: "deny",
    canManageSchedules: false,
    canUseVerificationControlPlane: false,
    canArchiveBySender: false,
    canAccessMemory: false,
    canAccessPrivilegedDocuments: false,
    unsandboxedShell: false,
    mayBeInteractive: false,
    canActUnderDiskPressureCleanup: false,
    promptTrustGuidance: "stranger-warning",
  },
};

describe("resolveCapabilities", () => {
  for (const trustClass of Object.keys(MATRIX) as TrustClass[]) {
    test(`resolves the full capability set for "${trustClass}"`, () => {
      expect(resolveCapabilities(trustClass)).toEqual(MATRIX[trustClass]);
    });
  }

  test("undefined fail-closes to the `unknown` capability set", () => {
    expect(resolveCapabilities(undefined)).toEqual(MATRIX.unknown);
  });

  test("unverified_contact is byte-for-byte identical to trusted_contact (admission-only distinction)", () => {
    expect(resolveCapabilities("unverified_contact")).toEqual(
      resolveCapabilities("trusted_contact"),
    );
  });

  test("only guardian self-approves; only guardian/contacts may be interactive", () => {
    expect(resolveCapabilities("guardian").canSelfApproveTools).toBe(true);
    expect(resolveCapabilities("trusted_contact").canSelfApproveTools).toBe(
      false,
    );

    expect(resolveCapabilities("guardian").mayBeInteractive).toBe(true);
    expect(resolveCapabilities("trusted_contact").mayBeInteractive).toBe(true);
    expect(resolveCapabilities("unverified_contact").mayBeInteractive).toBe(
      true,
    );
    expect(resolveCapabilities("unknown").mayBeInteractive).toBe(false);
  });

  test("sensitive tool approval is graded across the three tiers", () => {
    expect(resolveCapabilities("guardian").sensitiveToolApproval).toBe("self");
    expect(resolveCapabilities("trusted_contact").sensitiveToolApproval).toBe(
      "escalate-and-wait",
    );
    expect(resolveCapabilities("unknown").sensitiveToolApproval).toBe("deny");
  });
});
