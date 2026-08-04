import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the persistence layer the surface helpers read from so tests can seed
// rows without touching SQLite. Swapped per test via the closure below.
let getMessagesImpl: (conversationId: string) => Array<{
  id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
}> = () => [];

const realCrud = await import("../persistence/conversation-crud.js");

mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) => getMessagesImpl(conversationId),
}));

// Import must come AFTER mock.module so the surface module picks up the
// mocked persistence functions.
const { findPersistedSurfaceInfo } =
  await import("../daemon/conversation-surfaces.js");

const CONVERSATION_ID = "conv-persisted-info-1";

function seedRows(rows: Array<{ id: string; content: unknown[] }>): void {
  getMessagesImpl = () =>
    rows.map((r) => ({
      id: r.id,
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: r.content,
      createdAt: 0,
      metadata: null,
    }));
}

describe("findPersistedSurfaceInfo", () => {
  beforeEach(() => {
    getMessagesImpl = () => [];
  });

  test("returns the surfaceType of a persisted ui_surface block", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          { type: "text", text: "pick one" },
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: { options: [] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1")
        ?.surfaceType,
    ).toBe("choice");
  });

  test("returns the data of a persisted ui_surface block", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-confirm-1",
            surfaceType: "confirmation",
            data: { message: "Delete it?", confirmLabel: "Delete forever" },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-confirm-1")?.data,
    ).toEqual({ message: "Delete it?", confirmLabel: "Delete forever" });
  });

  test("reports no data when the block carries no object data", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dataless-1",
            surfaceType: "choice",
          },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      CONVERSATION_ID,
      "surface-dataless-1",
    );
    expect(info?.surfaceType).toBe("choice");
    expect(info?.data).toBeUndefined();
  });

  test("returns undefined for an unknown surfaceId", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-missing"),
    ).toBeUndefined();
  });

  test("returns undefined for a conversation with no messages", () => {
    seedRows([]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1"),
    ).toBeUndefined();
  });

  test("returns the type for a block behind the compaction boundary", () => {
    // The surface sits in the oldest row, with three newer rows after it. A
    // conversation compacted to `contextCompactedMessageCount: 3` hides this
    // row from `findPersistedSurfaceState`, whose scan is bounded by
    // `rn > liveHistoryStartRow`. This helper consults no boundary at all.
    seedRows([
      {
        id: "msg-compacted",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-compacted-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
      { id: "msg-2", content: [{ type: "text", text: "later" }] },
      { id: "msg-3", content: [{ type: "text", text: "later" }] },
      { id: "msg-4", content: [{ type: "text", text: "later" }] },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-compacted-1")
        ?.surfaceType,
    ).toBe("choice");
  });

  test("reports no surfaceType when the block carries no string one", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          { type: "ui_surface", surfaceId: "surface-typeless-1", data: {} },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      CONVERSATION_ID,
      "surface-typeless-1",
    );
    expect(info).toBeDefined();
    expect(info?.surfaceType).toBeUndefined();
  });

  test("returns undefined rather than throwing when the DB read fails", () => {
    getMessagesImpl = () => {
      throw new Error("database is locked");
    };

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1"),
    ).toBeUndefined();
  });
});
