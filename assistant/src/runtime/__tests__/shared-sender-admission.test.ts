/**
 * The shared-sender admission check separates a definitive denial from a
 * trust read that could not be completed, since only a denial is final.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let participant = true;
let read: Record<string, unknown> = { ok: false };

const actualParticipants =
  await import("../../persistence/conversation-participants.js");
mock.module("../../persistence/conversation-participants.js", () => ({
  ...actualParticipants,
  isParticipant: () => participant,
}));
const actualTrustReader = await import("../../calls/inbound-trust-reader.js");
mock.module("../../calls/inbound-trust-reader.js", () => ({
  ...actualTrustReader,
  readInboundTrust: async () => read,
}));

const { checkSharedSender } = await import("../shared-sender-admission.js");

const VERDICT = {
  trustClass: "trusted_contact",
  canonicalSenderId: "principal-alice",
  contactId: "contact-alice",
  channelId: "channel-alice",
  status: "active",
  policy: "allow",
};

beforeEach(() => {
  participant = true;
  read = { ok: true, verdict: VERDICT, admissionPolicy: "trusted_contacts" };
});

const outcome = async () =>
  (await checkSharedSender("conv-1", "principal-alice")).outcome;

describe("checkSharedSender", () => {
  test("admits a participating trusted contact", async () => {
    expect(await outcome()).toBe("admitted");
  });

  test.each([
    { label: "no longer a participant", setup: () => (participant = false) },
    {
      label: "revoked",
      setup: () =>
        (read = {
          ok: true,
          verdict: { ...VERDICT, status: "revoked" },
          admissionPolicy: "trusted_contacts",
        }),
    },
    {
      label: "below the admission floor",
      setup: () =>
        (read = {
          ok: true,
          verdict: VERDICT,
          admissionPolicy: "guardian_only",
        }),
    },
    {
      label: "resolved to a non-contact class",
      setup: () =>
        (read = {
          ok: true,
          verdict: { ...VERDICT, trustClass: "unknown" },
          admissionPolicy: null,
        }),
    },
  ])("denies a sender $label", async ({ setup }) => {
    setup();
    expect(await outcome()).toBe("denied");
  });

  test.each([
    { label: "the gateway read fails", value: { ok: false } },
    {
      label: "the gateway cannot vouch",
      value: {
        ok: true,
        verdict: { ...VERDICT, resolutionFailed: true },
        admissionPolicy: "trusted_contacts",
      },
    },
  ])("answers unverifiable when $label", async ({ value }) => {
    read = value;
    expect(await outcome()).toBe("unverifiable");
  });
});
