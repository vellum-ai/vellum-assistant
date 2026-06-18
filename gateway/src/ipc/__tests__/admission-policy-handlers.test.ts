/**
 * Tests for the gateway channel admission policy IPC route.
 *
 * The handler is driven directly with a stubbed feature-flag resolver and an
 * injected admission-policy cache, following the existing gateway IPC handler
 * test patterns (see trust-rules-handlers.test.ts).
 */

import type { AdmissionPolicy } from "@vellumai/gateway-client";
import { beforeEach, describe, expect, mock, test } from "bun:test";

let flagEnabled = true;
const policiesByChannel = new Map<string, AdmissionPolicy>();

mock.module("../../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (_key: string) => flagEnabled,
}));

mock.module("../../risk/admission-policy-cache.js", () => ({
  getAdmissionPolicyCache: () => ({
    get: (channelType: string): AdmissionPolicy =>
      policiesByChannel.get(channelType) ?? "trusted_contacts",
  }),
}));

import { admissionPolicyRoutes } from "../admission-policy-handlers.js";

function getPolicy(channelType: string) {
  return admissionPolicyRoutes[0].handler({ channelType });
}

beforeEach(() => {
  flagEnabled = true;
  policiesByChannel.clear();
});

describe("admissionPolicyRoutes", () => {
  test("registers get_channel_admission_policy with a channelType schema", () => {
    const route = admissionPolicyRoutes[0];

    expect(route.method).toBe("get_channel_admission_policy");
    expect(route.schema?.safeParse({ channelType: "slack" }).success).toBe(
      true,
    );
    expect(route.schema?.safeParse({ channelType: "" }).success).toBe(false);
    expect(route.schema?.safeParse({}).success).toBe(false);
  });

  test("returns null policy when the flag is off", () => {
    flagEnabled = false;
    policiesByChannel.set("slack", "strangers");

    expect(getPolicy("slack")).toEqual({ policy: null });
  });

  test("returns null policy for exempt channels", () => {
    expect(getPolicy("phone")).toEqual({ policy: null });
    expect(getPolicy("platform")).toEqual({ policy: null });
    expect(getPolicy("a2a")).toEqual({ policy: null });
  });

  test("returns null policy for unknown channel strings", () => {
    expect(getPolicy("not-a-channel")).toEqual({ policy: null });
  });

  test("returns the resolved policy for an enforced channel", () => {
    policiesByChannel.set("slack", "any_contact");

    expect(getPolicy("slack")).toEqual({ policy: "any_contact" });
  });

  test("falls back to the cache default for an enforced channel without an override", () => {
    expect(getPolicy("slack")).toEqual({ policy: "trusted_contacts" });
  });
});
