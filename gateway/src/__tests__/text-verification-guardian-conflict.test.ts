/**
 * A guardian code on a channel that already has a guardian replaces them.
 *
 * Every guardian mint refuses a guarded channel unless the guardian asked to
 * rebind, so a guardian code redeemed there is a rebind the guardian
 * requested, whichever kind of code it is. The gateway DB and session store
 * are real; the assistant mirror IPC is acknowledged and otherwise inert.
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
const { createInboundSession, createOutboundSession } =
  await import("../db/session-store.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");

const CHANNEL = "telegram";
const OLD_HANDLE = "111000";
const NEW_HANDLE = "777000";
const CODE = "123456";
const GUARDIAN_PRINCIPAL = "principal-guardian";

/**
 * The guardian as a healthy install holds them: one guardian contact with an
 * active `vellum` channel and an active binding on this channel.
 */
function seedGuardian(): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "guardian",
      displayName: "Guardian",
      role: "guardian",
      principalId: GUARDIAN_PRINCIPAL,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const [type, address] of [
    ["vellum", GUARDIAN_PRINCIPAL],
    [CHANNEL, OLD_HANDLE],
  ] as const) {
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: `channel-${type}`,
        contactId: "guardian",
        type,
        address,
        externalChatId: address,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
      })
      .run();
  }
}

function channelOf(address: string) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .find((c) => c.type === CHANNEL && c.address === address);
}

function redeemFromNewHandle(code: string) {
  // No callback URL: the reply comes back as text, as it does for email.
  return tryTextVerificationIntercept({
    sourceChannel: CHANNEL,
    messageContent: code,
    actorExternalUserId: NEW_HANDLE,
    actorChatId: NEW_HANDLE,
    isDirectMessage: true,
  });
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(channelVerificationSessions).run();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  seedGuardian();
});

afterAll(() => {
  resetGatewayDb();
});

/** The code a guardian's rebind to the new handle sends it. */
function mintCodeForNewHandle(): void {
  createOutboundSession({
    id: "session-1",
    channel: CHANNEL,
    challengeHash: hashVerificationSecret(CODE),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: "awaiting_response",
    expectedExternalUserId: NEW_HANDLE,
    identityBindingStatus: "bound",
    destinationAddress: NEW_HANDLE,
    verificationPurpose: "guardian",
  });
}

function expectGuardianMovedToNewHandle(): void {
  expect(channelOf(NEW_HANDLE)).toMatchObject({
    contactId: "guardian",
    status: "active",
  });
  // The guardian contact holds one binding per channel: the old handle no
  // longer has an active one.
  expect(channelOf(OLD_HANDLE)?.status).not.toBe("active");
}

describe("a guardian code on a channel that already has a guardian", () => {
  test("a code sent to the new handle moves the guardian to it", async () => {
    mintCodeForNewHandle();

    const result = await redeemFromNewHandle(CODE);

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
      pendingReplyText:
        "Verification successful. You are now set as the guardian for this channel.",
    });
    expectGuardianMovedToNewHandle();
  });

  test("an inbound challenge redeemed from the new handle moves the guardian to it", async () => {
    const secret = "a".repeat(64);
    createInboundSession({
      id: "session-1",
      channel: CHANNEL,
      challengeHash: hashVerificationSecret(secret),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const result = await redeemFromNewHandle(secret);

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expectGuardianMovedToNewHandle();
  });

  test("a binding write that fails leaves the current guardian in place", async () => {
    mintCodeForNewHandle();
    const db = getGatewayDb();
    db.run(
      `CREATE TRIGGER fail_new_handle_insert BEFORE INSERT ON contact_channels WHEN NEW.address = '${NEW_HANDLE}' BEGIN SELECT RAISE(ABORT, 'binding write failed'); END`,
    );
    db.run(
      `CREATE TRIGGER fail_new_handle_update BEFORE UPDATE ON contact_channels WHEN NEW.address = '${NEW_HANDLE}' BEGIN SELECT RAISE(ABORT, 'binding write failed'); END`,
    );
    try {
      await expect(redeemFromNewHandle(CODE)).rejects.toThrow(
        "binding write failed",
      );
    } finally {
      db.run("DROP TRIGGER fail_new_handle_insert");
      db.run("DROP TRIGGER fail_new_handle_update");
    }

    // The revoke rolled back with the failed binding.
    expect(channelOf(OLD_HANDLE)?.status).toBe("active");
  });

  test("a handle whose channel was revoked can be bound again", async () => {
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "former",
        displayName: "Former",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "former-channel",
        contactId: "former",
        type: CHANNEL,
        address: NEW_HANDLE,
        externalChatId: NEW_HANDLE,
        status: "revoked",
        policy: "deny",
        interactionCount: 0,
        createdAt: now,
      })
      .run();
    mintCodeForNewHandle();

    const result = await redeemFromNewHandle(CODE);

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(channelOf(NEW_HANDLE)?.status).toBe("active");
    expect(channelOf(OLD_HANDLE)?.status).not.toBe("active");
  });
});
