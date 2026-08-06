/**
 * Round-trip tests for `stampTurnOutcome` + `readTurnFailure`.
 *
 * `readTurnFailure` is the single reader of the turn-outcome stamp that
 * non-interactive callers (the scheduler's execute mode) use to tell a
 * genuinely failed turn from a normal reply — a failed LLM call ends the turn
 * without throwing, so the stamped metadata is the only signal. These tests
 * pin that the reader reflects exactly what the stamp wrote, with no parallel
 * copy of the outcome.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  readTurnFailure,
  stampTurnOutcome,
} from "../telemetry/turn-outcome.js";

await initializeDb();

function purge(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

beforeEach(() => {
  purge();
});

describe("readTurnFailure", () => {
  test("returns the failure with its code after a failed stamp", async () => {
    const conv = createConversation({ conversationType: "scheduled" });
    const msg = await addMessage(conv.id, "user", "run the job");

    stampTurnOutcome(msg.id, "failed", { failureCode: "provider_error" });

    expect(readTurnFailure(msg.id)).toEqual({ failureCode: "provider_error" });
  });

  test("returns an empty failure when a failed turn carried no code", async () => {
    const conv = createConversation({ conversationType: "scheduled" });
    const msg = await addMessage(conv.id, "user", "run the job");

    stampTurnOutcome(msg.id, "failed");

    expect(readTurnFailure(msg.id)).toEqual({});
  });

  test("returns null for a normally-replied turn (no stamp)", async () => {
    const conv = createConversation({ conversationType: "scheduled" });
    const msg = await addMessage(conv.id, "user", "run the job");

    expect(readTurnFailure(msg.id)).toBeNull();
  });

  test("returns null for a cancelled turn (not a failure)", async () => {
    const conv = createConversation({ conversationType: "scheduled" });
    const msg = await addMessage(conv.id, "user", "run the job");

    stampTurnOutcome(msg.id, "cancelled");

    expect(readTurnFailure(msg.id)).toBeNull();
  });

  test("returns null for an unknown message id", () => {
    expect(readTurnFailure("does-not-exist")).toBeNull();
  });
});
