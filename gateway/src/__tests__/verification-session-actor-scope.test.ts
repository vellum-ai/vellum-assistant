/**
 * Two people can be verifying on one channel at the same time.
 *
 * A fresh outbound session supersedes the same actor's prior one, so only
 * their latest code is live and an intercepted earlier one is useless. It must
 * not supersede anyone else's: two people's codes have no replay relationship,
 * because `checkIdentityMatch` binds each to its own `expectedExternalUserId`,
 * so A's code cannot be spent against B's session.
 *
 * The failure this guards is silent from both ends. The revoked holder is told
 * only that their code is "invalid or has expired", which is the anti-oracle
 * reply and deliberately says nothing, and the guardian who caused it by
 * approving someone else sees no sign at all. So these assert what survives a
 * mint rather than what the mint returned.
 *
 * The DB is real and file-backed, so a session's status after a mint is read
 * back from the row rather than inferred.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import "./test-preload.js";

import {
  createInboundSession,
  createOutboundSession,
  findActiveSession,
  findPendingSessionByHash,
  hasInterceptableSession,
} from "../db/session-store.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { channelVerificationSessions } from "../db/schema.js";

const CHANNEL = "discord";
/** Two requesters on the same community server. */
const ALICE = "900000000000000001";
const BOB = "900000000000000002";

const TEN_MINUTES = 10 * 60 * 1000;

let seq = 0;

/** Mint an outbound session the way an approved access request does. */
function mintOutboundFor(
  actor: string | null,
  overrides: {
    channel?: string;
    status?: "awaiting_response" | "pending_bootstrap";
  } = {},
) {
  seq += 1;
  return createOutboundSession({
    id: `session-${seq}`,
    channel: overrides.channel ?? CHANNEL,
    challengeHash: `hash-${seq}`,
    expiresAt: Date.now() + TEN_MINUTES,
    status: overrides.status ?? "awaiting_response",
    expectedExternalUserId: actor,
    identityBindingStatus: "bound",
    destinationAddress: actor,
    verificationPurpose: "trusted_contact",
  });
}

function statusOf(id: string): string | undefined {
  return getGatewayDb()
    .select({ status: channelVerificationSessions.status })
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get()?.status;
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(channelVerificationSessions).run();
});

afterAll(() => {
  resetGatewayDb();
});

describe("an outbound mint supersedes only its own actor", () => {
  test("Bob's approval leaves Alice's code live", () => {
    const alice = mintOutboundFor(ALICE);
    const bob = mintOutboundFor(BOB);

    expect(statusOf(alice.id)).toBe("awaiting_response");
    expect(statusOf(bob.id)).toBe("awaiting_response");
  });

  test("Alice's code is still redeemable after Bob is approved", () => {
    // The count above could pass while the consume path still refused the
    // code, so this asserts the thing the requester actually experiences.
    const alice = mintOutboundFor(ALICE);
    mintOutboundFor(BOB);

    const found = findPendingSessionByHash(CHANNEL, alice.challengeHash);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(alice.id);
  });

  test("Alice re-requesting does supersede her own earlier code", () => {
    // The replay window this exists to close. Two live codes for one identity
    // means an intercepted first one is still spendable.
    const first = mintOutboundFor(ALICE);
    const second = mintOutboundFor(ALICE);

    expect(statusOf(first.id)).toBe("revoked");
    expect(statusOf(second.id)).toBe("awaiting_response");
    expect(findPendingSessionByHash(CHANNEL, first.challengeHash)).toBeNull();
  });

  test("a mint on one channel leaves another channel alone", () => {
    const onDiscord = mintOutboundFor(ALICE);
    mintOutboundFor(ALICE, { channel: "slack" });

    expect(statusOf(onDiscord.id)).toBe("awaiting_response");
  });
});

describe("channels that identify the actor by chat id", () => {
  // Telegram guardian mints carry only `expectedChatId`, and
  // `checkIdentityMatch` redeems those on a chat-id match. Keying the
  // supersede on the user id alone would leave every earlier code on the
  // chat live for its full TTL.
  function mintChatKeyed(chatId: string) {
    seq += 1;
    return createOutboundSession({
      id: `session-${seq}`,
      channel: "telegram",
      challengeHash: `hash-${seq}`,
      expiresAt: Date.now() + TEN_MINUTES,
      status: "awaiting_response",
      expectedChatId: chatId,
      identityBindingStatus: "bound",
      destinationAddress: chatId,
      verificationPurpose: "guardian",
    });
  }

  test("a resend to the same chat supersedes the earlier code", () => {
    const first = mintChatKeyed("123456789");
    const second = mintChatKeyed("123456789");

    expect(statusOf(first.id)).toBe("revoked");
    expect(statusOf(second.id)).toBe("awaiting_response");
    expect(
      findPendingSessionByHash("telegram", first.challengeHash),
    ).toBeNull();
  });

  test("a mint to another chat leaves the first alone", () => {
    const first = mintChatKeyed("123456789");
    mintChatKeyed("987654321");

    expect(statusOf(first.id)).toBe("awaiting_response");
  });

  test("two people in one group chat keep their own codes", () => {
    // A row carrying both fields redeems only on the user id, so a
    // chat-keyed match must not reach it.
    seq += 1;
    const alice = createOutboundSession({
      id: `session-${seq}`,
      channel: "telegram",
      challengeHash: `hash-${seq}`,
      expiresAt: Date.now() + TEN_MINUTES,
      status: "awaiting_response",
      expectedExternalUserId: ALICE,
      expectedChatId: "group-1",
      identityBindingStatus: "bound",
      verificationPurpose: "guardian",
    });

    mintChatKeyed("group-1");

    expect(statusOf(alice.id)).toBe("awaiting_response");
  });
});

describe("an outbound mint leaves inbound challenges alone", () => {
  test("an inbound challenge survives an unrelated outbound mint", () => {
    // Inbound sessions have their own supersede in `createInboundSession`, and
    // an outbound mint has nothing to say about one.
    seq += 1;
    const inbound = createInboundSession({
      id: `inbound-${seq}`,
      channel: CHANNEL,
      challengeHash: `inbound-hash-${seq}`,
      expiresAt: Date.now() + TEN_MINUTES,
    });

    mintOutboundFor(ALICE);

    expect(statusOf(inbound.id)).toBe("pending");
  });
});

describe("a session with no actor supersedes nothing", () => {
  test("a bootstrap mint does not revoke a bound session", () => {
    // Bootstrap sessions carry no identity until the deep link is redeemed,
    // and are claimed atomically by `requireSourceSessionPending` instead.
    const bound = mintOutboundFor(ALICE);
    mintOutboundFor(null, { status: "pending_bootstrap" });

    expect(statusOf(bound.id)).toBe("awaiting_response");
  });
});

describe("findActiveSession", () => {
  test("returns one actor's session when asked for whose", () => {
    const alice = mintOutboundFor(ALICE);
    const bob = mintOutboundFor(BOB);

    expect(
      findActiveSession(CHANNEL, { expectedExternalUserId: ALICE })?.id,
    ).toBe(alice.id);
    expect(
      findActiveSession(CHANNEL, { expectedExternalUserId: BOB })?.id,
    ).toBe(bob.id);
  });

  test("unfiltered, returns the most recent regardless of actor", () => {
    // The shape a caller gets when it does not say whose session it means.
    //
    // Both mints land in the same millisecond, so `created_at` ties and the
    // insert-order tiebreak is the only thing deciding this.
    mintOutboundFor(ALICE);
    const bob = mintOutboundFor(BOB);

    expect(findActiveSession(CHANNEL)?.id).toBe(bob.id);
  });

  test("the latest is the one written last, not the one stamped last", () => {
    // Ten same-millisecond mints. Any tie-break that is not insert order
    // picks the wrong one here well before ten.
    let last = mintOutboundFor(ALICE);
    for (let i = 0; i < 9; i += 1) {
      last = mintOutboundFor(`actor-${i}`);
    }

    expect(findActiveSession(CHANNEL)?.id).toBe(last.id);
  });

  test("returns null for an actor with nothing in flight", () => {
    mintOutboundFor(ALICE);

    expect(
      findActiveSession(CHANNEL, { expectedExternalUserId: BOB }),
    ).toBeNull();
  });
});

describe("hasInterceptableSession", () => {
  test("stays an any-match across several actors", () => {
    // It gates the text-verification intercept, so it has to answer "could any
    // message here be a code", not "is one particular person verifying".
    mintOutboundFor(ALICE);
    mintOutboundFor(BOB);

    expect(hasInterceptableSession(CHANNEL)).toBe(true);
  });
});
