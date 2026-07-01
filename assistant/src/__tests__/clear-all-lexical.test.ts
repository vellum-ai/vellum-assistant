// clearAll() must drop the messages lexical (Qdrant) index inline — a bulk wipe
// leaves no conversation ids to key per-conversation purge jobs on, so the
// Qdrant points would otherwise survive a "permanently delete everything"
// action. This spies on the lexical clear helper to assert clearAll invokes it.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Spy on `clearMessagesLexicalIndex` (called by `clearAll`) while keeping the
// rest of the module REAL. `mock.module` is process-global and not undone by
// `mock.restore()`, so a partial mock that drops the other exports would leak
// into any later test file in the same process that imports them (e.g. the
// handler tests importing `indexMessageLexicalJob`). Spread the real module so
// only this one export is replaced. Importing the real module here is safe: its
// deps (`@qdrant/js-client-rest`, `uuid`, the local TF-IDF encoder) resolve in
// the worktree.
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

await initializeDb();

describe("clearAll lexical index cleanup", () => {
  beforeEach(() => {
    clearCalls = 0;
  });

  test("clearAll invokes clearMessagesLexicalIndex", async () => {
    await clearAll();
    expect(clearCalls).toBe(1);
  });
});
