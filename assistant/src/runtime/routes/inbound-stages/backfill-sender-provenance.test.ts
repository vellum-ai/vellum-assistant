import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { InboundTrustReadResult } from "../../../calls/inbound-trust-reader.js";
import * as inboundTrustReader from "../../../calls/inbound-trust-reader.js";
import type { Message as ProviderMessage } from "../../../messaging/provider-types.js";
import { createBackfilledSenderProvenanceResolver } from "./backfill-sender-provenance.js";

const readsBySender = new Map<string, InboundTrustReadResult>();
const readInboundTrustMock = spyOn(
  inboundTrustReader,
  "readInboundTrust",
).mockImplementation(
  async (input) =>
    readsBySender.get(input.actorExternalId ?? "") ?? { ok: false },
);

afterAll(() => {
  readInboundTrustMock.mockRestore();
});

const GUARDIAN_ID = "U_GUARDIAN";

function memberVerdict(
  trustClass: TrustVerdict["trustClass"],
  contactId: string,
  status: string,
): TrustVerdict {
  return {
    trustClass,
    canonicalSenderId: `U_${contactId}`,
    contactId,
    channelId: `ch-${contactId}`,
    status,
    policy: "allow",
  };
}

function readOf(verdict: TrustVerdict): InboundTrustReadResult {
  return { ok: true, verdict, admissionPolicy: null };
}

beforeEach(() => {
  readsBySender.clear();
  readInboundTrustMock.mockClear();
});

describe("createBackfilledSenderProvenanceResolver", () => {
  test("stamps the gateway verdict's trust class and contact id", async () => {
    readsBySender.set(
      "U_ALICE",
      readOf(memberVerdict("trusted_contact", "c-alice", "active")),
    );
    readsBySender.set(
      "U_BOB",
      readOf(memberVerdict("unverified_contact", "c-bob", "unverified")),
    );
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    expect(await resolve("U_ALICE")).toEqual({
      provenanceTrustClass: "trusted_contact",
      provenanceContactId: "c-alice",
    });
    expect(await resolve("U_BOB")).toEqual({
      provenanceTrustClass: "unverified_contact",
      provenanceContactId: "c-bob",
    });
    expect(readInboundTrustMock).toHaveBeenCalledWith({
      channelType: "slack",
      actorExternalId: "U_ALICE",
    });
  });

  test("a stranger verdict carries no contact id and no lookup-failed marker", async () => {
    readsBySender.set(
      "U_STRANGER",
      readOf({ trustClass: "unknown", canonicalSenderId: "U_STRANGER" }),
    );
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    expect(await resolve("U_STRANGER")).toEqual({
      provenanceTrustClass: "unknown",
    });
  });

  test("an unreadable verdict falls back to the guardian address comparison and marks the failed lookup", async () => {
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    expect(await resolve(GUARDIAN_ID)).toEqual({
      provenanceTrustClass: "guardian",
      provenanceLookupFailed: true,
    });
    expect(await resolve("U_ALICE")).toEqual({
      provenanceTrustClass: "unknown",
      provenanceLookupFailed: true,
    });
  });

  test("a resolver-failure verdict is not trusted for class or contact id", async () => {
    readsBySender.set(
      "U_ALICE",
      readOf({
        ...memberVerdict("trusted_contact", "c-alice", "active"),
        resolutionFailed: true,
      }),
    );
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    expect(await resolve("U_ALICE")).toEqual({
      provenanceTrustClass: "unknown",
      provenanceLookupFailed: true,
    });
  });

  test("reads the gateway once per distinct sender", async () => {
    readsBySender.set(
      "U_ALICE",
      readOf(memberVerdict("trusted_contact", "c-alice", "active")),
    );
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    await Promise.all([
      resolve("U_ALICE"),
      resolve(" U_ALICE "),
      resolve("U_BOB"),
    ]);
    await resolve("U_ALICE");

    expect(readInboundTrustMock).toHaveBeenCalledTimes(2);
  });

  test("a row with no sender id is unknown without a gateway read or a lookup-failed marker", async () => {
    const resolve = createBackfilledSenderProvenanceResolver(GUARDIAN_ID, []);

    expect(await resolve(undefined)).toEqual({
      provenanceTrustClass: "unknown",
    });
    expect(readInboundTrustMock).not.toHaveBeenCalled();
  });

  test("starts every sender's read up front and together, bots included", () => {
    const message = (id: string, senderId: string, isBot = false) =>
      ({
        id,
        conversationId: "C1",
        sender: { id: senderId, name: senderId },
        text: "hi",
        timestamp: 0,
        platform: "slack",
        ...(isBot ? { metadata: { isBot: true } } : {}),
      }) satisfies ProviderMessage;

    createBackfilledSenderProvenanceResolver(GUARDIAN_ID, [
      message("1", "U_ALICE"),
      message("2", "B_THIRD_PARTY", true),
      message("3", "U_ALICE"),
      message("4", "U_BOB"),
    ]);

    // Every read is in flight before any of them has settled.
    expect(readInboundTrustMock.mock.calls.map(([input]) => input)).toEqual([
      { channelType: "slack", actorExternalId: "U_ALICE" },
      { channelType: "slack", actorExternalId: "B_THIRD_PARTY" },
      { channelType: "slack", actorExternalId: "U_BOB" },
    ]);
  });
});
