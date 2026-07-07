/**
 * Tests for the shared trust verdict contract and its optional placement on
 * the inbound payload's sourceMetadata.
 */

import { describe, expect, test } from "bun:test";

import { SourceMetadataSchema } from "../inbound-contract.js";
import {
  makeResolutionFailedVerdict,
  makeUnauthenticatedSenderVerdict,
  ResolveInboundTrustResponseSchema,
  TrustVerdictSchema,
  type TrustVerdict,
} from "../trust-verdict-contract.js";

const fullVerdict: TrustVerdict = {
  trustClass: "trusted_contact",
  canonicalSenderId: "+15555550100",
  guardianExternalUserId: "g-ext-1",
  guardianDeliveryChatId: "chat-1",
  guardianPrincipalId: "g-principal-1",
  guardianDisplayName: "Guardian Name",
  contactId: "c1",
  channelId: "ch1",
  type: "imessage",
  address: "+15555550100",
  externalChatId: "ext-chat-1",
  status: "active",
  policy: "allow",
  verifiedAt: 1699999999,
  interactionCount: 12,
  memberDisplayName: "Member Name",
};

describe("TrustVerdictSchema", () => {
  test("round-trips a fully-populated verdict", () => {
    expect(TrustVerdictSchema.parse(fullVerdict)).toEqual(fullVerdict);
  });

  test("parses a minimal verdict", () => {
    const minimal = {
      trustClass: "unknown",
      canonicalSenderId: null,
    } satisfies TrustVerdict;
    expect(TrustVerdictSchema.parse(minimal)).toEqual(minimal);
  });

  test("parses a verdict carrying resolutionFailed", () => {
    const verdict = {
      trustClass: "unknown",
      canonicalSenderId: null,
      resolutionFailed: true,
    } satisfies TrustVerdict;
    expect(TrustVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  test("leaves resolutionFailed undefined when absent", () => {
    const parsed = TrustVerdictSchema.parse({
      trustClass: "unknown",
      canonicalSenderId: null,
    });
    expect(parsed.resolutionFailed).toBeUndefined();
  });

  test("makeResolutionFailedVerdict builds an unknown sentinel", () => {
    expect(makeResolutionFailedVerdict("+15555550100")).toEqual({
      trustClass: "unknown",
      canonicalSenderId: "+15555550100",
      resolutionFailed: true,
    });
    expect(makeResolutionFailedVerdict(null)).toEqual({
      trustClass: "unknown",
      canonicalSenderId: null,
      resolutionFailed: true,
    });
  });

  test("makeUnauthenticatedSenderVerdict builds a plain stranger (not resolutionFailed)", () => {
    // Distinct from makeResolutionFailedVerdict: an unauthenticated sender is
    // a real stranger and must flow through the normal admission/verification
    // lane, so it carries no resolutionFailed flag and no guardian/member keys.
    const verdict = makeUnauthenticatedSenderVerdict("+15555550100");
    expect(verdict).toEqual({
      trustClass: "unknown",
      canonicalSenderId: "+15555550100",
    });
    expect(verdict.resolutionFailed).toBeUndefined();
    expect(TrustVerdictSchema.parse(verdict)).toEqual(verdict);
    expect(makeUnauthenticatedSenderVerdict(null)).toEqual({
      trustClass: "unknown",
      canonicalSenderId: null,
    });
  });

  test("carries interaction telemetry", () => {
    const parsed = TrustVerdictSchema.parse({
      trustClass: "trusted_contact",
      canonicalSenderId: "+15555550100",
      interactionCount: 0,
    });
    expect(parsed.interactionCount).toBe(0);
  });

  test("leaves interaction telemetry undefined when absent", () => {
    const parsed = TrustVerdictSchema.parse({
      trustClass: "unknown",
      canonicalSenderId: null,
    });
    expect(parsed.interactionCount).toBeUndefined();
  });

  test("rejects an invalid trustClass", () => {
    expect(() =>
      TrustVerdictSchema.parse({
        trustClass: "definitely_not_a_class",
        canonicalSenderId: null,
      }),
    ).toThrow();
  });
});

describe("SourceMetadataSchema trustVerdict back-compat", () => {
  test("parses an empty payload (no trustVerdict)", () => {
    expect(SourceMetadataSchema.parse({})).toEqual({});
  });

  test("round-trips a payload carrying trustVerdict", () => {
    const parsed = SourceMetadataSchema.parse({ trustVerdict: fullVerdict });
    expect(parsed.trustVerdict).toEqual(fullVerdict);
  });
});

describe("ResolveInboundTrustResponseSchema", () => {
  test("round-trips a verdict with an admission policy", () => {
    const parsed = ResolveInboundTrustResponseSchema.parse({
      verdict: fullVerdict,
      admissionPolicy: "guardian_only",
    });
    expect(parsed).toEqual({
      verdict: fullVerdict,
      admissionPolicy: "guardian_only",
    });
  });

  test("accepts an explicit null admission policy (no enforcement)", () => {
    const parsed = ResolveInboundTrustResponseSchema.parse({
      verdict: fullVerdict,
      admissionPolicy: null,
    });
    expect(parsed.admissionPolicy).toBeNull();
  });

  test("rejects a missing admission policy field", () => {
    expect(() =>
      ResolveInboundTrustResponseSchema.parse({ verdict: fullVerdict }),
    ).toThrow();
  });

  test("rejects an out-of-vocabulary admission policy", () => {
    expect(() =>
      ResolveInboundTrustResponseSchema.parse({
        verdict: fullVerdict,
        admissionPolicy: "everyone",
      }),
    ).toThrow();
  });
});
