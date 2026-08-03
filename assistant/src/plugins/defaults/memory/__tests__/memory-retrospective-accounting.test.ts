import { beforeEach, describe, expect, test } from "bun:test";

import {
  createConversation,
  type MessageRow,
} from "../../../../persistence/conversation-crud.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { messages } from "../../../../persistence/schema/index.js";
import {
  hasQualifyingUserMessageAfter,
  messagesHaveUserActivity,
} from "../memory-retrospective-accounting.js";

await initializeDb();

const CONV = "conv-accounting";

const TEXT = JSON.stringify([{ type: "text", text: "hello" }]);
const TOOL_RESULT_ONLY = JSON.stringify([
  { type: "tool_result", tool_use_id: "t1", content: "ok" },
]);
const MIXED = JSON.stringify([
  { type: "tool_result", tool_use_id: "t1", content: "ok" },
  { type: "text", text: "note" },
]);

let seq = 0;
function insertRaw(opts: {
  role: string;
  content: string;
  createdAt: number;
  id?: string;
}): string {
  const id = opts.id ?? `msg-${String(++seq).padStart(4, "0")}`;
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId: CONV,
      role: opts.role,
      content: opts.content,
      createdAt: opts.createdAt,
      metadata: null,
    })
    .run();
  return id;
}

describe("hasQualifyingUserMessageAfter", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
    createConversation({ id: CONV });
  });

  test("assistant-only tail does not qualify", () => {
    insertRaw({ role: "assistant", content: TEXT, createdAt: 1_000 });
    insertRaw({ role: "assistant", content: TEXT, createdAt: 2_000 });

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(false);
  });

  test("tool_result-only user rows do not qualify", () => {
    insertRaw({ role: "assistant", content: TEXT, createdAt: 1_000 });
    insertRaw({ role: "user", content: TOOL_RESULT_ONLY, createdAt: 2_000 });

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(false);
  });

  test("a user text row qualifies", () => {
    insertRaw({ role: "user", content: TEXT, createdAt: 1_000 });

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(true);
  });

  test("a mixed tool_result + text user row qualifies", () => {
    insertRaw({ role: "user", content: MIXED, createdAt: 1_000 });

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(true);
  });

  test("non-array user content qualifies (fails toward running)", () => {
    // File-backed rows persist a `{ ref }` object; legacy rows persist a
    // bare string. Neither shape can prove the row is a tool-result carrier.
    insertRaw({
      role: "user",
      content: JSON.stringify({ ref: "deltas/abc" }),
      createdAt: 1_000,
    });
    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(true);

    getDb().run(`DELETE FROM messages`);
    insertRaw({ role: "user", content: "plain legacy text", createdAt: 1_000 });
    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(true);
  });

  test("an empty content array does not qualify", () => {
    insertRaw({ role: "user", content: "[]", createdAt: 1_000 });

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(false);
  });

  test("only rows after the cursor count", () => {
    const cursor = insertRaw({ role: "user", content: TEXT, createdAt: 1_000 });
    insertRaw({ role: "assistant", content: TEXT, createdAt: 2_000 });

    expect(hasQualifyingUserMessageAfter(CONV, cursor)).toBe(false);

    insertRaw({ role: "user", content: TEXT, createdAt: 3_000 });
    expect(hasQualifyingUserMessageAfter(CONV, cursor)).toBe(true);
  });

  test("the empty-string sentinel scans the whole conversation", () => {
    insertRaw({ role: "user", content: TEXT, createdAt: 1_000 });

    expect(hasQualifyingUserMessageAfter(CONV, "")).toBe(true);
  });

  test("a vanished cursor reference means no new work", () => {
    insertRaw({ role: "user", content: TEXT, createdAt: 1_000 });

    expect(hasQualifyingUserMessageAfter(CONV, "msg-gone")).toBe(false);
  });

  test("rows sharing the cursor's timestamp are split by the id tie-break", () => {
    insertRaw({
      role: "user",
      content: TEXT,
      createdAt: 1_000,
      id: "msg-before",
    });
    insertRaw({
      role: "user",
      content: TOOL_RESULT_ONLY,
      createdAt: 1_000,
      id: "msg-cursor",
    });
    expect(hasQualifyingUserMessageAfter(CONV, "msg-cursor")).toBe(false);

    insertRaw({
      role: "user",
      content: TEXT,
      createdAt: 1_000,
      id: "msg-later",
    });
    expect(hasQualifyingUserMessageAfter(CONV, "msg-cursor")).toBe(true);
  });
});

describe("messagesHaveUserActivity", () => {
  function row(
    role: string,
    content: Array<Record<string, unknown>>,
  ): Pick<MessageRow, "role" | "content"> {
    return { role, content } as unknown as Pick<MessageRow, "role" | "content">;
  }

  test("a user text row counts as user activity", () => {
    expect(
      messagesHaveUserActivity([
        row("assistant", [{ type: "text", text: "recap" }]),
        row("user", [{ type: "text", text: "hey" }]),
      ]),
    ).toBe(true);
  });

  test("tool_result-only user rows do not count", () => {
    expect(
      messagesHaveUserActivity([
        row("assistant", [{ type: "text", text: "recap" }]),
        row("user", [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ]),
      ]),
    ).toBe(false);
  });

  test("a mixed tool_result + text user row counts", () => {
    expect(
      messagesHaveUserActivity([
        row("user", [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "note" },
        ]),
      ]),
    ).toBe(true);
  });

  test("assistant rows never count, and an empty slice has no activity", () => {
    expect(
      messagesHaveUserActivity([
        row("assistant", [{ type: "text", text: "hello" }]),
      ]),
    ).toBe(false);
    expect(messagesHaveUserActivity([])).toBe(false);
  });
});
