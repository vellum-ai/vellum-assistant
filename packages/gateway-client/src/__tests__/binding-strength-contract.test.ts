/**
 * Tests for the shared binding-strength vocabulary: the display ladder and the
 * enforcement order (demotion guard — LUM-2505).
 */

import { describe, expect, test } from "bun:test";

import {
  bindingStrengthForVerifiedVia,
  isBindingDemotion,
  knownStrengthRank,
  VERIFIED_VIA_CHALLENGE,
  VERIFIED_VIA_CHANNEL_CLAIM,
  VERIFIED_VIA_MANUAL,
} from "../binding-strength-contract.js";

describe("knownStrengthRank", () => {
  test("unverified (null / undefined / empty) ranks 0", () => {
    expect(knownStrengthRank(null)).toBe(0);
    expect(knownStrengthRank(undefined)).toBe(0);
    expect(knownStrengthRank("")).toBe(0);
  });

  test("inbound channel claim ranks 1", () => {
    expect(knownStrengthRank(VERIFIED_VIA_CHANNEL_CLAIM)).toBe(1);
  });

  test("workspace-vouched (manual) ranks 2", () => {
    expect(knownStrengthRank(VERIFIED_VIA_MANUAL)).toBe(2);
  });

  test("proven / possession values all rank 3", () => {
    expect(knownStrengthRank(VERIFIED_VIA_CHALLENGE)).toBe(3);
    expect(knownStrengthRank("invite")).toBe(3);
    expect(knownStrengthRank("voice")).toBe(3);
    expect(knownStrengthRank("bootstrap")).toBe(3);
    // Guardian auto-registration bindings (createGuardianBinding writers).
    expect(knownStrengthRank("platform_auto_register")).toBe(3);
    expect(knownStrengthRank("webhook_registration")).toBe(3);
  });

  test("unrecognized non-empty provenance is unknown (null)", () => {
    expect(knownStrengthRank("guardian_approval")).toBeNull();
    expect(knownStrengthRank("something_new")).toBeNull();
  });
});

describe("bindingStrengthForVerifiedVia (display ladder)", () => {
  test("maps the three introduction-card provenances", () => {
    expect(bindingStrengthForVerifiedVia(VERIFIED_VIA_CHALLENGE)).toBe(
      "verified_handshake",
    );
    expect(bindingStrengthForVerifiedVia(VERIFIED_VIA_MANUAL)).toBe(
      "internal_workspace_match",
    );
    expect(bindingStrengthForVerifiedVia(VERIFIED_VIA_CHANNEL_CLAIM)).toBe(
      "inbound_channel_claim",
    );
  });

  test("returns null for provenance outside the ladder (card UI relies on this)", () => {
    expect(bindingStrengthForVerifiedVia("invite")).toBeNull();
    expect(bindingStrengthForVerifiedVia("bootstrap")).toBeNull();
    expect(bindingStrengthForVerifiedVia("voice")).toBeNull();
    expect(bindingStrengthForVerifiedVia(null)).toBeNull();
    expect(bindingStrengthForVerifiedVia(undefined)).toBeNull();
  });
});

describe("isBindingDemotion", () => {
  test("a lower-strength source demoting a higher-strength binding is refused", () => {
    // challenge (3) is the strongest — nothing weaker may overwrite it.
    expect(isBindingDemotion(VERIFIED_VIA_CHALLENGE, VERIFIED_VIA_MANUAL)).toBe(
      true,
    );
    expect(
      isBindingDemotion(VERIFIED_VIA_CHALLENGE, VERIFIED_VIA_CHANNEL_CLAIM),
    ).toBe(true);
    // manual (2) may not be demoted to an inbound claim (1).
    expect(
      isBindingDemotion(VERIFIED_VIA_MANUAL, VERIFIED_VIA_CHANNEL_CLAIM),
    ).toBe(true);
    // A proven value demoted to null/unverified is a demotion too.
    expect(isBindingDemotion(VERIFIED_VIA_CHALLENGE, null)).toBe(true);
    // Guardian auto-registration bindings are proven — a later manual attest
    // or channel claim can never demote them.
    expect(
      isBindingDemotion("platform_auto_register", VERIFIED_VIA_MANUAL),
    ).toBe(true);
    expect(
      isBindingDemotion("webhook_registration", VERIFIED_VIA_CHANNEL_CLAIM),
    ).toBe(true);
  });

  test("equal-tier writes and lateral proven swaps are not demotions", () => {
    expect(isBindingDemotion(VERIFIED_VIA_CHALLENGE, "invite")).toBe(false);
    expect(isBindingDemotion("invite", VERIFIED_VIA_CHALLENGE)).toBe(false);
    expect(isBindingDemotion(VERIFIED_VIA_MANUAL, VERIFIED_VIA_MANUAL)).toBe(
      false,
    );
  });

  test("upgrades are not demotions", () => {
    expect(
      isBindingDemotion(VERIFIED_VIA_CHANNEL_CLAIM, VERIFIED_VIA_CHALLENGE),
    ).toBe(false);
    expect(isBindingDemotion(null, VERIFIED_VIA_CHANNEL_CLAIM)).toBe(false);
    expect(isBindingDemotion(VERIFIED_VIA_MANUAL, VERIFIED_VIA_CHALLENGE)).toBe(
      false,
    );
  });

  test("unknown provenance on either side is never a demotion (fail-open)", () => {
    expect(isBindingDemotion(VERIFIED_VIA_CHALLENGE, "guardian_approval")).toBe(
      false,
    );
    expect(
      isBindingDemotion("guardian_approval", VERIFIED_VIA_CHANNEL_CLAIM),
    ).toBe(false);
    expect(isBindingDemotion("unknown_a", "unknown_b")).toBe(false);
  });
});
