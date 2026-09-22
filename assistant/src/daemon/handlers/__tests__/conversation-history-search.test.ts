/**
 * Tests for the `includeArchived` option on the agent-facing conversation
 * history search.
 *
 * The `"*"` wildcard takes its own branch (FTS reads `*` as a literal), so it
 * has to honor the option through the list read rather than through
 * `searchConversations`, which has its own coverage in
 * `persistence/__tests__/conversation-queries-search.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { rawRun } from "../../../persistence/raw-query.js";
import { conversations } from "../../../persistence/schema/index.js";
import { performConversationSearch } from "../conversation-history.js";

await initializeDb();

function seedArchived(title: string): string {
  const conv = createConversation({ title });
  rawRun(
    "test:archiveConversation",
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    Date.now(),
    conv.id,
  );
  return conv.id;
}

describe("performConversationSearch · wildcard listing", () => {
  beforeEach(() => {
    getDb().delete(conversations).run();
  });

  test("omits archived conversations by default", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const results = await performConversationSearch({ query: "*" });

    expect(results.map((r) => r.conversationTitle)).toEqual(["live-1"]);
  });

  test("includeArchived reaches archived conversations", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const results = await performConversationSearch({
      query: "*",
      includeArchived: true,
    });

    expect(results.map((r) => r.conversationTitle).sort()).toEqual([
      "archived-1",
      "live-1",
    ]);
  });
});
