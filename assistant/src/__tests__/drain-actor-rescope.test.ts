/**
 * A persisted turn is scoped to the actor the row is attributed to.
 *
 * History is scoped to the conversation's resting actor: `loadFromDb` splices
 * persisted personal-memory blocks into the transcript only for actors allowed
 * to see them. A queue drain hands `persistUserMessage` the sender it captured
 * at enqueue time, but the resting slot is mutable and another request can
 * have stamped it since. Scoping off the slot therefore let a contact's queued
 * turn run against the guardian's transcript, personal memory included.
 *
 * Exercised against `Conversation.prototype.persistUserMessage` directly: the
 * drain-level fakes elsewhere stub `persistUserMessage` wholesale, so a test
 * driven through `drainQueue` would bypass the code under test entirely.
 */
import { describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../daemon/trust-context-types.js";

const persistCalls: Array<{ content: string }> = [];
let persistThrows: Error | undefined;

mock.module("../daemon/conversation-messaging.js", () => ({
  persistUserMessage: async (_ctx: unknown, options: { content: string }) => {
    persistCalls.push({ content: options.content });
    if (persistThrows) {
      throw persistThrows;
    }
    return { id: "msg-1", deduplicated: false };
  },
  enqueueMessage: () => ({ queued: false }),
  redirectToSecurePrompt: () => {},
  persistQueuedMessageBody: async () => ({ id: "msg-1" }),
  restingTrust: (c: { trustContext?: TrustContext }) => c?.trustContext,
}));

const { Conversation } = await import("../daemon/conversation.js");

const GUARDIAN: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "vellum",
};
// Non-guardian, so `isPersonalMemoryAllowed` is false for it while true for
// the guardian: the axis `loadFromDb` gates personal-memory blocks on.
const CONTACT: TrustContext = {
  trustClass: "unverified_contact",
  sourceChannel: "slack",
};

/**
 * Minimal receiver for `persistUserMessage.call(...)`. Records the order of
 * stamp and re-scope, because "re-scoped" only means anything if it happened
 * before the transcript was read.
 */
function makeReceiver(restingTrust: TrustContext, processing = false) {
  const calls: string[] = [];
  const receiver = {
    _processing: processing,
    trustContext: restingTrust as TrustContext | null,
    setTrustContext(ctx: TrustContext | null) {
      calls.push(`stamp:${ctx?.trustClass ?? "null"}`);
      receiver.trustContext = ctx;
    },
    async ensureActorScopedHistory() {
      calls.push(`scope:${receiver.trustContext?.trustClass ?? "none"}`);
    },
  };
  return { receiver, calls };
}

const persist = Conversation.prototype.persistUserMessage;

describe("persistUserMessage scopes history to the row's actor", () => {
  test("a contact's queued row re-scopes away from the guardian before persisting", async () => {
    persistThrows = undefined;
    persistCalls.length = 0;
    const { receiver, calls } = makeReceiver(GUARDIAN);

    await persist.call(
      receiver as never,
      {
        content: "what did we decide?",
        trustContext: CONTACT,
      } as never,
    );

    expect(calls).toEqual([
      "stamp:unverified_contact",
      "scope:unverified_contact",
    ]);
    expect(persistCalls).toEqual([{ content: "what did we decide?" }]);
    expect(receiver.trustContext).toEqual(CONTACT);
  });

  test("a row with no actor of its own leaves the owner in place", async () => {
    persistThrows = undefined;
    persistCalls.length = 0;
    const { receiver, calls } = makeReceiver(GUARDIAN);

    await persist.call(receiver as never, { content: "internal" } as never);

    // No stamp: nothing claimed this row for a different actor, so the owner
    // stands rather than being overwritten with a guess.
    expect(calls).toEqual(["scope:guardian"]);
    expect(receiver.trustContext).toEqual(GUARDIAN);
  });

  test("a persist that loses the lock restores the actor it displaced", async () => {
    persistCalls.length = 0;
    persistThrows = new Error("The assistant is currently responding");
    const { receiver, calls } = makeReceiver(GUARDIAN);

    await expect(
      persist.call(
        receiver as never,
        {
          content: "queued behind a turn",
          trustContext: CONTACT,
        } as never,
      ),
    ).rejects.toThrow("currently responding");

    // The contact's turn never runs, so its actor must not outlive the
    // attempt: the guardian is put back and history re-scoped to them.
    expect(calls).toEqual([
      "stamp:unverified_contact",
      "scope:unverified_contact",
      "stamp:guardian",
      "scope:guardian",
    ]);
    expect(receiver.trustContext).toEqual(GUARDIAN);
  });

  test("the restore leaves a stamp made by whoever took the lock alone", async () => {
    persistCalls.length = 0;
    const { receiver, calls } = makeReceiver(GUARDIAN);
    const lockHolder: TrustContext = {
      trustClass: "trusted_contact",
      sourceChannel: "phone",
    };
    persistThrows = new Error("The assistant is currently responding");
    // Whoever took the lock re-stamps the slot while the reload is in flight.
    const originalScope = receiver.ensureActorScopedHistory;
    receiver.ensureActorScopedHistory = async () => {
      await originalScope.call(receiver);
      receiver.trustContext = lockHolder;
    };

    await expect(
      persist.call(
        receiver as never,
        {
          content: "queued",
          trustContext: CONTACT,
        } as never,
      ),
    ).rejects.toThrow("currently responding");

    // Guarded restore: our stamp is no longer the one in the slot, so it is
    // left as the lock holder set it rather than clobbered back.
    expect(calls).toEqual([
      "stamp:unverified_contact",
      "scope:unverified_contact",
    ]);
    expect(receiver.trustContext).toEqual(lockHolder);
  });
});
