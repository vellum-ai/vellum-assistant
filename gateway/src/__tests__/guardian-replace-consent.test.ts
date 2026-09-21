/**
 * A guardian code takes a channel from its guardian only when the guardian
 * consented to that at mint.
 *
 * The consent is recorded on the session as the guardian address it names
 * (`replacesGuardianAddress`), and redemption binds against that record. The
 * gateway DB and session store are real; the assistant mirror IPC is
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
const { createInboundSession, createOutboundSession, getSessionById } =
  await import("../db/session-store.js");
const { createInboundVerificationSession, createOutboundSessionGuarded } =
  await import("../verification/session-service.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");

const CHANNEL = "telegram";
const OLD_HANDLE = "111000";
const NEW_HANDLE = "777000";
const OTHER_HANDLE = "999000";
const CODE = "123456";
const GUARDIAN_PRINCIPAL = "principal-guardian";
const INVALID_OR_EXPIRED = "The verification code is invalid or has expired.";

function seedGuardianContact(): void {
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
  seedChannel({
    id: "channel-vellum",
    contactId: "guardian",
    type: "vellum",
    address: GUARDIAN_PRINCIPAL,
    status: "active",
  });
}

function seedChannel(row: {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status: "active" | "revoked" | "blocked";
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

/** The guardian holds the channel through their old handle. */
function seedGuardedChannel(): void {
  seedChannel({
    id: "channel-old",
    contactId: "guardian",
    type: CHANNEL,
    address: OLD_HANDLE,
    status: "active",
  });
}

function seedContact(id: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: id,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function channelOf(address: string) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .find((c) => c.type === CHANNEL && c.address === address);
}

function activeGuardianHandles(): string[] {
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
    .map((c) => c.address);
}

/** A guardian code bound to a handle, carrying the given consent record. */
function mintCodeFor(
  handle: string,
  replacesGuardianAddress: string | null,
): void {
  createOutboundSession({
    id: "session-1",
    channel: CHANNEL,
    challengeHash: hashVerificationSecret(CODE),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: "awaiting_response",
    expectedExternalUserId: handle,
    identityBindingStatus: "bound",
    destinationAddress: handle,
    verificationPurpose: "guardian",
    replacesGuardianAddress,
  });
}

function redeem(code: string, from: string = NEW_HANDLE) {
  // No callback URL: the reply comes back as text, as it does for email.
  return tryTextVerificationIntercept({
    sourceChannel: CHANNEL,
    messageContent: code,
    actorExternalUserId: from,
    actorChatId: from,
    isDirectMessage: true,
  });
}

function expectRefusedAndGuardianUnchanged(
  result: Awaited<ReturnType<typeof redeem>>,
): void {
  expect(result).toMatchObject({
    intercepted: true,
    outcome: "failed",
    pendingReplyText: expect.stringContaining(INVALID_OR_EXPIRED),
  });
  expect(activeGuardianHandles()).toEqual([OLD_HANDLE]);
  // The code matched and is spent, so it cannot be tried again.
  expect(getSessionById("session-1")?.status).toBe("consumed");
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(channelVerificationSessions).run();
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
  seedGuardianContact();
});

afterAll(() => {
  resetGatewayDb();
});

describe("redeeming a guardian code on a channel that has a guardian", () => {
  beforeEach(seedGuardedChannel);

  test("a code minted to replace the current guardian moves the guardian to the sender", async () => {
    mintCodeFor(NEW_HANDLE, OLD_HANDLE);

    const result = await redeem(CODE);

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
      pendingReplyText:
        "Verification successful. You are now set as the guardian for this channel.",
    });
    expect(activeGuardianHandles()).toEqual([NEW_HANDLE]);
  });

  test("a code minted without that consent is refused and makes the sender nothing", async () => {
    mintCodeFor(NEW_HANDLE, null);

    const result = await redeem(CODE);

    expectRefusedAndGuardianUnchanged(result);
    // Not a guardian, and not a trusted contact either: no row at all.
    expect(channelOf(NEW_HANDLE)).toBeUndefined();
  });

  test("a code minted to replace an earlier guardian does not replace the current one", async () => {
    mintCodeFor(NEW_HANDLE, OTHER_HANDLE);

    const result = await redeem(CODE);

    expectRefusedAndGuardianUnchanged(result);
  });

  test("an inbound challenge replaces the guardian only with consent", async () => {
    const secret = "a".repeat(64);
    createInboundSession({
      id: "session-1",
      channel: CHANNEL,
      challengeHash: hashVerificationSecret(secret),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    expectRefusedAndGuardianUnchanged(await redeem(secret));

    createInboundSession({
      id: "session-2",
      channel: CHANNEL,
      challengeHash: hashVerificationSecret(secret),
      expiresAt: Date.now() + 10 * 60 * 1000,
      replacesGuardianAddress: OLD_HANDLE,
    });
    expect(await redeem(secret)).toMatchObject({ outcome: "verified" });
    expect(activeGuardianHandles()).toEqual([NEW_HANDLE]);
  });

  test("the current guardian re-verifying needs no consent", async () => {
    mintCodeFor(OLD_HANDLE, null);

    const result = await redeem(CODE, OLD_HANDLE);

    expect(result).toMatchObject({ outcome: "verified" });
    expect(activeGuardianHandles()).toEqual([OLD_HANDLE]);
  });

  test("a second active guardian row the code does not name refuses the code", async () => {
    seedChannel({
      id: "channel-other",
      contactId: "guardian",
      type: CHANNEL,
      address: OTHER_HANDLE,
      status: "active",
    });
    mintCodeFor(NEW_HANDLE, OLD_HANDLE);

    const result = await redeem(CODE);

    expect(result).toMatchObject({ outcome: "failed" });
    expect(activeGuardianHandles().sort()).toEqual([OLD_HANDLE, OTHER_HANDLE]);
  });

  test("a binding write that fails leaves the current guardian in place", async () => {
    mintCodeFor(NEW_HANDLE, OLD_HANDLE);
    const db = getGatewayDb();
    db.run(
      `CREATE TRIGGER fail_new_handle_insert BEFORE INSERT ON contact_channels WHEN NEW.address = '${NEW_HANDLE}' BEGIN SELECT RAISE(ABORT, 'binding write failed'); END`,
    );
    db.run(
      `CREATE TRIGGER fail_new_handle_update BEFORE UPDATE ON contact_channels WHEN NEW.address = '${NEW_HANDLE}' BEGIN SELECT RAISE(ABORT, 'binding write failed'); END`,
    );
    try {
      await expect(redeem(CODE)).rejects.toThrow("binding write failed");
    } finally {
      db.run("DROP TRIGGER fail_new_handle_insert");
      db.run("DROP TRIGGER fail_new_handle_update");
    }

    // The revoke rolled back with the failed binding.
    expect(activeGuardianHandles()).toEqual([OLD_HANDLE]);
  });

  test("a sender whose channel was revoked is bound again", async () => {
    seedContact("former");
    seedChannel({
      id: "former-channel",
      contactId: "former",
      type: CHANNEL,
      address: NEW_HANDLE,
      status: "revoked",
    });
    mintCodeFor(NEW_HANDLE, OLD_HANDLE);

    const result = await redeem(CODE);

    expect(result).toMatchObject({ outcome: "verified" });
    expect(activeGuardianHandles()).toEqual([NEW_HANDLE]);
  });

  test("a blocked sender is refused even with consent, and the guardian stays", async () => {
    seedContact("blocked");
    seedChannel({
      id: "blocked-channel",
      contactId: "blocked",
      type: CHANNEL,
      address: NEW_HANDLE,
      status: "blocked",
    });
    mintCodeFor(NEW_HANDLE, OLD_HANDLE);

    const result = await redeem(CODE);

    expectRefusedAndGuardianUnchanged(result);
    expect(channelOf(NEW_HANDLE)?.status).toBe("blocked");
  });
});

describe("redeeming a guardian code on a channel with no guardian", () => {
  test("binds the sender without any consent record", async () => {
    mintCodeFor(NEW_HANDLE, null);

    const result = await redeem(CODE);

    expect(result).toMatchObject({
      outcome: "verified",
      trustClass: "guardian",
    });
    expect(activeGuardianHandles()).toEqual([NEW_HANDLE]);
  });
});

describe("what a mint records as the guardian it may replace", () => {
  function mint(
    params: Partial<Parameters<typeof createOutboundSessionGuarded>[0]> = {},
  ) {
    const minted = createOutboundSessionGuarded({
      channel: CHANNEL,
      expectedExternalUserId: NEW_HANDLE,
      identityBindingStatus: "bound",
      verificationPurpose: "guardian",
      ...params,
    });
    if ("conflict" in minted) {
      throw new Error(`mint conflicted: ${minted.reason}`);
    }
    return minted;
  }

  function recordedOn(sessionId: string): string | null | undefined {
    return getSessionById(sessionId)?.replacesGuardianAddress;
  }

  test("the channel's guardian, when the guardian asked to replace them", () => {
    seedGuardedChannel();

    expect(recordedOn(mint({ replaceGuardian: true }).sessionId)).toBe(
      OLD_HANDLE,
    );
  });

  test("nobody, when the guardian did not ask", () => {
    seedGuardedChannel();

    expect(recordedOn(mint().sessionId)).toBeNull();
    expect(recordedOn(mint({ replaceGuardian: false }).sessionId)).toBeNull();
  });

  test("nobody, when the channel has no guardian to replace", () => {
    expect(recordedOn(mint({ replaceGuardian: true }).sessionId)).toBeNull();
  });

  test("nobody, for a trusted-contact code", () => {
    seedGuardedChannel();

    const { sessionId } = mint({
      verificationPurpose: "trusted_contact",
      replaceGuardian: true,
    });

    expect(recordedOn(sessionId)).toBeNull();
  });

  test("an inbound challenge records it the same way", () => {
    seedGuardedChannel();

    const consented = createInboundVerificationSession(
      CHANNEL,
      undefined,
      true,
    );
    expect(consented.session.replacesGuardianAddress).toBe(OLD_HANDLE);

    const plain = createInboundVerificationSession(CHANNEL);
    expect(plain.session.replacesGuardianAddress).toBeNull();
  });

  test("a resend keeps the consent of the session it continues", () => {
    seedGuardedChannel();
    const first = mint({ replaceGuardian: true });

    const resent = mint({ continuesSessionId: first.sessionId });

    expect(recordedOn(resent.sessionId)).toBe(OLD_HANDLE);
    // The resend superseded the code it continues.
    expect(getSessionById(first.sessionId)?.status).toBe("revoked");
  });

  test("a resend of a code minted without consent gains none", () => {
    seedGuardedChannel();
    const first = mint();

    const resent = mint({
      continuesSessionId: first.sessionId,
      replaceGuardian: true,
    });

    expect(recordedOn(resent.sessionId)).toBeNull();
  });

  test("consent does not move onto another identity", () => {
    seedGuardedChannel();
    const first = mint({ replaceGuardian: true });

    const other = mint({
      expectedExternalUserId: OTHER_HANDLE,
      continuesSessionId: first.sessionId,
    });

    expect(recordedOn(other.sessionId)).toBeNull();
  });

  test("a session that is not live passes nothing on", () => {
    seedGuardedChannel();
    const first = mint({ replaceGuardian: true });
    // A second mint for the same identity supersedes the first.
    mint({ replaceGuardian: true });

    const resent = mint({ continuesSessionId: first.sessionId });

    expect(recordedOn(resent.sessionId)).toBeNull();
  });

  test("a deep link's code keeps the consent the link was minted with", () => {
    seedGuardedChannel();
    const link = createOutboundSessionGuarded({
      channel: CHANNEL,
      identityBindingStatus: "pending_bootstrap",
      verificationPurpose: "guardian",
      bootstrapTokenHash: hashVerificationSecret("token"),
      replaceGuardian: true,
    });
    if ("conflict" in link) {
      throw new Error("link mint conflicted");
    }

    const code = mint({ requireSourceSessionPending: link.sessionId });

    expect(recordedOn(code.sessionId)).toBe(OLD_HANDLE);
  });

  test("a consented mint redeems end to end", async () => {
    seedGuardedChannel();
    const { secret } = mint({ replaceGuardian: true });

    expect(await redeem(secret)).toMatchObject({ outcome: "verified" });
    expect(activeGuardianHandles()).toEqual([NEW_HANDLE]);
  });
});
