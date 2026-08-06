/**
 * Conversation provenance is stated at creation.
 *
 * `createConversation` accepts the origin so the row is attributed from the
 * moment it exists, rather than being patched afterward by
 * `setConversationOriginChannelIfUnset` on the first inbound message. See
 * JARVIS-1466 for why the post-hoc path leaves the column in a third
 * "not yet attributed" state that different readers resolve in opposite
 * directions.
 *
 * The omitted-origin case is pinned deliberately: while call sites are being
 * migrated, omitting the argument has to behave exactly as it did before the
 * parameter existed, or migrating them stops being safe to do piecemeal.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  createConversation,
  getConversationOriginChannel,
  setConversationOriginChannelIfUnset,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";

await initializeDb();

/** The raw column, not the parsed accessor, so NULL stays distinguishable. */
function rawOriginChannel(id: string): string | null {
  const row = getDb()
    .all(`SELECT origin_channel FROM conversations WHERE id = '${id}'`)
    .at(0) as { origin_channel: string | null } | undefined;
  return row?.origin_channel ?? null;
}

beforeEach(() => {
  getDb().delete(conversations).run();
});

describe("stating the origin at creation", () => {
  test("stamps a native conversation", () => {
    const conv = createConversation({ title: "in-app", origin: "vellum" });

    expect(rawOriginChannel(conv.id)).toBe("vellum");
  });

  test("stamps an external channel", () => {
    const conv = createConversation({ title: "from-slack", origin: "slack" });

    expect(rawOriginChannel(conv.id)).toBe("slack");
  });

  test("a stamped row is attributed before any message arrives", () => {
    // The point of the change: the row is already correct, so nothing has to
    // run afterward to make it so.
    const conv = createConversation({ title: "from-slack", origin: "slack" });

    expect(getConversationOriginChannel(conv.id)).toBe("slack");
  });
});

describe("inheriting the origin from a parent", () => {
  test("a fork lands on its parent's channel", () => {
    const parent = createConversation({ title: "parent", origin: "telegram" });

    const fork = createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(rawOriginChannel(fork.id)).toBe("telegram");
  });

  test("inheriting from a native parent stays native", () => {
    const parent = createConversation({ title: "parent", origin: "vellum" });

    const fork = createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(rawOriginChannel(fork.id)).toBe("vellum");
  });

  test("an unreadable parent falls back to native rather than failing", () => {
    // Creation is on the inbound critical path: a slightly wrong origin is
    // recoverable, a thrown insert is not.
    const fork = createConversation({
      title: "orphan",
      origin: { inheritFrom: "no-such-conversation" },
    });

    expect(rawOriginChannel(fork.id)).toBe("vellum");
  });
});

describe("callers that have not been migrated yet", () => {
  test("omitting the origin leaves the column unset", () => {
    const conv = createConversation({ title: "unmigrated" });

    expect(rawOriginChannel(conv.id)).toBeNull();
  });

  test("attribution still claims an unstamped row", () => {
    const conv = createConversation({ title: "unmigrated" });

    setConversationOriginChannelIfUnset(conv.id, "slack");

    expect(rawOriginChannel(conv.id)).toBe("slack");
  });

  test("attribution does not overwrite an origin stated at creation", () => {
    // The `isNull` guard is what makes stamping and attribution able to
    // coexist during the migration: a row that already knows its origin is
    // never re-claimed by a later message.
    const conv = createConversation({ title: "from-slack", origin: "slack" });

    setConversationOriginChannelIfUnset(conv.id, "telegram");

    expect(rawOriginChannel(conv.id)).toBe("slack");
  });
});
