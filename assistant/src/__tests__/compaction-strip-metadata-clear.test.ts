import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  addMessage,
  clearStrippedInjectionMetadataForConversation,
  createConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("clearStrippedInjectionMetadataForConversation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("removes all three stripped-block fields and preserves the rest", async () => {
    const conv = createConversation("Strip metadata test");
    await addMessage(
      conv.id,
      "user",
      "turn 1",
      {
        memoryInjectedBlock: "mem payload",
        turnContextBlock: "<turn_context>\nctx\n</turn_context>",
        workspaceBlock: "<workspace>\nws\n</workspace>",
        nowScratchpadBlock:
          "<NOW.md Always keep this up to date>\nnow body\n</NOW.md>",
        pkbContextBlock: "<knowledge_base>\npkb body\n</knowledge_base>",
        pkbSystemReminderBlock:
          "<system_reminder>\nreminder body\n</system_reminder>",
      },
      { skipIndexing: true },
    );

    clearStrippedInjectionMetadataForConversation(conv.id);

    const [row] = getMessages(conv.id);
    const meta = JSON.parse(row.metadata ?? "{}");

    expect(meta.pkbSystemReminderBlock).toBeUndefined();
    expect(meta.nowScratchpadBlock).toBeUndefined();
    expect(meta.pkbContextBlock).toBeUndefined();

    // Non-stripped fields must survive — these back blocks that
    // `stripInjectionsForCompaction` intentionally leaves in-memory.
    expect(meta.memoryInjectedBlock).toBe("mem payload");
    expect(meta.turnContextBlock).toBe("<turn_context>\nctx\n</turn_context>");
    expect(meta.workspaceBlock).toBe("<workspace>\nws\n</workspace>");
  });

  test("is idempotent — re-running is a no-op on already-cleared rows", async () => {
    const conv = createConversation("Idempotent clear");
    await addMessage(
      conv.id,
      "user",
      "turn 1",
      {
        memoryInjectedBlock: "keep me",
        nowScratchpadBlock: "<NOW.md …>body</NOW.md>",
      },
      { skipIndexing: true },
    );

    clearStrippedInjectionMetadataForConversation(conv.id);
    clearStrippedInjectionMetadataForConversation(conv.id);

    const [row] = getMessages(conv.id);
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.nowScratchpadBlock).toBeUndefined();
    expect(meta.memoryInjectedBlock).toBe("keep me");
  });

  test("only targets user rows — assistant metadata is untouched", async () => {
    const conv = createConversation("Role scoping");
    await addMessage(
      conv.id,
      "user",
      "turn 1",
      { nowScratchpadBlock: "<NOW.md …>body</NOW.md>" },
      { skipIndexing: true },
    );
    await addMessage(
      conv.id,
      "assistant",
      "reply",
      // Assistant rows don't carry these blocks in practice, but guard the
      // role filter anyway so an accidental drop of the WHERE clause is
      // surfaced immediately.
      { nowScratchpadBlock: "should-not-be-cleared" },
      { skipIndexing: true },
    );

    clearStrippedInjectionMetadataForConversation(conv.id);

    const rows = getMessages(conv.id);
    const userMeta = JSON.parse(rows[0].metadata ?? "{}");
    const assistantMeta = JSON.parse(rows[1].metadata ?? "{}");
    expect(userMeta.nowScratchpadBlock).toBeUndefined();
    expect(assistantMeta.nowScratchpadBlock).toBe("should-not-be-cleared");
  });

  test("post-clear, rehydration does not re-inject NOW.md / knowledge_base", async () => {
    // Reproduces the divergence described in the Codex P1 feedback:
    // stripInjectionsForCompaction removes <NOW.md …> and <knowledge_base>
    // from the in-memory history during compaction. Without this clear,
    // a subsequent loadFromDb would rehydrate those blocks from stale
    // metadata — re-injecting exactly what compaction removed.
    const conv = createConversation("Rehydrate after strip");
    await addMessage(
      conv.id,
      "user",
      "historical turn",
      {
        memoryInjectedBlock: "mem",
        turnContextBlock: "<turn_context>\nctx\n</turn_context>",
        workspaceBlock: "<workspace>\nws\n</workspace>",
        nowScratchpadBlock:
          "<NOW.md Always keep this up to date>\nnow\n</NOW.md>",
        pkbContextBlock: "<knowledge_base>\npkb\n</knowledge_base>",
        pkbSystemReminderBlock: "<system_reminder>\nsr\n</system_reminder>",
      },
      { skipIndexing: true },
    );
    await addMessage(conv.id, "assistant", "reply", undefined, {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", "tail turn", undefined, {
      skipIndexing: true,
    });

    // Simulate the compaction-strip lifecycle point.
    clearStrippedInjectionMetadataForConversation(conv.id);

    const rows = getMessages(conv.id);
    const historicalMeta = JSON.parse(rows[0].metadata ?? "{}");

    // Loading this back with loadFromDb prepends fields only when they
    // are present on the row. Confirm the stripped fields are gone so
    // rehydration cannot resurrect them.
    expect(historicalMeta.nowScratchpadBlock).toBeUndefined();
    expect(historicalMeta.pkbContextBlock).toBeUndefined();
    expect(historicalMeta.pkbSystemReminderBlock).toBeUndefined();

    // And the fields that back blocks `stripInjectionsForCompaction`
    // intentionally preserves (<turn_context>, <workspace>, <memory __injected>)
    // must still be present so the cache prefix remains stable.
    expect(historicalMeta.turnContextBlock).toBe(
      "<turn_context>\nctx\n</turn_context>",
    );
    expect(historicalMeta.workspaceBlock).toBe("<workspace>\nws\n</workspace>");
    expect(historicalMeta.memoryInjectedBlock).toBe("mem");
  });
});
