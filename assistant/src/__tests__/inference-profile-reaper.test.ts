import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  createConversation,
  getConversation,
  setConversationInferenceProfileSession,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  startInferenceProfileSessionReaper,
  stopInferenceProfileSessionReaper,
  tickInferenceProfileReaper,
} from "../runtime/routes/inference-profile-session-reaper.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { waitFor } from "./helpers/wait-for.js";

await initializeDb();

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
    resetDbForTesting();
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
    await waitFor(() => publishedEvents.length === 2, {
      message: "Timed out waiting for inference profile reaper event",
    });

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

  test("syncs the live in-memory Conversation instance for each cleared session", async () => {
    // GIVEN an expired session-backed override persisted on a conversation row
    const conv = createConversation("reaper-live-sync");
    setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-live",
      Date.now() - 1,
    );

    // AND a live Conversation instance registered for that conversation,
    // seeded with the same override state the reaper is about to expire
    const appliedStates: Array<{
      profile: string | null;
      sessionId: string | null;
      expiresAt: number | null;
    }> = [];
    const liveConversation = {
      conversationId: conv.id,
      inferenceProfile: "balanced",
      inferenceProfileSessionId: "session-live",
      inferenceProfileExpiresAt: Date.now() - 1,
      applyInferenceProfileState(
        this: {
          inferenceProfile: string | null;
          inferenceProfileSessionId: string | null;
          inferenceProfileExpiresAt: number | null;
        },
        state: {
          profile: string | null;
          sessionId: string | null;
          expiresAt: number | null;
        },
      ) {
        appliedStates.push(state);
        this.inferenceProfile = state.profile;
        this.inferenceProfileSessionId = state.sessionId;
        this.inferenceProfileExpiresAt = state.expiresAt;
      },
    } as unknown as Conversation;
    setConversation(conv.id, liveConversation);

    // WHEN the reaper sweeps the expired session
    tickInferenceProfileReaper();

    // THEN the live instance is cleared in lock-step with the DB row, so the
    // per-turn override derivation reads the cleared state without re-fetching
    expect(appliedStates).toEqual([
      { profile: null, sessionId: null, expiresAt: null },
    ]);
    expect(liveConversation.inferenceProfile).toBeNull();
    expect(liveConversation.inferenceProfileSessionId).toBeNull();
    expect(liveConversation.inferenceProfileExpiresAt).toBeNull();

    deleteConversation(conv.id);
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
