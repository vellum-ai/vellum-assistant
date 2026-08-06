/**
 * Filtering the conversation list by origin channel.
 *
 * "Native" has two spellings in the column and both are live: inserts leave
 * `origin_channel` NULL, and migration 288 rewrites NULL to `"vellum"` only
 * at daemon startup. So every conversation created while the daemon runs is
 * NULL until the next boot, and the native filter has to match both or the
 * sidebar's Chats section silently loses its newest rows.
 *
 * The over-matching cases below are as load-bearing as the rest: a reader
 * that accepts NULL for every channel would file unstamped conversations
 * into Slack's section too.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawRun } from "../persistence/raw-query.js";
import { conversations } from "../persistence/schema/index.js";

await initializeDb();

/**
 * A conversation as `createConversation` actually writes one: no
 * `origin_channel`. Migration 288 already ran during `initializeDb`, so this
 * row stays NULL exactly as it would in a running daemon.
 */
function seedUnstamped(title: string) {
  return createConversation({ title });
}

function seedStamped(title: string, channel: string) {
  const conv = createConversation({ title });
  rawRun(
    "test:stampOriginChannel",
    "UPDATE conversations SET origin_channel = ? WHERE id = ?",
    channel,
    conv.id,
  );
  return conv;
}

function titlesForChannel(originChannel: string): string[] {
  return listConversations({ limit: 100, originChannel }).map(
    (c) => c.title ?? "",
  );
}

beforeEach(() => {
  getDb().delete(conversations).run();
});

describe("the native channel filter", () => {
  test("returns a conversation created since the last daemon boot", () => {
    seedUnstamped("created-just-now");

    expect(titlesForChannel("vellum")).toEqual(["created-just-now"]);
  });

  test("returns a conversation migration 288 already normalized", () => {
    seedStamped("normalized-at-boot", "vellum");

    expect(titlesForChannel("vellum")).toEqual(["normalized-at-boot"]);
  });

  test("returns both spellings together, without duplicating either", () => {
    seedStamped("normalized-at-boot", "vellum");
    seedUnstamped("created-just-now");

    expect(titlesForChannel("vellum").sort()).toEqual([
      "created-just-now",
      "normalized-at-boot",
    ]);
  });

  test("excludes conversations that arrived over an external channel", () => {
    seedStamped("from-slack", "slack");
    seedUnstamped("created-just-now");

    expect(titlesForChannel("vellum")).toEqual(["created-just-now"]);
  });
});

describe("an external channel filter", () => {
  test("returns only its own conversations", () => {
    seedStamped("from-slack", "slack");
    seedStamped("from-email", "email");

    expect(titlesForChannel("slack")).toEqual(["from-slack"]);
  });

  test("does not claim unstamped conversations", () => {
    // The native branch must be reachable only for the native channel.
    // Accepting NULL unconditionally would put every in-app conversation
    // into every channel's section at once.
    seedUnstamped("created-just-now");

    expect(titlesForChannel("slack")).toEqual([]);
  });
});
