import { beforeEach, describe, expect, test } from "bun:test";

import {
  findPersistedSurfaceInfo,
  markSurfaceCompleted,
} from "../daemon/conversation-surfaces.js";
import { getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import { findPersistedSurfaceState } from "../runtime/routes/surface-conversation-resolver.js";
import { getDbPath } from "../util/platform.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

await initializeDb();

const CONVERSATION_ID = "conv-compaction-boundary-1";
const SURFACE_ID = "surface-behind-boundary-1";
/** The surface sits in row 1, so this boundary drops it from live history. */
const COMPACTED_MESSAGE_COUNT = 3;

const GUARDIAN = { requesterCanAccessMemory: true };

/**
 * Four real message rows, the oldest carrying a `choice` surface between two
 * text siblings, plus a conversation compacted past that row.
 */
function seedCompactedConversation(): void {
  const db = getDb();
  // Without the test preload these deletes would clear the user's live
  // workspace database.
  assertNotLiveDb(getDbPath());
  db.delete(messages).run();
  db.delete(conversations).run();
  db.insert(conversations)
    .values({
      id: CONVERSATION_ID,
      title: null,
      createdAt: 1,
      updatedAt: 1,
      contextCompactedMessageCount: COMPACTED_MESSAGE_COUNT,
    })
    .run();

  const rows = [
    [
      { type: "text", text: "Which one?" },
      {
        type: "ui_surface",
        surfaceId: SURFACE_ID,
        surfaceType: "choice",
        data: { options: [{ id: "inbox", title: "Clean up my inbox" }] },
      },
      { type: "text", text: "Take your time." },
    ],
    [{ type: "text", text: "still waiting" }],
    [{ type: "text", text: "still waiting" }],
    [{ type: "text", text: "still waiting" }],
  ];
  rows.forEach((content, i) => {
    db.insert(messages)
      .values({
        id: `msg-${i + 1}`,
        conversationId: CONVERSATION_ID,
        role: "assistant",
        content: JSON.stringify(content),
        createdAt: i + 1,
        metadata: null,
      })
      .run();
  });
}

/** The surface block as a history reseed would read it back. */
function readPersistedBlocks(): Array<Record<string, unknown>> {
  const row = getMessages(CONVERSATION_ID).find((r) => r.id === "msg-1")!;
  return row.content as unknown as Array<Record<string, unknown>>;
}

describe("a surface behind the context-compaction boundary", () => {
  beforeEach(seedCompactedConversation);

  test("is invisible to the compaction-bounded read", () => {
    expect(
      findPersistedSurfaceState(CONVERSATION_ID, SURFACE_ID, {
        liveHistoryStartRow: COMPACTED_MESSAGE_COUNT,
        ...GUARDIAN,
      }),
    ).toBeUndefined();
  });

  test("is found by the same read once the boundary is lifted", () => {
    expect(
      findPersistedSurfaceState(CONVERSATION_ID, SURFACE_ID, {
        liveHistoryStartRow: 0,
        ...GUARDIAN,
      })?.surfaceType,
    ).toBe("choice");
  });

  test("still yields its type to the completion path's read", () => {
    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, SURFACE_ID, GUARDIAN)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("is completed by the write, leaving its sibling blocks intact", () => {
    expect(
      markSurfaceCompleted(
        { conversationId: CONVERSATION_ID },
        SURFACE_ID,
        'User chose: "Clean up my inbox"',
      ),
    ).toBe(true);

    const blocks = readPersistedBlocks();
    const surface = blocks.find((b) => b.type === "ui_surface");
    expect(surface?.completed).toBe(true);
    expect(surface?.completionSummary).toBe('User chose: "Clean up my inbox"');
    expect(surface?.surfaceType).toBe("choice");
    expect(blocks.map((b) => b.type)).toEqual(["text", "ui_surface", "text"]);
  });
});
