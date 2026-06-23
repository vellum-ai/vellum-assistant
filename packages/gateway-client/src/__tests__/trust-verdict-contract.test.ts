/**
 * Tests for the shared trust verdict contract and its optional placement on
 * the inbound payload's sourceMetadata.
 */

import { describe, expect, test } from "bun:test";

import { SourceMetadataSchema } from "../inbound-contract.js";
import {
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
  verifiedVia: "voice",
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
