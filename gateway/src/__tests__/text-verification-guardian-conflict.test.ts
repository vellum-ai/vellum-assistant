/**
 * The guardian is one person, and a channel holds at most one linked identity
 * for them. On a text channel a guardian code never swaps that identity for
 * another, and a guardian who removed their identity can link the same one
 * again.
 *
 * The gateway DB and session store are real; the assistant mirror IPC is
 * acknowledged and otherwise inert.
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

/** The daemon's answer to every IPC call; a test swaps it to fail. */
let ipcCallAssistantImpl: () => Promise<unknown> = async () => ({});

// Spread the actual module so untouched exports stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: () => ipcCallAssistantImpl(),
}));

await import("./test-preload.js");
const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { channelVerificationSessions, contactChannels, contacts } =
  await import("../db/schema.js");
const { createInboundSession, createOutboundSession, getSessionById } =
  await import("../db/session-store.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");

const CHANNEL = "slack";
const OLD_ACCOUNT = "U0OLD00001";
const NEW_ACCOUNT = "U0NEW00002";
const OTHER_ACCOUNT = "U0OTHER003";
const CODE = "123456";
const GUARDIAN_PRINCIPAL = "principal-guardian";
const INVALID_OR_EXPIRED = "The verification code is invalid or has expired.";

type ChannelStatus = "active" | "revoked" | "blocked";

function seedContact(id: string, role: "guardian" | "contact"): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: id,
      role,
      principalId: role === "guardian" ? GUARDIAN_PRINCIPAL : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(row: {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status: ChannelStatus;
}): void {
  getGatewayDb()
    .insert(contactChannels)
    .values({
      ...row,
      externalChatId: row.address,
      policy: row.status === "active" ? "allow" : "deny",
      interactionCount: 0,
      createdAt: Date.now(),
    })
    .run();
}

/** The guardian's own row on the channel, in the given state. */
function seedGuardianAccount(
  address: string,
  status: ChannelStatus = "active",
): void {
  seedChannel({
    id: `guardian-${address}`,
    contactId: "guardian",
    type: CHANNEL,
    address,
    status,
  });
}

function channelOf(address: string) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .find((c) => c.type === CHANNEL && c.address === address);
}

function activeGuardianAccounts(): string[] {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .filter(
      (c) =>
        c.type === CHANNEL &&
        c.contactId === "guardian" &&
        c.status === "active",
    )
    .map((c) => c.address)
    .sort();
}

/** A guardian code bound to an account. */
function mintCodeFor(
  account: string,
  session: { id: string; code: string } = { id: "session-1", code: CODE },
): void {
  createOutboundSession({
    id: session.id,
    channel: CHANNEL,
    challengeHash: hashVerificationSecret(session.code),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: "awaiting_response",
    expectedExternalUserId: account,
    identityBindingStatus: "bound",
    destinationAddress: account,
    verificationPurpose: "guardian",
  });
}

function redeem(code: string, from: string) {
  // No callback URL: the reply comes back as text, as it does for email.
  return tryTextVerificationIntercept({
    sourceChannel: CHANNEL,
    messageContent: code,
    actorExternalUserId: from,
    actorChatId: from,
    isDirectMessage: true,
  });
}

function expectRefused(result: Awaited<ReturnType<typeof redeem>>): void {
  expect(result).toMatchObject({
    intercepted: true,
    outcome: "failed",
    pendingReplyText: expect.stringContaining(INVALID_OR_EXPIRED),
  });
  // The code matched and is spent, so it cannot be tried again.
  expect(getSessionById("session-1")?.status).toBe("consumed");
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  ipcCallAssistantImpl = async () => ({});
  getGatewayDb().delete(channelVerificationSessions).run();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  seedContact("guardian", "guardian");
  seedChannel({
    id: "guardian-vellum",
    contactId: "guardian",
    type: "vellum",
    address: GUARDIAN_PRINCIPAL,
    status: "active",
  });
});

afterAll(() => {
  resetGatewayDb();
});

describe("a guardian code from an identity other than the one linked on the channel", () => {
  beforeEach(() => {
    seedGuardianAccount(OLD_ACCOUNT);
  });

  test("is refused, and the sender becomes neither guardian nor contact", async () => {
    mintCodeFor(NEW_ACCOUNT);

    expectRefused(await redeem(CODE, NEW_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
    expect(channelOf(NEW_ACCOUNT)).toBeUndefined();
  });

  test("is refused when it is an inbound challenge too", async () => {
    const secret = "a".repeat(64);
    createInboundSession({
      id: "session-1",
      channel: CHANNEL,
      challengeHash: hashVerificationSecret(secret),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    expectRefused(await redeem(secret, NEW_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
    expect(channelOf(NEW_ACCOUNT)).toBeUndefined();
  });

  test("is refused even when the sender holds a second active guardian row", async () => {
    // Two active guardian rows is not a state the product creates, and it is
    // the one where reading a single row could pick the sender's own and
    // then revoke the other.
    seedGuardianAccount(OTHER_ACCOUNT);
    mintCodeFor(OTHER_ACCOUNT);

    expectRefused(await redeem(CODE, OTHER_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT, OTHER_ACCOUNT]);
  });

  test("leaves the sender's own revoked row revoked while another identity is linked", async () => {
    seedContact("former", "contact");
    seedChannel({
      id: "former-channel",
      contactId: "former",
      type: CHANNEL,
      address: NEW_ACCOUNT,
      status: "revoked",
    });
    mintCodeFor(NEW_ACCOUNT);

    expectRefused(await redeem(CODE, NEW_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
    expect(channelOf(NEW_ACCOUNT)?.status).toBe("revoked");
  });

  test("refuses without the daemon when another identity is linked", async () => {
    ipcCallAssistantImpl = async () => {
      throw new Error("assistant unreachable");
    };
    mintCodeFor(NEW_ACCOUNT);

    expectRefused(await redeem(CODE, NEW_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
  });

  test("still lets the current guardian verify their own account again", async () => {
    mintCodeFor(OLD_ACCOUNT);

    expect(await redeem(CODE, OLD_ACCOUNT)).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
  });
});

describe("a guardian code on a channel with no linked identity", () => {
  test("binds a new account", async () => {
    mintCodeFor(NEW_ACCOUNT);

    expect(await redeem(CODE, NEW_ACCOUNT)).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(activeGuardianAccounts()).toEqual([NEW_ACCOUNT]);
  });

  test("links only one identity when two codes are redeemed at once", async () => {
    // Both redemptions are in flight before either binds. The second to
    // reach the refusal check has to see the first one's binding.
    mintCodeFor(NEW_ACCOUNT, { id: "session-1", code: "111111" });
    mintCodeFor(OTHER_ACCOUNT, { id: "session-2", code: "222222" });

    const results = await Promise.all([
      redeem("111111", NEW_ACCOUNT),
      redeem("222222", OTHER_ACCOUNT),
    ]);

    expect(
      results
        .map((r) => (r.intercepted ? r.outcome : "not intercepted"))
        .sort(),
    ).toEqual(["failed", "verified"]);
    expect(activeGuardianAccounts()).toHaveLength(1);
  });

  test("binds with the name the channel gave when the daemon cannot answer", async () => {
    ipcCallAssistantImpl = async () => {
      throw new Error("assistant unreachable");
    };
    mintCodeFor(NEW_ACCOUNT);

    expect(await redeem(CODE, NEW_ACCOUNT)).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(activeGuardianAccounts()).toEqual([NEW_ACCOUNT]);
  });

  test("reconnects the account the guardian removed", async () => {
    seedGuardianAccount(OLD_ACCOUNT, "revoked");
    mintCodeFor(OLD_ACCOUNT);

    expect(await redeem(CODE, OLD_ACCOUNT)).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(activeGuardianAccounts()).toEqual([OLD_ACCOUNT]);
  });

  describe("from an address whose revoked row belonged to a contact, not the guardian", () => {
    // Nothing else refuses here: no identity is linked, the row is revoked
    // (not blocked) and its address matches exactly. Only the owner of the
    // row separates this sender from the guardian reconnecting.
    beforeEach(() => {
      seedContact("former", "contact");
      seedChannel({
        id: "former-channel",
        contactId: "former",
        type: CHANNEL,
        address: NEW_ACCOUNT,
        status: "revoked",
      });
    });

    function expectStillARevokedContact(): void {
      expect(activeGuardianAccounts()).toEqual([]);
      expect(channelOf(NEW_ACCOUNT)).toMatchObject({
        contactId: "former",
        status: "revoked",
      });
    }

    test("a code bound to that address is refused", async () => {
      mintCodeFor(NEW_ACCOUNT);

      expectRefused(await redeem(CODE, NEW_ACCOUNT));

      expectStillARevokedContact();
    });

    test("an inbound challenge, which is bound to no identity, is refused", async () => {
      const secret = "b".repeat(64);
      createInboundSession({
        id: "session-1",
        channel: CHANNEL,
        challengeHash: hashVerificationSecret(secret),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      expectRefused(await redeem(secret, NEW_ACCOUNT));

      expectStillARevokedContact();
    });
  });

  test("connects a new account after the old one was removed", async () => {
    seedGuardianAccount(OLD_ACCOUNT, "revoked");
    mintCodeFor(NEW_ACCOUNT);

    expect(await redeem(CODE, NEW_ACCOUNT)).toMatchObject({
      outcome: "verified",
    });
    expect(activeGuardianAccounts()).toEqual([NEW_ACCOUNT]);
  });

  test("does not reconnect a revoked row stored under a different spelling of the address", async () => {
    // The row is found case-insensitively, and reactivated only when its
    // stored address is exactly the redeeming one.
    seedGuardianAccount(OLD_ACCOUNT.toLowerCase(), "revoked");
    mintCodeFor(OLD_ACCOUNT);

    expectRefused(await redeem(CODE, OLD_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([]);
    expect(channelOf(OLD_ACCOUNT.toLowerCase())?.status).toBe("revoked");
  });

  test("never binds a blocked account", async () => {
    seedContact("blocked", "contact");
    seedChannel({
      id: "blocked-channel",
      contactId: "blocked",
      type: CHANNEL,
      address: NEW_ACCOUNT,
      status: "blocked",
    });
    mintCodeFor(NEW_ACCOUNT);

    expectRefused(await redeem(CODE, NEW_ACCOUNT));

    expect(activeGuardianAccounts()).toEqual([]);
    expect(channelOf(NEW_ACCOUNT)?.status).toBe("blocked");
  });
});
