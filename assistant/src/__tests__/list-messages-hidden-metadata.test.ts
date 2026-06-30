/**
 * Tests for handleListMessages metadata.hidden filtering.
 *
 * Messages persisted with `metadata: { hidden: true }` (e.g. internal
 * scaffolding like retrospective instructions) must be omitted from the
 * UI history list while remaining visible to the LLM-side history loader.
 */

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
  }),
}));

import {
  _setPaginationScanCapForTesting,
  addMessage,
  createConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages } from "../persistence/schema/index.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface MessagePayload {
  role: string;
  textSegments?: string[];
}

/** Flatten a payload's text segments to plain text for content assertions. */
function plainText(message: MessagePayload): string {
  return (message.textSegments ?? []).join("");
}

describe("handleListMessages metadata.hidden filtering", () => {
  beforeEach(resetTables);

  test("UI serializer omits hidden messages but LLM-side getMessages includes them", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "first visible" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "internal scaffolding" }]),
      { metadata: { hidden: true } },
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "second visible" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
    expect(plainText(body.messages[0])).toBe("first visible");
    expect(plainText(body.messages[1])).toBe("second visible");
    expect(
      body.messages.some((m) => plainText(m).includes("internal scaffolding")),
    ).toBe(false);

    // LLM-side loader must include the hidden row so agent context is intact.
    const llmRows = getMessages(conv.id);
    expect(llmRows).toHaveLength(3);
    expect(llmRows[1].metadata).toContain('"hidden":true');
  });

  test("UI serializer omits system rows but LLM-side getMessages includes them", async () => {
    // GIVEN a conversation with a system row sandwiched between two
    // renderable turns (e.g. a skill-authored context message)
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "first visible" }]),
    );
    await addMessage(
      conv.id,
      "system",
      JSON.stringify([{ type: "text", text: "system scaffolding" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "second visible" }]),
    );

    // WHEN the UI history list is serialized
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN only the user/assistant turns are returned, never the system row
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(
      body.messages.some((m) => plainText(m).includes("system scaffolding")),
    ).toBe(false);

    // AND the LLM-side loader still includes the system row for agent context
    const llmRows = getMessages(conv.id);
    expect(llmRows).toHaveLength(3);
    expect(llmRows[1].role).toBe("system");
  });

  test("messages without metadata or with hidden=false are returned", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "no metadata" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "hidden false" }]),
      { metadata: { hidden: false } },
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(2);
  });

  test("pagination skips hidden rows so hasMore and oldest cursor reflect visible rows", async () => {
    const conv = createConversation();
    // 4 visible older rows, then a block of 3 hidden rows, then 2 visible newer.
    // With limit=2 and page=latest we should get the 2 newest visible rows,
    // hasMore=true (older visible rows exist), and a cursor pointing at the
    // oldest visible row in the page rather than null.
    for (let i = 0; i < 4; i++) {
      await addMessage(
        conv.id,
        "user",
        JSON.stringify([{ type: "text", text: `old visible ${i}` }]),
      );
    }
    for (let i = 0; i < 3; i++) {
      await addMessage(
        conv.id,
        "assistant",
        JSON.stringify([{ type: "text", text: `hidden ${i}` }]),
        { metadata: { hidden: true } },
      );
    }
    for (let i = 0; i < 2; i++) {
      await addMessage(
        conv.id,
        "user",
        JSON.stringify([{ type: "text", text: `new visible ${i}` }]),
      );
    }

    const latest = handleListMessages({
      queryParams: { conversationId: conv.id, page: "latest", limit: "2" },
    }) as {
      messages: MessagePayload[];
      hasMore: boolean;
      oldestTimestamp: number | null;
      oldestMessageId: string | null;
    };

    expect(latest.messages.map(plainText)).toEqual([
      "new visible 0",
      "new visible 1",
    ]);
    expect(latest.hasMore).toBe(true);
    expect(latest.oldestTimestamp).not.toBeNull();
    expect(latest.oldestMessageId).not.toBeNull();

    // Older page request — anchored before the latest page's oldest row —
    // should skip the hidden block entirely and return the next 2 visible rows.
    const older = handleListMessages({
      queryParams: {
        conversationId: conv.id,
        beforeTimestamp: String(latest.oldestTimestamp),
        limit: "2",
      },
    }) as {
      messages: MessagePayload[];
      hasMore: boolean;
    };

    expect(older.messages.map(plainText)).toEqual([
      "old visible 2",
      "old visible 3",
    ]);
    expect(older.hasMore).toBe(true);
  });

  test("pagination keeps hasMore + a cursor when a >cap hidden block truncates the scan", () => {
    // Exercise cap-truncation with a small cap + a few hundred rows rather than
    // >10k: the large seed made the post-test resetTables DELETE slow enough to
    // time out the next test's beforeEach under parallel CI load.
    // SCAN_CAP must span a couple of PAGINATION_CHUNK_MIN (50) chunks so the cap
    // (not DB exhaustion) stops the loop, and HIDDEN_COUNT sits just past it so
    // the newest cap-worth of rows are all hidden.
    const SCAN_CAP = 100;
    _setPaginationScanCapForTesting(SCAN_CAP);
    try {
      const conv = createConversation();
      const db = getDb();
      const HIDDEN_COUNT = SCAN_CAP + 20; // > scan cap
      const VISIBLE_COUNT = 2;
      let createdAt = 0;
      // Older visible rows first (lowest createdAt), then the hidden block.
      db.transaction((tx) => {
        for (let i = 0; i < VISIBLE_COUNT; i++) {
          createdAt += 1;
          tx.insert(messages)
            .values({
              id: `visible-${i}`,
              conversationId: conv.id,
              role: "user",
              content: JSON.stringify([{ type: "text", text: `visible ${i}` }]),
              createdAt,
            })
            .run();
        }
        for (let i = 0; i < HIDDEN_COUNT; i++) {
          createdAt += 1;
          tx.insert(messages)
            .values({
              id: `hidden-${i}`,
              conversationId: conv.id,
              role: "assistant",
              content: JSON.stringify([{ type: "text", text: `hidden ${i}` }]),
              createdAt,
              metadata: JSON.stringify({ hidden: true }),
            })
            .run();
        }
      });

      const latest = handleListMessages({
        queryParams: { conversationId: conv.id, page: "latest", limit: "2" },
      }) as {
        messages: MessagePayload[];
        hasMore: boolean;
        oldestTimestamp: number | null;
      };

      // Page is empty (the cap was consumed entirely by hidden rows) but the
      // client must still be told to keep paginating and given a cursor.
      expect(latest.messages).toHaveLength(0);
      expect(latest.hasMore).toBe(true);
      expect(latest.oldestTimestamp).not.toBeNull();

      // Resuming from the surfaced cursor drains the remaining hidden rows and
      // surfaces the visible ones below the cap.
      const older = handleListMessages({
        queryParams: {
          conversationId: conv.id,
          beforeTimestamp: String(latest.oldestTimestamp),
          limit: "2",
        },
      }) as { messages: MessagePayload[]; hasMore: boolean };

      expect(older.messages.map(plainText)).toEqual(["visible 0", "visible 1"]);
      expect(older.hasMore).toBe(false);
    } finally {
      _setPaginationScanCapForTesting(undefined);
    }
  });

  test("pagination drains DB when every row in a page is hidden", async () => {
    const conv = createConversation();
    // 5 hidden rows then 2 visible older rows. With limit=2, the naive
    // implementation fetches 3 newest (all hidden), filters to 0 visible, and
    // returns hasMore=true with no cursor. We expect the loop to keep going
    // and surface the visible rows instead.
    for (let i = 0; i < 2; i++) {
      await addMessage(
        conv.id,
        "user",
        JSON.stringify([{ type: "text", text: `old visible ${i}` }]),
      );
    }
    for (let i = 0; i < 5; i++) {
      await addMessage(
        conv.id,
        "assistant",
        JSON.stringify([{ type: "text", text: `hidden ${i}` }]),
        { metadata: { hidden: true } },
      );
    }

    const latest = handleListMessages({
      queryParams: { conversationId: conv.id, page: "latest", limit: "2" },
    }) as {
      messages: MessagePayload[];
      hasMore: boolean;
      oldestTimestamp: number | null;
    };

    expect(latest.messages.map(plainText)).toEqual([
      "old visible 0",
      "old visible 1",
    ]);
    expect(latest.hasMore).toBe(false);
    expect(latest.oldestTimestamp).not.toBeNull();
  });

  test("fork retrospective conversations expose the hidden instruction and keep the review as its own turn", async () => {
    const conv = createConversation({
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "source question" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "source answer" }]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "background memory pass instruction" },
      ]),
      {
        metadata: { kind: MEMORY_RETROSPECTIVE_INSTRUCTION_KIND, hidden: true },
      },
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "retrospective review" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // The hidden instruction is shown, and because it sits between the two
    // assistant rows they do NOT merge — the review stands as its own turn.
    expect(body.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(plainText(body.messages[1])).toBe("source answer");
    expect(plainText(body.messages[2])).toContain(
      "background memory pass instruction",
    );
    expect(plainText(body.messages[3])).toBe("retrospective review");
  });

  test("non-fork conversations still hide the retrospective instruction (relaxation is fork-scoped)", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "source question" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "source answer" }]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "background memory pass instruction" },
      ]),
      {
        metadata: { kind: MEMORY_RETROSPECTIVE_INSTRUCTION_KIND, hidden: true },
      },
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "retrospective review" }]),
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // Instruction stays hidden for non-retrospective conversations; the review
    // (a normal assistant message) is still returned.
    expect(
      body.messages.some((m) =>
        plainText(m).includes("background memory pass instruction"),
      ),
    ).toBe(false);
    expect(
      body.messages.some((m) => plainText(m).includes("retrospective review")),
    ).toBe(true);
  });
});
