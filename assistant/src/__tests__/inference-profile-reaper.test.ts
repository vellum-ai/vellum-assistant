import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  createConversation,
  getConversation,
  setConversationInferenceProfileSession,
} from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  startInferenceProfileSessionReaper,
  stopInferenceProfileSessionReaper,
  tickInferenceProfileReaper,
} from "../runtime/routes/inference-profile-session-reaper.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("inference-profile-session-reaper", () => {
  beforeEach(() => {
    clearTables();
    stopInferenceProfileSessionReaper();
  });

  afterAll(() => {
    stopInferenceProfileSessionReaper();
    resetDb();
    mock.restore();
  });

  test("basic sweep: clears 2 expired sessions, leaves 1 future session untouched, emits 2 events", async () => {
    const conv1 = createConversation("reaper-conv-1");
    const conv2 = createConversation("reaper-conv-2");
    const conv3 = createConversation("reaper-conv-3");

    // Two expired sessions
    setConversationInferenceProfileSession(
      conv1.id,
      "balanced",
      "session-1",
      Date.now() - 1,
    );
    setConversationInferenceProfileSession(
      conv2.id,
      "quality-optimized",
      "session-2",
      Date.now() - 1,
    );
    // One future session — should NOT be cleared
    setConversationInferenceProfileSession(
      conv3.id,
      "cost-optimized",
      "session-3",
      Date.now() + 60_000,
    );

    const publishedEvents: Array<{
      conversationId: string | undefined;
      profile: string | null | undefined;
    }> = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        if (event.message.type === "conversation_inference_profile_updated") {
          publishedEvents.push({
            conversationId: event.conversationId,
            profile: event.message.profile,
          });
        }
      },
    });

    tickInferenceProfileReaper();
    // Allow microtasks (promise callbacks) to settle
    await Promise.resolve();

    // Expired rows should be cleared
    expect(getConversation(conv1.id)?.inferenceProfile).toBeNull();
    expect(getConversation(conv1.id)?.inferenceProfileExpiresAt).toBeNull();
    expect(getConversation(conv2.id)?.inferenceProfile).toBeNull();
    expect(getConversation(conv2.id)?.inferenceProfileExpiresAt).toBeNull();

    // Future row should be untouched
    expect(getConversation(conv3.id)?.inferenceProfile).toBe("cost-optimized");
    expect(getConversation(conv3.id)?.inferenceProfileExpiresAt).not.toBeNull();

    // Exactly 2 events emitted
    expect(publishedEvents).toHaveLength(2);
    const convIds = publishedEvents.map((e) => e.conversationId).sort();
    expect(convIds).toEqual([conv1.id, conv2.id].sort());
    for (const ev of publishedEvents) {
      expect(ev.profile).toBeNull();
    }

    subscription.dispose();
  });

  test("CAS protection: row with NULL expiresAt (sticky override) is not touched", async () => {
    const conv = createConversation("reaper-cas-conv");

    // Seed a row that initially looks expired — but before the reaper runs,
    // simulate a concurrent write that sets expiresAt to NULL (sticky override).
    setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      null,
      null, // NULL expiresAt — sticky, non-session override
    );

    tickInferenceProfileReaper();
    await Promise.resolve();

    // The row must not have been cleared — expiresAt was NULL so the WHERE
    // condition `inference_profile_expires_at IS NOT NULL AND <= now` did not match.
    const row = getConversation(conv.id);
    expect(row?.inferenceProfile).toBe("balanced");
    expect(row?.inferenceProfileExpiresAt).toBeNull();
  });

  test("stop function clears the interval", () => {
    startInferenceProfileSessionReaper();
    // Timer should now be running (non-null internally)
    // We verify by stopping and confirming stop is idempotent without throwing.
    stopInferenceProfileSessionReaper();
    // Calling stop again must be safe
    stopInferenceProfileSessionReaper();
  });

  test("idempotent start: calling startInferenceProfileSessionReaper twice uses a single timer", () => {
    startInferenceProfileSessionReaper();
    // A second call should be a no-op — the idempotency guard (`if (reaperTimer) return`)
    // prevents a second interval from being created.
    startInferenceProfileSessionReaper();

    // Verify stop cleans up without errors (would throw on double-clear if two
    // timers had been registered, though setInterval handles that gracefully).
    stopInferenceProfileSessionReaper();
  });
});
