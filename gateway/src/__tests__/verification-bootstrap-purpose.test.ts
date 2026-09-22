/**
 * A code minted from a deep link keeps the purpose of the session the link
 * belonged to.
 *
 * A Telegram contact known only by @handle is verified through a deep link:
 * the guardian's flow mints a `pending_bootstrap` session for the contact,
 * and opening the link re-mints an identity-bound session in its place. The
 * handoff does not restate the purpose, so the replacement has to inherit
 * it; otherwise it falls back to the session default, `guardian`, and the
 * contact's code binds them as the guardian. The gateway DB and session
 * store are real; the assistant mirror IPC is acknowledged and otherwise
 * inert.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { hashVerificationSecret } from "@vellumai/gateway-client";

// Spread the actual module so untouched exports stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async () => ({}),
}));

await import("./test-preload.js");
const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { channelVerificationSessions, contactChannels, contacts } =
  await import("../db/schema.js");
const { createOutboundSession, createOutboundSessionGuarded } =
  await import("../verification/session-service.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");
const { getExistingGuardianBinding } =
  await import("../verification/binding-helpers.js");

const CHANNEL = "telegram";
const CONTACT = "777000";

/** The deep-link session the guardian's flow mints for a contact. */
function mintContactDeepLink(): string {
  return createOutboundSession({
    channel: CHANNEL,
    identityBindingStatus: "pending_bootstrap",
    destinationAddress: "@contact_handle",
    bootstrapTokenHash: hashVerificationSecret("deep-link-token"),
    verificationPurpose: "trusted_contact",
  }).sessionId;
}

/** Opening the link: the handoff re-mints without restating a purpose. */
function openDeepLink(sourceSessionId: string) {
  const minted = createOutboundSessionGuarded({
    channel: CHANNEL,
    expectedExternalUserId: CONTACT,
    expectedChatId: CONTACT,
    identityBindingStatus: "bound",
    destinationAddress: CONTACT,
    requireSourceSessionPending: sourceSessionId,
  });
  if ("conflict" in minted) {
    throw new Error(`handoff conflicted: ${minted.reason}`);
  }
  return minted;
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(channelVerificationSessions).run();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

describe("a contact's deep link", () => {
  test("re-mints as a trusted-contact code", () => {
    const minted = openDeepLink(mintContactDeepLink());

    const row = getGatewayDb()
      .select()
      .from(channelVerificationSessions)
      .all()
      .find((s) => s.id === minted.sessionId);
    expect(row?.verificationPurpose).toBe("trusted_contact");
  });

  test("makes the contact a trusted contact, never the guardian", async () => {
    const minted = openDeepLink(mintContactDeepLink());

    const result = await tryTextVerificationIntercept({
      sourceChannel: CHANNEL,
      messageContent: minted.secret,
      actorExternalUserId: CONTACT,
      actorChatId: CONTACT,
      isDirectMessage: true,
    });

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "trusted_contact",
    });
    expect(getExistingGuardianBinding(CHANNEL)).toBeNull();
    const channel = getGatewayDb()
      .select()
      .from(contactChannels)
      .all()
      .find((c) => c.address === CONTACT);
    expect(channel?.status).toBe("active");
  });
});
