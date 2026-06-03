// End-to-end caller-wiring check for the incognito memory gate. The gate
// itself lives in `indexMessageNow` (see indexer-incognito.test.ts); this suite
// verifies that `addMessage` — the live user-message indexing path — resolves
// the conversation's incognito flag and threads it through, so an incognito
// conversation stores no memory segments while a normal one still does.
//
// DEFAULT_CONFIG is imported before the loader is mocked so defaults.ts
// evaluates against the real `applyNestedDefaults`; the mock then forces memory
// on for the indexing path (mirroring memory-upsert-concurrency.test.ts).

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../../config/defaults.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module("../../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { addMessage, createConversation } from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { memorySegments } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_graph_nodes");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_jobs");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

const SAMPLE_TEXT =
  "I prefer TypeScript over plain JavaScript for large projects and I live in Berlin.";

function segmentCount(conversationId: string): number {
  return getDb()
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.conversationId, conversationId))
    .all().length;
}

describe("addMessage incognito gate", () => {
  beforeEach(() => {
    resetTables();
  });

  test("an incognito conversation stores no memory segments", async () => {
    const { id } = createConversation({ incognito: true });
    await addMessage(id, "user", SAMPLE_TEXT);
    expect(segmentCount(id)).toBe(0);
  });

  test("a normal conversation still stores memory segments", async () => {
    const { id } = createConversation({ incognito: false });
    await addMessage(id, "user", SAMPLE_TEXT);
    expect(segmentCount(id)).toBeGreaterThan(0);
  });
});
