/**
 * Document revision history: which writes snapshot the state they replace,
 * retention, the history routes, restore, and cascade on delete.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../api/index.js";
import {
  listDocumentRevisions,
  MAX_REVISIONS_PER_DOCUMENT,
  USER_SNAPSHOT_INTERVAL_MS,
} from "../documents/document-revisions-store.js";
import {
  createDocument,
  deleteDocument,
  getDocumentById,
  mutateDocumentContent,
  replaceInDocument,
  saveDocument,
  updateDocumentContent,
} from "../documents/document-store.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES as DOCUMENT_ROUTES } from "../runtime/routes/documents-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

const CONVERSATION_ID = "conv-doc-history";

function route(operationId: string): RouteDefinition {
  return DOCUMENT_ROUTES.find((r) => r.operationId === operationId)!;
}

async function invoke(
  operationId: string,
  args: Parameters<RouteDefinition["handler"]>[0],
): Promise<unknown> {
  return await route(operationId).handler(args);
}

function seed(content = "v1"): string {
  const created = createDocument({
    conversationId: CONVERSATION_ID,
    title: "Doc",
    content,
  });
  if (!created.success) {
    throw new Error(created.error);
  }
  return created.surfaceId;
}

function userSave(
  surfaceId: string,
  content: string,
  extra: { title?: string; baseRevision?: number } = {},
) {
  return saveDocument({
    surfaceId,
    conversationId: CONVERSATION_ID,
    title: extra.title ?? "Doc",
    content,
    wordCount: 1,
    baseRevision: extra.baseRevision,
  });
}

/** `[revision, author]` pairs, newest first. */
function history(surfaceId: string): Array<[number, string]> {
  return listDocumentRevisions(surfaceId).map((r) => [r.revision, r.author]);
}

function ageSnapshots(surfaceId: string, ms: number): void {
  getSqlite()
    .query(
      "UPDATE document_revisions SET created_at = created_at - ? WHERE surface_id = ?",
    )
    .run(ms, surfaceId);
}

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM document_revisions");
  db.run("DELETE FROM document_conversations");
  db.run("DELETE FROM documents");
  db.run("DELETE FROM conversations");
  createConversation({ id: CONVERSATION_ID });
});

afterAll(() => {
  resetDbForTesting();
});

describe("assistant edits", () => {
  test("creating a document takes no snapshot", () => {
    expect(history(seed())).toEqual([]);
  });

  test("every assistant write snapshots the state it replaces", () => {
    const surfaceId = seed("v1");

    updateDocumentContent(surfaceId, "v2", "replace");
    updateDocumentContent(surfaceId, "more", "append");
    replaceInDocument(surfaceId, "more", "most");

    expect(history(surfaceId)).toEqual([
      [3, "assistant"],
      [2, "assistant"],
      [1, "assistant"],
    ]);
    expect(listDocumentRevisions(surfaceId).at(-1)).toMatchObject({
      revision: 1,
      title: "Doc",
    });
  });

  test("an edit that changes nothing writes and snapshots nothing", () => {
    const surfaceId = seed("hello");

    replaceInDocument(surfaceId, "absent", "x");
    updateDocumentContent(surfaceId, "hello", "replace");

    expect(history(surfaceId)).toEqual([]);
    expect(getDocumentById(surfaceId)?.revision).toBe(1);
  });

  test("a race lost mid-write rolls its snapshot back", () => {
    const surfaceId = seed("v1");
    userSave(surfaceId, "v2"); // snapshots revision 1 as the user's
    let calls = 0;

    mutateDocumentContent(surfaceId, "assistant", (current) => {
      calls++;
      if (calls === 1) {
        // A recent user snapshot exists, so this save snapshots nothing.
        userSave(surfaceId, "v3");
      }
      return { content: `${current.content} edited`, value: null };
    });

    // The first attempt's snapshot of revision 2 was rolled back with its
    // failed write; the retry snapshotted revision 3.
    expect(history(surfaceId)).toEqual([
      [3, "assistant"],
      [1, "user"],
    ]);
    expect(getDocumentById(surfaceId)).toMatchObject({
      content: "v3 edited",
      revision: 4,
    });
  });
});

describe("user saves", () => {
  test("the first save of a document snapshots it", () => {
    const surfaceId = seed("v1");

    userSave(surfaceId, "v2");

    expect(history(surfaceId)).toEqual([[1, "user"]]);
    expect(listDocumentRevisions(surfaceId)[0]?.wordCount).toBe(1);
  });

  test("further saves within the interval take no snapshot", () => {
    const surfaceId = seed("v1");

    userSave(surfaceId, "v2");
    userSave(surfaceId, "v3");
    userSave(surfaceId, "v4");

    expect(history(surfaceId)).toEqual([[1, "user"]]);
  });

  test("a save after the interval snapshots again", () => {
    const surfaceId = seed("v1");
    userSave(surfaceId, "v2");
    ageSnapshots(surfaceId, USER_SNAPSHOT_INTERVAL_MS);

    userSave(surfaceId, "v3");

    expect(history(surfaceId)).toEqual([
      [2, "user"],
      [1, "user"],
    ]);
  });

  test("a save after an assistant edit keeps the assistant's result", () => {
    const surfaceId = seed("v1");
    userSave(surfaceId, "v2");
    updateDocumentContent(surfaceId, "assistant text", "replace");

    userSave(surfaceId, "user rewrite");

    expect(history(surfaceId)).toEqual([
      [3, "user"],
      [2, "assistant"],
      [1, "user"],
    ]);
  });

  test("a save that changes nothing takes no snapshot", () => {
    const surfaceId = seed("v1");

    userSave(surfaceId, "v1");

    expect(history(surfaceId)).toEqual([]);
  });

  test("a rejected conditional save takes no snapshot", () => {
    const surfaceId = seed("v1");
    userSave(surfaceId, "v2");
    ageSnapshots(surfaceId, USER_SNAPSHOT_INTERVAL_MS);

    const result = userSave(surfaceId, "stale", { baseRevision: 1 });

    expect(result.success).toBe(false);
    expect(history(surfaceId)).toEqual([[1, "user"]]);
  });
});

describe("retention", () => {
  test(`keeps the newest ${MAX_REVISIONS_PER_DOCUMENT} snapshots per document`, () => {
    const surfaceId = seed("v0");
    const other = seed("other");
    updateDocumentContent(other, "other edit", "replace");

    const writes = MAX_REVISIONS_PER_DOCUMENT + 5;
    for (let i = 1; i <= writes; i++) {
      updateDocumentContent(surfaceId, `v${i}`, "replace");
    }

    const revisions = listDocumentRevisions(surfaceId).map((r) => r.revision);
    expect(revisions).toHaveLength(MAX_REVISIONS_PER_DOCUMENT);
    expect(revisions[0]).toBe(writes);
    expect(revisions.at(-1)).toBe(writes - MAX_REVISIONS_PER_DOCUMENT + 1);
    expect(history(other)).toEqual([[1, "assistant"]]);
  });
});

describe("history routes", () => {
  test("listing returns metadata newest first, without content", async () => {
    const surfaceId = seed("one two");
    updateDocumentContent(surfaceId, "three", "replace");

    const result = (await invoke("listDocumentRevisions", {
      pathParams: { id: surfaceId },
    })) as { revisions: Array<Record<string, unknown>> };

    expect(result.revisions).toEqual([
      {
        revision: 1,
        author: "assistant",
        createdAt: expect.any(Number),
        wordCount: 2,
        title: "Doc",
      },
    ]);
  });

  test("listing a missing document is a 404", async () => {
    await expect(
      invoke("listDocumentRevisions", { pathParams: { id: "doc-missing" } }),
    ).rejects.toThrow(/Document not found/);
  });

  test("a single revision includes its content", async () => {
    const surfaceId = seed("original");
    updateDocumentContent(surfaceId, "changed", "replace");

    expect(
      await invoke("getDocumentRevision", {
        pathParams: { id: surfaceId, revision: "1" },
      }),
    ).toMatchObject({ revision: 1, author: "assistant", content: "original" });
  });

  test("an unknown or malformed revision is rejected", async () => {
    const surfaceId = seed();
    await expect(
      invoke("getDocumentRevision", {
        pathParams: { id: surfaceId, revision: "7" },
      }),
    ).rejects.toThrow(/Revision not found/);
    await expect(
      invoke("getDocumentRevision", {
        pathParams: { id: surfaceId, revision: "abc" },
      }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("restore", () => {
  test("writes the snapshot back as a new revision and snapshots the current state", async () => {
    const surfaceId = seed("original");
    updateDocumentContent(surfaceId, "assistant rewrite", "replace");
    userSave(surfaceId, "user tweak", { title: "Renamed" });

    const events: AssistantEventEnvelope[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        if (event.message.type === "document_editor_update") {
          events.push(event);
        }
      },
    });
    let result: unknown;
    try {
      result = await invoke("restoreDocumentRevision", {
        pathParams: { id: surfaceId, revision: "1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      subscription.dispose();
    }

    expect(result).toEqual({
      success: true,
      surfaceId,
      revision: 4,
      title: "Doc",
      content: "original",
    });
    expect(getDocumentById(surfaceId)).toMatchObject({
      title: "Doc",
      content: "original",
      revision: 4,
    });
    expect(history(surfaceId)).toEqual([
      [3, "user"],
      [2, "user"],
      [1, "assistant"],
    ]);
    expect(
      listDocumentRevisions(surfaceId).find((r) => r.revision === 3),
    ).toMatchObject({ title: "Renamed" });
    expect(events.map((e) => e.message)).toEqual([
      {
        type: "document_editor_update",
        conversationId: CONVERSATION_ID,
        surfaceId,
        markdown: "original",
        mode: "replace",
        revision: 4,
        title: "Doc",
      },
    ]);
  });

  test("restoring a missing revision is a 404 and writes nothing", async () => {
    const surfaceId = seed("v1");

    await expect(
      invoke("restoreDocumentRevision", {
        pathParams: { id: surfaceId, revision: "9" },
      }),
    ).rejects.toThrow(/Revision not found/);
    expect(getDocumentById(surfaceId)?.revision).toBe(1);
    expect(history(surfaceId)).toEqual([]);
  });

  test("restoring on a missing document is a 404", async () => {
    await expect(
      invoke("restoreDocumentRevision", {
        pathParams: { id: "doc-missing", revision: "1" },
      }),
    ).rejects.toThrow(/Document not found/);
  });
});

describe("cascade", () => {
  test("deleting a document drops its history", () => {
    const surfaceId = seed("v1");
    updateDocumentContent(surfaceId, "v2", "replace");
    expect(history(surfaceId)).toHaveLength(1);

    deleteDocument(surfaceId);

    const remaining = getSqlite()
      .query(
        "SELECT COUNT(*) AS n FROM document_revisions WHERE surface_id = ?",
      )
      .get(surfaceId) as { n: number };
    expect(remaining.n).toBe(0);
  });
});
