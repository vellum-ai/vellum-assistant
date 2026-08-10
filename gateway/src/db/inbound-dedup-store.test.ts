/**
 * The gateway's claim on an inbound delivery.
 *
 * What is being tested is a single question asked concurrently: two copies of
 * the same delivery must not both be told to proceed. The rest follows from
 * that: the release exists so a claim taken for a handoff that then failed
 * does not answer the retry it just asked for, and the expiry exists so the
 * table does not grow a row per message forever.
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
  hasInboundEventClaim,
  releaseInboundEvent,
  reserveInboundEvent,
} from "./inbound-dedup-store.js";
import { inboundSeenEvents } from "./schema.js";

const KEY = {
  sourceChannel: "plugin",
  externalChatId: "imessage:+12025550142",
  externalMessageId: "imessage:msg-1",
};

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
    expect(
      reserveInboundEvent({ ...KEY, externalMessageId: "imessage:msg-2" }),
    ).toBe(true);
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

  it("hands the claim on once it has expired", () => {
    // A vendor still sending this an hour after the window closed is sending
    // something new, and answering it as a duplicate would drop a real
    // message. The reclaim happens in place, so no sweep has to have run.
    expect(reserveInboundEvent(KEY, -1)).toBe(true);
    expect(reserveInboundEvent(KEY)).toBe(true);
    expect(reserveInboundEvent(KEY)).toBe(false);
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
    reserveInboundEvent({ ...KEY, externalMessageId: "imessage:msg-2" });

    releaseInboundEvent(KEY);

    expect(hasInboundEventClaim(KEY)).toBe(false);
    expect(
      hasInboundEventClaim({ ...KEY, externalMessageId: "imessage:msg-2" }),
    ).toBe(true);
  });
});

describe("cleanupExpiredInboundEvents", () => {
  it("drops the expired and keeps the live", () => {
    reserveInboundEvent(KEY, -1);
    reserveInboundEvent({ ...KEY, externalMessageId: "imessage:msg-2" });

    expect(cleanupExpiredInboundEvents()).toBe(1);
    expect(
      hasInboundEventClaim({ ...KEY, externalMessageId: "imessage:msg-2" }),
    ).toBe(true);
  });
});
