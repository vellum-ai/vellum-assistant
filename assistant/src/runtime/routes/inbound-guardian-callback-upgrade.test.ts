/**
 * Unit tests for `_evaluateGuardianCallbackUpgrade` — the two-anchor predicate
 * that upgrades an `apr:<requestId>:<action>` callback to guardian trust so a
 * principal-bound guardian (no per-channel Slack member row) can click the
 * Approve/Reject buttons on an `access_request` card (LUM-2587).
 *
 * The predicate gates the upgrade on two independent security anchors:
 *   1. principal binding — the request's guardianPrincipalId equals the local
 *      guardian principal, and
 *   2. delivery binding — the request was actually delivered to THIS chat.
 *
 * Both store/identity dependencies are mocked so the decision logic is
 * exercised in isolation (no DB).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Canonical store: the predicate reads the request by id and the list of
// pending requests delivered to the (channel, chat) pair. Both are driven by
// per-test fixtures. We spread the REAL module and override only the two
// functions the predicate calls, so the handler's transitive importers (which
// use other store exports) keep working when this file runs alongside others.
let mockRequestsById: Record<
  string,
  { id: string; guardianPrincipalId: string | null } | null
> = {};
let mockDeliveredHere: { id: string }[] = [];
const deliveryChatCalls: Array<{ channel: string; chat: string }> = [];

const actualStore = await import("../../memory/canonical-guardian-store.js");
mock.module("../../memory/canonical-guardian-store.js", () => ({
  ...actualStore,
  getCanonicalGuardianRequest: (id: string) => mockRequestsById[id] ?? null,
  listPendingCanonicalGuardianRequestsByDestinationChat: (
    channel: string,
    chat: string,
  ) => {
    deliveryChatCalls.push({ channel, chat });
    return mockDeliveredHere;
  },
}));

// Local guardian principal resolution: spread the real module, override the
// single resolver the predicate awaits.
let mockLocalPrincipal: string | undefined = "guardian-principal";
const actualLocalActor = await import("../local-actor-identity.js");
mock.module("../local-actor-identity.js", () => ({
  ...actualLocalActor,
  findLocalGuardianPrincipalId: async () => mockLocalPrincipal,
}));

const { _evaluateGuardianCallbackUpgrade } =
  await import("./inbound-message-handler.js");

beforeEach(() => {
  mockRequestsById = {};
  mockDeliveredHere = [];
  deliveryChatCalls.length = 0;
  mockLocalPrincipal = "guardian-principal";
});

describe("_evaluateGuardianCallbackUpgrade", () => {
  test("upgrades when principal matches AND request was delivered to this chat", async () => {
    mockRequestsById = {
      "req-1": { id: "req-1", guardianPrincipalId: "guardian-principal" },
    };
    mockDeliveredHere = [{ id: "req-1" }];

    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "apr:req-1:approve_once",
      sourceChannel: "slack",
      conversationExternalId: "dm-guardian",
    });

    // Returns the local guardian principal to upgrade the trust context with.
    expect(result).toBe("guardian-principal");
    // Anchor 2 was checked against the actual (channel, chat).
    expect(deliveryChatCalls).toEqual([
      { channel: "slack", chat: "dm-guardian" },
    ]);
  });

  test("does NOT upgrade when the request was not delivered to this chat (replay)", async () => {
    // Principal matches, but the request was delivered to some OTHER chat —
    // listPendingCanonicalGuardianRequestsByDestinationChat for this chat is
    // empty. This is the cross-chat replay vector the delivery anchor blocks.
    mockRequestsById = {
      "req-1": { id: "req-1", guardianPrincipalId: "guardian-principal" },
    };
    mockDeliveredHere = [];

    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "apr:req-1:approve_once",
      sourceChannel: "slack",
      conversationExternalId: "dm-attacker",
    });

    expect(result).toBeNull();
  });

  test("does NOT upgrade when the request principal differs from the local guardian", async () => {
    // Delivered to this chat, but the request belongs to a different principal.
    mockRequestsById = {
      "req-1": { id: "req-1", guardianPrincipalId: "someone-else" },
    };
    mockDeliveredHere = [{ id: "req-1" }];

    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "apr:req-1:approve_once",
      sourceChannel: "slack",
      conversationExternalId: "dm-guardian",
    });

    expect(result).toBeNull();
  });

  test("does NOT upgrade when no local guardian principal exists", async () => {
    mockLocalPrincipal = undefined;
    mockRequestsById = {
      "req-1": { id: "req-1", guardianPrincipalId: "guardian-principal" },
    };
    mockDeliveredHere = [{ id: "req-1" }];

    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "apr:req-1:approve_once",
      sourceChannel: "slack",
      conversationExternalId: "dm-guardian",
    });

    expect(result).toBeNull();
  });

  test("does NOT upgrade when the canonical request is unknown", async () => {
    mockRequestsById = {};
    mockDeliveredHere = [{ id: "req-1" }];

    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "apr:req-1:approve_once",
      sourceChannel: "slack",
      conversationExternalId: "dm-guardian",
    });

    expect(result).toBeNull();
  });

  test("does NOT upgrade for a non-apr callback (e.g. reaction)", async () => {
    const result = await _evaluateGuardianCallbackUpgrade({
      callbackData: "reaction:thumbsup",
      sourceChannel: "slack",
      conversationExternalId: "dm-guardian",
    });

    expect(result).toBeNull();
    // The store is never consulted for a non-apr callback.
    expect(deliveryChatCalls.length).toBe(0);
  });

  test("does NOT upgrade for an empty/undefined callback", async () => {
    expect(
      await _evaluateGuardianCallbackUpgrade({
        callbackData: undefined,
        sourceChannel: "slack",
        conversationExternalId: "dm-guardian",
      }),
    ).toBeNull();
    expect(deliveryChatCalls.length).toBe(0);
  });
});
