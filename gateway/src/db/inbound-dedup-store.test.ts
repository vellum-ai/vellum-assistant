/**
 * The gateway's claim on an inbound delivery.
 *
 * What is being tested is a single question asked concurrently: two copies of
 * the same delivery must not both be told to proceed. The rest follows from
 * that: the release exists so a claim taken for a handoff that then failed
 * does not answer the retry it just asked for, the lease exists so a claim
 * abandoned by a crash frees itself, and the expiry exists so the table does
 * not grow a row per message forever.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import "../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "./connection.js";
import {
  cleanupExpiredInboundEvents,
  commitInboundEvent,
  readInboundEventClaim,
  releaseInboundEvent,
  reserveInboundEvent,
  INBOUND_DEDUP_TTL_MS,
} from "./inbound-dedup-store.js";
import { inboundSeenEvents } from "./schema.js";

const KEY = {
  sourceChannel: "plugin",
  externalChatId: "imessage:+12025550142",
  externalMessageId: "imessage:msg-1",
};

const OTHER = { ...KEY, externalMessageId: "imessage:msg-2" };

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(inboundSeenEvents).run();
});

describe("reserveInboundEvent", () => {
  it("gives the claim to the first caller and no one else", () => {
    expect(reserveInboundEvent(KEY)).toBe(true);
    expect(reserveInboundEvent(KEY)).toBe(false);
    expect(reserveInboundEvent(KEY)).toBe(false);
  });

  it("treats a different message in the same conversation as its own", () => {
    // Otherwise a second message from the same sender would be swallowed as a
    // retry of the first, which is the failure mode a dedup key that was too
    // coarse would produce.
    expect(reserveInboundEvent(KEY)).toBe(true);
    expect(reserveInboundEvent(OTHER)).toBe(true);
  });

  it("keeps two plugins numbering from one out of each other's keyspace", () => {
    // `pluginScopedId` is what makes this true upstream; the store's job is
    // only to not collapse ids that arrive already distinct.
    expect(
      reserveInboundEvent({
        ...KEY,
        externalChatId: "imessage:room",
        externalMessageId: "imessage:1",
      }),
    ).toBe(true);
    expect(
      reserveInboundEvent({
        ...KEY,
        externalChatId: "signal:room",
        externalMessageId: "signal:1",
      }),
    ).toBe(true);
  });

  it("claims on a lease, not the full window", () => {
    // The distinction the crash case rests on: until the delivery lands, the
    // claim has to be short enough to outlive nothing.
    expect(readInboundEventClaim(KEY)).toBeUndefined();

    reserveInboundEvent(KEY);

    const pending = readInboundEventClaim(KEY);
    expect(pending?.state).toBe("pending");
    expect(pending!.expiresAt - pending!.seenAt).toBeLessThan(
      INBOUND_DEDUP_TTL_MS,
    );
  });

  it("hands the claim on once the lease has lapsed", () => {
    // A gateway that died between claiming a delivery and forwarding it runs
    // nothing, so nothing releases. The lease is the only thing that makes the
    // message deliverable again, and it has to work without a sweep.
    expect(reserveInboundEvent(KEY, -1)).toBe(true);
    expect(reserveInboundEvent(KEY)).toBe(true);
    expect(reserveInboundEvent(KEY)).toBe(false);
  });
});

describe("commitInboundEvent", () => {
  it("widens the claim to the full dedup window", () => {
    reserveInboundEvent(KEY);
    commitInboundEvent(KEY);

    const claim = readInboundEventClaim(KEY);
    expect(claim?.state).toBe("committed");
    expect(claim!.expiresAt).toBeGreaterThan(
      Date.now() + INBOUND_DEDUP_TTL_MS / 2,
    );
  });

  it("keeps blocking redelivery after the lease would have lapsed", () => {
    // The point of committing: a delivery that landed stays deduped for the
    // whole window, not just for the lease it was claimed on.
    reserveInboundEvent(KEY, 50);
    commitInboundEvent(KEY);

    expect(reserveInboundEvent(KEY)).toBe(false);
  });

  it("does not reach into a claim that replaced its own", () => {
    // A commit whose lease lapsed mid-flight must not promote whatever took
    // the key over; that row belongs to a delivery still in flight.
    reserveInboundEvent(KEY, -1);
    reserveInboundEvent(KEY);

    commitInboundEvent(OTHER);

    expect(readInboundEventClaim(KEY)?.state).toBe("pending");
  });
});

describe("releaseInboundEvent", () => {
  it("lets the delivery be claimed again", () => {
    // The rollback for a handoff that failed after the claim was taken.
    expect(reserveInboundEvent(KEY)).toBe(true);
    releaseInboundEvent(KEY);
    expect(reserveInboundEvent(KEY)).toBe(true);
  });

  it("is silent about a claim that was never held", () => {
    expect(() => releaseInboundEvent(KEY)).not.toThrow();
  });

  it("releases only the claim it was given", () => {
    reserveInboundEvent(KEY);
    reserveInboundEvent(OTHER);

    releaseInboundEvent(KEY);

    expect(readInboundEventClaim(KEY)).toBeUndefined();
    expect(readInboundEventClaim(OTHER)).toBeDefined();
  });

  it("does not retract a delivery that already landed", () => {
    // A release is a caller giving up its own in-flight claim, never a
    // retraction of something the assistant already took.
    reserveInboundEvent(KEY);
    commitInboundEvent(KEY);

    releaseInboundEvent(KEY);

    expect(readInboundEventClaim(KEY)?.state).toBe("committed");
  });
});

describe("cleanupExpiredInboundEvents", () => {
  it("drops the expired and keeps the live", () => {
    reserveInboundEvent(KEY, -1);
    reserveInboundEvent(OTHER);

    expect(cleanupExpiredInboundEvents()).toBe(1);
    expect(readInboundEventClaim(OTHER)).toBeDefined();
  });
});
