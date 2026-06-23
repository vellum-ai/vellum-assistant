/**
 * Unit tests for `resolveAnchoredGuardian`.
 *
 * Covers the gateway arms (source-channel match validated against the vellum
 * anchor, vellum-anchor fallback), the LOCAL-store fallback when the gateway
 * list is empty, and the cosmetic `requireAnchorPrincipal` guard.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

// Local store fallback is mocked so we can drive both arms deterministically.
let localGuardians: Record<
  string,
  { contact: { principalId: string | null; displayName: string }; channel: { address: string; type: string } } | null
> = {};
mock.module("../contacts/contact-store.js", () => ({
  findGuardianForChannel: (channelType: string) =>
    localGuardians[channelType] ?? null,
}));

const { resolveAnchoredGuardian } = await import("./anchored-guardian.js");

function gw(g: Partial<GuardianDelivery> & { channelType: string; address: string }): GuardianDelivery {
  return {
    contactId: `c-${g.channelType}`,
    status: "active",
    ...g,
  };
}

afterEach(() => {
  localGuardians = {};
});

describe("resolveAnchoredGuardian — gateway arm", () => {
  test("source-channel guardian matching the anchor wins", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({ channelType: "vellum", address: "v-addr", principalId: "p-anchor", displayName: "Vellum" }),
        gw({ channelType: "telegram", address: "tg-addr", principalId: "p-anchor", displayName: "Alice" }),
      ],
      sourceChannel: "telegram",
    });
    expect(result).toEqual({
      principalId: "p-anchor",
      address: "tg-addr",
      displayName: "Alice",
      channelType: "telegram",
      source: "source-channel-contact",
    });
  });

  test("source-channel guardian NOT matching the anchor falls back to vellum-anchor", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({ channelType: "vellum", address: "v-addr", principalId: "p-anchor", displayName: "Vellum" }),
        gw({ channelType: "telegram", address: "tg-addr", principalId: "p-other", displayName: "Stale" }),
      ],
      sourceChannel: "telegram",
    });
    expect(result).toEqual({
      principalId: "p-anchor",
      address: "v-addr",
      displayName: "Vellum",
      channelType: "vellum",
      source: "vellum-anchor",
    });
  });

  test("no source-channel guardian falls back to vellum-anchor", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({ channelType: "vellum", address: "v-addr", principalId: "p-anchor", displayName: "Vellum" }),
      ],
      sourceChannel: "telegram",
    });
    expect(result?.source).toBe("vellum-anchor");
    expect(result?.principalId).toBe("p-anchor");
  });
});

describe("resolveAnchoredGuardian — local fallback", () => {
  test("gateway empty + local source-channel match returns the local record", () => {
    localGuardians = {
      vellum: { contact: { principalId: "p-local", displayName: "LocalVellum" }, channel: { address: "lv-addr", type: "vellum" } },
      telegram: { contact: { principalId: "p-local", displayName: "LocalAlice" }, channel: { address: "ltg-addr", type: "telegram" } },
    };
    const result = resolveAnchoredGuardian({
      guardians: null,
      sourceChannel: "telegram",
      useLocalFallback: true,
    });
    expect(result).toEqual({
      principalId: "p-local",
      address: "ltg-addr",
      displayName: "LocalAlice",
      channelType: "telegram",
      source: "source-channel-contact",
    });
  });

  test("gateway empty + only local vellum returns the local vellum-anchor", () => {
    localGuardians = {
      vellum: { contact: { principalId: "p-local", displayName: "LocalVellum" }, channel: { address: "lv-addr", type: "vellum" } },
    };
    const result = resolveAnchoredGuardian({
      guardians: null,
      sourceChannel: "telegram",
      useLocalFallback: true,
    });
    expect(result?.source).toBe("vellum-anchor");
    expect(result?.address).toBe("lv-addr");
  });

  test("gateway empty + no local + fallback disabled returns null", () => {
    const result = resolveAnchoredGuardian({
      guardians: null,
      sourceChannel: "telegram",
    });
    expect(result).toBeNull();
  });

  test("nothing anywhere returns null", () => {
    const result = resolveAnchoredGuardian({
      guardians: [],
      sourceChannel: "telegram",
      useLocalFallback: true,
    });
    expect(result).toBeNull();
  });
});

describe("resolveAnchoredGuardian — requireAnchorPrincipal (cosmetic label)", () => {
  test("vellum guardian with a null principal degrades to null", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({ channelType: "vellum", address: "v-addr", principalId: null, displayName: "Vellum" }),
      ],
      sourceChannel: "telegram",
      requireAnchorPrincipal: true,
    });
    expect(result).toBeNull();
  });

  test("without requireAnchorPrincipal a null-principal vellum still resolves", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({ channelType: "vellum", address: "v-addr", principalId: null, displayName: "Vellum" }),
      ],
      sourceChannel: "telegram",
    });
    expect(result?.source).toBe("vellum-anchor");
    expect(result?.principalId).toBeNull();
  });
});
