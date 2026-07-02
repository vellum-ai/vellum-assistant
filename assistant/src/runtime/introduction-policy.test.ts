import { describe, expect, test } from "bun:test";

import {
  bindingStrengthForVerifiedVia,
  buildIntroductionActions,
  isHandshakeOffered,
  isWorkspaceVouchedIdentity,
  parseRequesterSignals,
  resolveTrustBinding,
  serializeRequesterSignals,
  VERIFIED_VIA_CHANNEL_CLAIM,
  VERIFIED_VIA_MANUAL,
} from "./introduction-policy.js";

describe("requester signal serialization", () => {
  test("round-trips set signals and omits unset ones", () => {
    const raw = serializeRequesterSignals({ isBot: true, isStranger: true });
    expect(raw).toBeDefined();
    expect(parseRequesterSignals(raw)).toEqual({
      isBot: true,
      isStranger: true,
    });
  });

  test("preserves explicit false — a positive platform resolution", () => {
    const raw = serializeRequesterSignals({
      isBot: false,
      isStranger: false,
      isRestricted: false,
    });
    expect(raw).toBeDefined();
    expect(parseRequesterSignals(raw)).toEqual({
      isBot: false,
      isStranger: false,
      isRestricted: false,
    });
  });

  test("returns undefined when no signal is set", () => {
    expect(serializeRequesterSignals({})).toBeUndefined();
    expect(
      serializeRequesterSignals({ isBot: undefined, isStranger: undefined }),
    ).toBeUndefined();
  });

  test("parse fails closed on malformed input", () => {
    expect(parseRequesterSignals("not json")).toEqual({});
    expect(parseRequesterSignals('"a string"')).toEqual({});
    expect(parseRequesterSignals(null)).toEqual({});
    expect(parseRequesterSignals(undefined)).toEqual({});
    // Non-boolean values never become signals; explicit booleans survive.
    expect(parseRequesterSignals('{"isBot":"yes","isStranger":false}')).toEqual(
      { isStranger: false },
    );
  });
});

/** Explicit positive resolution: Slack vouched this is a regular member. */
const SLACK_MEMBER = { isStranger: false, isRestricted: false } as const;

describe("workspace vouching", () => {
  test("slack member with positive signals is workspace-vouched", () => {
    expect(isWorkspaceVouchedIdentity("slack", SLACK_MEMBER)).toBe(true);
    expect(
      isWorkspaceVouchedIdentity("slack", { ...SLACK_MEMBER, isBot: true }),
    ).toBe(true);
  });

  // Regression (fail-open guard): absent signals — users.info timeout or
  // cache miss — must NOT be treated as workspace-vouched.
  test("unknown signals fail toward NOT vouched", () => {
    expect(isWorkspaceVouchedIdentity("slack", {})).toBe(false);
    expect(isWorkspaceVouchedIdentity("slack", { isStranger: false })).toBe(
      false,
    );
    expect(isWorkspaceVouchedIdentity("slack", { isRestricted: false })).toBe(
      false,
    );
  });

  test("slack strangers and restricted guests are not vouched", () => {
    expect(
      isWorkspaceVouchedIdentity("slack", {
        isStranger: true,
        isRestricted: false,
      }),
    ).toBe(false);
    expect(
      isWorkspaceVouchedIdentity("slack", {
        isStranger: false,
        isRestricted: true,
      }),
    ).toBe(false);
  });

  test("non-slack channels carry no workspace identity", () => {
    expect(isWorkspaceVouchedIdentity("telegram", SLACK_MEMBER)).toBe(false);
    expect(isWorkspaceVouchedIdentity("phone", SLACK_MEMBER)).toBe(false);
    expect(isWorkspaceVouchedIdentity(undefined, SLACK_MEMBER)).toBe(false);
  });
});

describe("handshake policy", () => {
  test("never offered for bots, on any channel", () => {
    expect(isHandshakeOffered("slack", { isBot: true })).toBe(false);
    expect(isHandshakeOffered("slack", { isBot: true, isStranger: true })).toBe(
      false,
    );
    expect(isHandshakeOffered("telegram", { isBot: true })).toBe(false);
  });

  test("not offered for workspace-vouched slack members", () => {
    expect(isHandshakeOffered("slack", SLACK_MEMBER)).toBe(false);
  });

  test("not offered on voice", () => {
    expect(isHandshakeOffered("phone", {})).toBe(false);
  });

  test("leads for externals, strangers, and identity-less channels", () => {
    expect(isHandshakeOffered("slack", { isStranger: true })).toBe(true);
    expect(isHandshakeOffered("slack", { isRestricted: true })).toBe(true);
    // Unknown signals (users.info failure) fail toward the handshake.
    expect(isHandshakeOffered("slack", {})).toBe(true);
    expect(isHandshakeOffered("telegram", {})).toBe(true);
    expect(isHandshakeOffered("email", {})).toBe(true);
  });
});

describe("introduction action lists", () => {
  test("workspace member: direct trust leads, no code option", () => {
    expect(
      buildIntroductionActions("slack", SLACK_MEMBER).map((a) => a.id),
    ).toEqual(["trust", "leave_unverified", "block"]);
  });

  test("bot: trust only — the code option is never rendered", () => {
    for (const channel of ["slack", "telegram", "whatsapp"]) {
      const ids = buildIntroductionActions(channel, {
        isBot: true,
        isStranger: true,
      }).map((a) => a.id);
      expect(ids).not.toContain("verify_code");
      expect(ids).toEqual(["trust", "leave_unverified", "block"]);
    }
  });

  test("external: handshake leads, trust is 'Trust anyway'", () => {
    const actions = buildIntroductionActions("slack", { isStranger: true });
    expect(actions.map((a) => a.id)).toEqual([
      "verify_code",
      "trust",
      "leave_unverified",
      "block",
    ]);
    expect(actions[0].label).toBe("Verify with a code");
    expect(actions[1].label).toBe("Trust anyway");
  });
});

describe("binding strength", () => {
  test("trust on a workspace member records internal_workspace_match via manual", () => {
    expect(resolveTrustBinding("slack", SLACK_MEMBER)).toEqual({
      bindingStrength: "internal_workspace_match",
      verifiedVia: VERIFIED_VIA_MANUAL,
    });
  });

  // Regression (fail-open guard): unknown signals must never earn
  // workspace-match provenance.
  test("trust with unknown signals records inbound_channel_claim", () => {
    expect(resolveTrustBinding("slack", {})).toEqual({
      bindingStrength: "inbound_channel_claim",
      verifiedVia: VERIFIED_VIA_CHANNEL_CLAIM,
    });
  });

  // Regression (LUM-2670 ladder honesty): a trusted-anyway external must NOT
  // carry the same binding strength as a code-verified contact.
  test("trust-anyway on an external records inbound_channel_claim, NOT verified_handshake", () => {
    for (const [channel, signals] of [
      ["slack", { isStranger: true }],
      ["slack", { isRestricted: true }],
      ["telegram", {}],
    ] as const) {
      const binding = resolveTrustBinding(channel, signals);
      expect(binding.bindingStrength).toBe("inbound_channel_claim");
      expect(binding.bindingStrength).not.toBe("verified_handshake");
      expect(binding.verifiedVia).toBe(VERIFIED_VIA_CHANNEL_CLAIM);
      // The persisted provenance must not collapse into the code-verified or
      // workspace-vouched values.
      expect(binding.verifiedVia).not.toBe("challenge");
      expect(bindingStrengthForVerifiedVia(binding.verifiedVia)).toBe(
        "inbound_channel_claim",
      );
    }
  });

  test("verifiedVia provenance maps onto the ladder", () => {
    expect(bindingStrengthForVerifiedVia("challenge")).toBe(
      "verified_handshake",
    );
    expect(bindingStrengthForVerifiedVia("manual")).toBe(
      "internal_workspace_match",
    );
    expect(bindingStrengthForVerifiedVia("manual_channel_claim")).toBe(
      "inbound_channel_claim",
    );
    // Pre-ladder provenance keeps its own audit meaning.
    expect(bindingStrengthForVerifiedVia("invite")).toBeNull();
    expect(bindingStrengthForVerifiedVia("bootstrap")).toBeNull();
    expect(bindingStrengthForVerifiedVia(null)).toBeNull();
  });
});
