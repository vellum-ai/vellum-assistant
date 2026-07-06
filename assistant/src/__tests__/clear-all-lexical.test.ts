// clearAll() must drop the memory feature's bulk per-message index (the whole
// lexical Qdrant collection) — a "delete all" leaves no conversation ids to key
// per-conversation purges on, so the points would otherwise survive a
// "permanently delete everything" action. clearAll routes this through the
// `MemoryPersistenceHooks.onAllConversationsCleared` seam (persistence stays
// decoupled from the plugin); the memory plugin's impl calls
// `clearMessagesLexicalIndex`. This asserts the full chain fires.

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Spy on `clearMessagesLexicalIndex` (the plugin's `onAllConversationsCleared`
// impl calls it) while keeping the rest of the module REAL. `mock.module` is
// process-global and not undone by `mock.restore()`, so a partial mock that
// drops the other exports would leak into any later test file in the same
// process that imports them (e.g. the handler tests importing
// `indexMessageLexicalJob`). Spread the real module so only this one export is
// replaced. Importing the real module here is safe: its deps
// (`@qdrant/js-client-rest`, `uuid`, the local TF-IDF encoder) resolve in the
// worktree.
const actualLexical =
  await import("../persistence/job-handlers/message-lexical.js");
let clearCalls = 0;
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...actualLexical,
  clearMessagesLexicalIndex: async () => {
    clearCalls += 1;
  },
}));

import { clearAll } from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import { memoryPersistenceHooks } from "../plugins/defaults/memory/persistence-hooks.js";

await initializeDb();

describe("clearAll bulk lexical index cleanup", () => {
  beforeEach(() => {
    clearCalls = 0;
  });

  test("clearAll fires onAllConversationsCleared, which clears the lexical index", async () => {
    await clearAll();
    expect(clearCalls).toBe(1);
  });

  test("clearAll AWAITS the collection drop before returning", async () => {
    // The drop must complete before clearAll resolves — otherwise a write right
    // after clear-all could land in a collection that is about to be dropped.
    // Register a hook whose drop yields to the microtask queue before finishing;
    // if clearAll did not await, `dropCompleted` would still be false here.
    let dropCompleted = false;
    const dropSpy = spyOn(
      memoryPersistenceHooks,
      "onAllConversationsCleared",
    ).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      dropCompleted = true;
    });

    try {
      await clearAll();
      expect(dropCompleted).toBe(true);
    } finally {
      dropSpy.mockRestore();
    }
  });
});
