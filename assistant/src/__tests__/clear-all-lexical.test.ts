// clearAll() must drop the messages lexical (Qdrant) index inline — a bulk wipe
// leaves no conversation ids to key per-conversation purge jobs on, so the
// Qdrant points would otherwise survive a "permanently delete everything"
// action. This spies on the lexical clear helper to assert clearAll invokes it.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Spy on the lexical-index helpers `conversation-crud` calls. All exports of
// the module are stubbed so any importer in the graph resolves; only
// `clearMessagesLexicalIndex` is observed.
let clearCalls = 0;
mock.module(
  "../plugins/defaults/memory/job-handlers/index-message-lexical.js",
  () => ({
    indexMessageToLexical: async () => {},
    indexMessageLexicalJob: async () => {},
    purgeConversationLexicalJob: async () => {},
    deleteMessageLexicalJob: async () => {},
    enqueueLexicalIndexForMessage: () => {},
    enqueuePurgeConversationLexical: () => {},
    enqueueDeleteMessageLexical: () => {},
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
