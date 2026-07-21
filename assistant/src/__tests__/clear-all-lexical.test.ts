// clearAll() must drop the memory feature's bulk per-message index (the whole
// lexical Qdrant collection) — a "delete all" leaves no conversation ids to key
// per-conversation purges on, so the points would otherwise survive a
// "permanently delete everything" action. clearAll calls
// `clearMessagesLexicalIndex` directly and AWAITS it. This asserts both.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Replace `clearMessagesLexicalIndex` while keeping the rest of the module
// REAL. `mock.module` is process-global and not undone by `mock.restore()`, so
// a partial mock that drops the other exports would leak into any later test
// file in the same process that imports them (e.g. the handler tests importing
// `indexMessageLexicalJob`). Spread the real module so only this one export is
// replaced. Importing the real module here is safe: its deps
// (`@qdrant/js-client-rest`, `uuid`, the local TF-IDF encoder) resolve in the
// worktree.
//
// The mock yields to the timer queue before completing so the await assertion
// below is meaningful: if clearAll fired the drop without awaiting it,
// `clearCalls` would still be 0 when clearAll resolves.
const actualLexical =
  await import("../persistence/job-handlers/message-lexical.js");
let clearCalls = 0;
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...actualLexical,
  clearMessagesLexicalIndex: async () => {
    await new Promise((r) => setTimeout(r, 10));
    clearCalls += 1;
  },
}));

import { clearAll } from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

describe("clearAll bulk lexical index cleanup", () => {
  beforeEach(() => {
    clearCalls = 0;
  });

  test("clearAll clears the lexical index and AWAITS the drop before returning", async () => {
    // The drop must complete before clearAll resolves — otherwise a write right
    // after clear-all could land in a collection that is about to be dropped.
    await clearAll();
    expect(clearCalls).toBe(1);
  });
});
