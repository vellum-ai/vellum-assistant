// clearAll() must drop the memory feature's bulk per-message index (the whole
// lexical Qdrant collection) — a "delete all" leaves no conversation ids to key
// per-conversation purges on, so the points would otherwise survive a
// "permanently delete everything" action. clearAll routes this through the
// `MemoryPersistenceHooks.onAllConversationsCleared` seam (persistence stays
// decoupled from the plugin); the memory plugin's impl calls
// `clearMessagesLexicalIndex`. This asserts the full chain fires.

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  await import("../plugins/defaults/memory/job-handlers/index-message-lexical.js");
let clearCalls = 0;
mock.module(
  "../plugins/defaults/memory/job-handlers/index-message-lexical.js",
  () => ({
    ...actualLexical,
    clearMessagesLexicalIndex: async () => {
      clearCalls += 1;
    },
  }),
);

import { clearAll } from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getMemoryPersistenceHooks,
  registerMemoryPersistenceHooks,
  resetMemoryPersistenceHooksForTests,
} from "../persistence/memory-lifecycle-hooks.js";
import { registerDefaultPluginPersistenceHooks } from "../plugins/defaults/index.js";

await initializeDb();

describe("clearAll bulk lexical index cleanup", () => {
  beforeEach(() => {
    clearCalls = 0;
    // Register the real memory persistence hooks so `onAllConversationsCleared`
    // routes to the plugin impl (which calls the spied clear helper).
    registerDefaultPluginPersistenceHooks();
  });

  test("clearAll fires onAllConversationsCleared, which clears the lexical index", async () => {
    await clearAll();
    expect(clearCalls).toBe(1);
  });

  test("clearAll is a safe no-op when the memory hooks are not registered", async () => {
    // Persistence must work with no memory present — the seam falls through to
    // its no-op and clearAll does not touch the lexical index.
    resetMemoryPersistenceHooksForTests();
    clearCalls = 0;
    await clearAll();
    expect(clearCalls).toBe(0);
    // Restore for any later test in the same process.
    registerMemoryPersistenceHooks(getMemoryPersistenceHooks());
  });
});
