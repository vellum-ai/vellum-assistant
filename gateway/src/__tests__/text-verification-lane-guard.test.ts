/**
 * A verification code completes only where one reader exists.
 *
 * The copy that carries a code says "reply here" in a direct message, so a
 * code arriving from a conversation the wire proves has more than one
 * reader (a Discord guild channel, a Slack room) is intercepted, kept away
 * from the assistant and the transcript, and never redeemed; the reply says where to
 * send it without saying whether it was valid. A true DM, or a channel that
 * states no readership fact, proceeds to redemption unchanged.
 *
 * The session store is real and file-backed: the invariant asserted is that
 * the pending session survives a room-posted code untouched.
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

import { hashVerificationSecret } from "@vellumai/gateway-client";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { channelVerificationSessions } from "../db/schema.js";
import { createOutboundSession } from "../db/session-store.js";
import { tryTextVerificationIntercept } from "../verification/text-verification.js";

const CHANNEL = "discord";
const ALICE = "900000000000000001";
const CODE = "123456";

const TEN_MINUTES = 10 * 60 * 1000;

let seq = 0;

function mintOutboundFor(actor: string): string {
  seq += 1;
  const id = `session-${seq}`;
  createOutboundSession({
    id,
    channel: CHANNEL,
    challengeHash: hashVerificationSecret(CODE),
    expiresAt: Date.now() + TEN_MINUTES,
    status: "awaiting_response",
    expectedExternalUserId: actor,
    identityBindingStatus: "bound",
    destinationAddress: actor,
    verificationPurpose: "trusted_contact",
  });
  return id;
}

function statusOf(id: string): string | undefined {
  return getGatewayDb()
    .select({ status: channelVerificationSessions.status })
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get()?.status;
}

function interceptParams(overrides: Record<string, unknown> = {}) {
  return {
    sourceChannel: CHANNEL,
    messageContent: CODE,
    actorExternalUserId: ALICE,
    actorChatId: "conversation-1",
    assistantId: "self",
    ...overrides,
  };
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

describe("verification lane guard", () => {
  test("a valid code posted in a room is intercepted but never redeemed", async () => {
    // The readership fact alone drives the guard: a Discord guild message
    // arrives exactly like this, not-a-DM proven with no visibility stated.
    const sessionId = mintOutboundFor(ALICE);

    const result = await tryTextVerificationIntercept(
      interceptParams({ isDirectMessage: false }),
    );

    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      expect(result.outcome).toBe("wrong_conversation");
      expect(result.pendingReplyText).toContain("direct message");
      expect(result.pendingReplyText).not.toContain(CODE);
    }
    expect(statusOf(sessionId)).toBe("awaiting_response");
  });

  test("a DM proceeds past the guard to redemption", async () => {
    mintOutboundFor(ALICE);

    // A wrong code in a DM reaches the anti-oracle reply, proving the guard
    // let the message through to the redemption path.
    const result = await tryTextVerificationIntercept(
      interceptParams({ messageContent: "654321", isDirectMessage: true }),
    );

    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      expect(result.outcome).toBe("failed");
    }
  });

  test("a channel that states no readership fact is unaffected", async () => {
    mintOutboundFor(ALICE);

    const result = await tryTextVerificationIntercept(
      interceptParams({ messageContent: "654321" }),
    );

    expect(result.intercepted).toBe(true);
    if (result.intercepted) {
      expect(result.outcome).toBe("failed");
    }
  });
});
