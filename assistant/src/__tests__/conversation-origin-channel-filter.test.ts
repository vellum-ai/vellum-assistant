import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigration } from "../persistence/conversation-group-migration.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();
ensureGroupMigration();

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * `originChannel` is what lets each sidebar channel card fetch its own rows,
 * and what lets the Chats card ask for the ones no channel claimed.
 *
 * The asymmetry under test: `origin_channel` is deliberately NULL at insert so
 * an inbound message can claim the conversation for its channel, and migration
 * 288 settles the unclaimed ones to 'vellum' at daemon startup. So NULL means
 * "not yet attributed", and between one boot and the next it is what most rows
 * carry. Reading `vellum` strictly would leave every one of them in no section
 * at all: not native, not any channel.
 */
describe("listConversations originChannel filter", () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run("DELETE FROM conversations");
  });

  /** Set `origin_channel` directly; `createConversation` leaves it unset. */
  function stamp(id: string, originChannel: string | null): void {
    getRawDb().run("UPDATE conversations SET origin_channel = ? WHERE id = ?", [
      originChannel,
      id,
    ]);
  }

  function listedIds(originChannel: string): string[] {
    return listConversations({ originChannel } as Parameters<
      typeof listConversations
    >[0]).map((c) => c.id);
  }

  test("vellum matches rows that were never attributed", () => {
    createConversation({ id: "conv-unattributed", source: "user" });
    stamp("conv-unattributed", null);

    expect(listedIds("vellum")).toEqual(["conv-unattributed"]);
  });

  test("vellum matches rows explicitly stamped vellum", () => {
    createConversation({ id: "conv-native", source: "user" });
    stamp("conv-native", "vellum");

    expect(listedIds("vellum")).toEqual(["conv-native"]);
  });

  /* The whole point: an unattributed row and a stamped native row are the same
     section. Asserting both are returned together, rather than each alone,
     is what fails if the predicate goes back to a strict equality. */
  test("vellum returns unattributed and stamped rows together", () => {
    createConversation({ id: "conv-native", source: "user" });
    stamp("conv-native", "vellum");
    createConversation({ id: "conv-unattributed", source: "user" });
    stamp("conv-unattributed", null);

    expect(listedIds("vellum").sort()).toEqual([
      "conv-native",
      "conv-unattributed",
    ]);
  });

  test("vellum does not claim a row belonging to a channel", () => {
    createConversation({ id: "conv-slack", source: "user" });
    stamp("conv-slack", "slack");

    expect(listedIds("vellum")).toEqual([]);
  });

  /* Only `vellum` is tolerant. A row is claimed for a channel by that channel
     alone, so there is no ambiguity for the others to absorb - and a tolerant
     `slack` would pull every unattributed row into the Slack card. */
  test("a channel matches exactly and never absorbs unattributed rows", () => {
    createConversation({ id: "conv-slack", source: "user" });
    stamp("conv-slack", "slack");
    createConversation({ id: "conv-unattributed", source: "user" });
    stamp("conv-unattributed", null);

    expect(listedIds("slack")).toEqual(["conv-slack"]);
  });
});
