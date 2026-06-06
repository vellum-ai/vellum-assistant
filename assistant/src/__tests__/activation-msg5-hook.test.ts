/**
 * Tests for the activation north-star (`activation_msg_5_sent`) emit hook.
 *
 * `maybeEmitActivationMsg5` runs after a real user turn is persisted. It fires
 * exactly once — on the 5th real user turn of a MARKED activation conversation —
 * and is a fire-and-forget no-op everywhere else.
 *
 * The test drives the real stores (`createConversation`, `addMessage`,
 * `markActivationSession`, `recordActivationEvent`) so it exercises the actual
 * `countRealUserTurns` filter and onboarding-event substrate end to end.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Activation events are gated on `collectUsageData`; keep it on for the test.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

import { maybeEmitActivationMsg5 } from "../daemon/conversation-messaging.js";
import {
  isActivationSession,
  markActivationSession,
} from "../memory/activation-session-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { queryUnreportedOnboardingEvents } from "../memory/onboarding-events-store.js";
import {
  activationSessions,
  messages,
  onboardingEvents,
} from "../memory/schema.js";

initializeDb();

function purge(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.delete(activationSessions).run();
  db.delete(onboardingEvents).run();
}

beforeEach(() => {
  purge();
});

/** Count the persisted `activation_msg_5_sent` rows for a session. */
function msg5RowsFor(sessionId: string): number {
  return queryUnreportedOnboardingEvents(0, undefined, 100).filter(
    (e) =>
      e.sessionId === sessionId &&
      e.stepName === "activation_msg_5_sent" &&
      e.stepIndex === 6,
  ).length;
}

/**
 * Persist one real user turn, then run the emit hook exactly as the persist
 * path does (hook fires after the turn is durable).
 */
async function persistTurnAndRunHook(
  conversationId: string,
  content: string,
): Promise<void> {
  await addMessage(conversationId, "user", content, { skipIndexing: true });
  maybeEmitActivationMsg5(conversationId);
}

describe("maybeEmitActivationMsg5", () => {
  test("emits exactly one event on the 5th real user turn of an activation conversation", async () => {
    const conv = createConversation({ conversationType: "standard" });
    markActivationSession(conv.id);
    expect(isActivationSession(conv.id)).toBe(true);

    for (let i = 1; i <= 4; i++) {
      await persistTurnAndRunHook(conv.id, `turn ${i}`);
      expect(msg5RowsFor(conv.id)).toBe(0); // turns 1–4: no row
    }

    await persistTurnAndRunHook(conv.id, "turn 5");
    expect(msg5RowsFor(conv.id)).toBe(1); // 5th real user turn fires
  });

  test("does not re-emit on turns 6+ (only the single row from turn 5)", async () => {
    const conv = createConversation({ conversationType: "standard" });
    markActivationSession(conv.id);

    for (let i = 1; i <= 8; i++) {
      await persistTurnAndRunHook(conv.id, `turn ${i}`);
    }

    expect(msg5RowsFor(conv.id)).toBe(1);
  });

  test("does nothing for a non-activation (unmarked) conversation", async () => {
    const conv = createConversation({ conversationType: "standard" });
    // Intentionally NOT marked as an activation session.

    for (let i = 1; i <= 8; i++) {
      await persistTurnAndRunHook(conv.id, `turn ${i}`);
    }

    expect(msg5RowsFor(conv.id)).toBe(0);
  });

  test("ignores tool_result role=user rows when counting to 5", async () => {
    const conv = createConversation({ conversationType: "standard" });
    markActivationSession(conv.id);

    // 4 real turns, with synthetic tool_result user rows interleaved. The
    // tool_result rows must not count toward the 5th-turn trigger.
    const db = getDb();
    for (let i = 1; i <= 4; i++) {
      await persistTurnAndRunHook(conv.id, `turn ${i}`);
      db.insert(messages)
        .values({
          id: `tool-result-${i}`,
          conversationId: conv.id,
          role: "user",
          content: JSON.stringify([
            { type: "tool_result", tool_use_id: `t${i}`, content: "" },
          ]),
          createdAt: Date.now() + i,
        })
        .run();
      maybeEmitActivationMsg5(conv.id);
    }
    expect(msg5RowsFor(conv.id)).toBe(0); // still only 4 real turns

    await persistTurnAndRunHook(conv.id, "turn 5");
    expect(msg5RowsFor(conv.id)).toBe(1); // 5th REAL turn fires
  });
});
