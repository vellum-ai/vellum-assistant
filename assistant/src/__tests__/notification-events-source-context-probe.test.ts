/**
 * Tests for `hasEventForSourceContextSince`, the probe the schedule-result
 * producer uses to ask "did this run already notify?".
 *
 * The `since` bound is the part worth pinning down. A recurring schedule with
 * `reuseConversation` runs every firing in the same conversation, so an
 * unbounded probe would find run #1's notification forever and silence every
 * run after it — reintroducing the invisibility the producer exists to fix.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  createEvent,
  hasEventForSourceContextSince,
} from "../notifications/events-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { notificationEvents } from "../persistence/schema/index.js";

await initializeDb();

const CONVERSATION_ID = "conv-schedule-run";

beforeEach(() => {
  getDb().delete(notificationEvents).run();
});

/**
 * Seed an event and backdate it: `createEvent` stamps `Date.now()`, but these
 * cases turn entirely on where a row sits relative to a run's start.
 */
function seedEventAt(sourceContextId: string, createdAt: number): void {
  const id = crypto.randomUUID();
  createEvent({
    id,
    sourceEventName: "assistant.share",
    sourceChannel: "assistant_tool",
    sourceContextId,
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    payload: { requestedMessage: "sent by the run itself" },
  });
  getDb()
    .update(notificationEvents)
    .set({ createdAt })
    .where(eq(notificationEvents.id, id))
    .run();
}

describe("hasEventForSourceContextSince", () => {
  test("finds an event emitted during the run", () => {
    const runStartedAt = 1_700_000_000_000;
    seedEventAt(CONVERSATION_ID, runStartedAt + 500);

    expect(hasEventForSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
      true,
    );
  });

  test("ignores an event from a prior run in the same conversation", () => {
    // The reused-conversation case: yesterday's firing notified, today's did
    // not. Today's run still owes the user a notification.
    const yesterday = 1_700_000_000_000;
    const todaysRunStartedAt = yesterday + 86_400_000;
    seedEventAt(CONVERSATION_ID, yesterday + 500);

    expect(
      hasEventForSourceContextSince(CONVERSATION_ID, todaysRunStartedAt),
    ).toBe(false);
  });

  test("counts an event landing exactly at the run's start", () => {
    // The bound is inclusive: a notification stamped in the same millisecond
    // the run began belongs to that run.
    const runStartedAt = 1_700_000_000_000;
    seedEventAt(CONVERSATION_ID, runStartedAt);

    expect(hasEventForSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
      true,
    );
  });

  test("ignores an event from a different conversation", () => {
    const runStartedAt = 1_700_000_000_000;
    seedEventAt("some-other-conversation", runStartedAt + 500);

    expect(hasEventForSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
      false,
    );
  });

  test("returns false when nothing was ever emitted", () => {
    expect(
      hasEventForSourceContextSince(CONVERSATION_ID, 1_700_000_000_000),
    ).toBe(false);
  });
});
