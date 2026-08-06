/**
 * Client-initiated document writes must invalidate the `documents:list` tag so
 * the Library and the per-conversation assets list converge on every surface.
 * Read routes and rejected writes must stay silent.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../api/index.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES as DOCUMENT_ROUTES } from "../runtime/routes/documents-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import {
  DOCUMENTS_CHANGED_COALESCE_MS,
  DOCUMENTS_CHANGED_MAX_DEFER_MS,
  publishDocumentsChanged,
} from "../runtime/sync/resource-sync-events.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const notesDir = join(workspaceDir, "sync-notes");

const CONVERSATION_ID = "conv-doc-sync";
const OTHER_CONVERSATION_ID = "conv-doc-sync-other";
const MISSING_CONVERSATION_ID = "conv-doc-sync-missing";

function getRoute(operationId: string): RouteDefinition {
  const route = DOCUMENT_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`No document route found for operationId: ${operationId}`);
  }
  return route;
}

/**
 * Wait past the documents coalescing window plus a few ticks of async hub
 * dispatch, so a publish scheduled before the wait has certainly landed.
 */
async function settlePublishes(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, DOCUMENTS_CHANGED_COALESCE_MS + 50),
  );
}

/**
 * Run `action` and return every `sync_changed` event it produced.
 *
 * Publishes coalesce and the hub dispatches asynchronously, so the window is
 * drained before the capture starts (setup writes must not leak into it) and
 * held open past the action. That window is what lets a "publishes nothing"
 * assertion be meaningful and what catches a stray second publish.
 */
async function captureSyncEvents(
  action: () => unknown | Promise<unknown>,
): Promise<AssistantEventEnvelope[]> {
  await settlePublishes();
  const received: AssistantEventEnvelope[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      if (event.message.type === "sync_changed") {
        received.push(event);
      }
    },
  });
  try {
    await action();
    await settlePublishes();
    return received;
  } finally {
    subscription.dispose();
  }
}

function expectDocumentsChanged(events: AssistantEventEnvelope[]): void {
  expect(events).toHaveLength(1);
  expect(events[0].message).toMatchObject({
    type: "sync_changed",
    tags: [SYNC_TAGS.documentsList],
  });
}

/** Run a route handler so its synchronous throws surface as rejections. */
async function invoke(
  operationId: string,
  args: Parameters<RouteDefinition["handler"]>[0],
): Promise<unknown> {
  return await getRoute(operationId).handler(args);
}

async function saveViaRoute(
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  return await invoke("saveDocument", {
    body: {
      surfaceId: "doc-sync",
      conversationId: CONVERSATION_ID,
      title: "Notes",
      content: "hello world",
      wordCount: 2,
      ...overrides,
    },
  });
}

async function openWorkspaceFile(
  path: string,
  conversationId = CONVERSATION_ID,
): Promise<unknown> {
  return await invoke("documentForWorkspaceFile", {
    body: { path, conversationId },
  });
}

async function linkViaRoute(
  surfaceId: string,
  conversationId: string,
): Promise<unknown> {
  return await invoke("linkDocumentConversation", {
    pathParams: { id: surfaceId },
    body: { conversationId },
  });
}

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM document_conversations");
  db.run("DELETE FROM documents");
  db.run("DELETE FROM conversations");
  createConversation({ id: CONVERSATION_ID });
  createConversation({ id: OTHER_CONVERSATION_ID });
  rmSync(notesDir, { recursive: true, force: true });
  mkdirSync(notesDir, { recursive: true });
});

afterAll(() => {
  rmSync(notesDir, { recursive: true, force: true });
  resetDbForTesting();
});

describe("document write routes publish documents:list", () => {
  test("a successful save publishes exactly one documents-changed event", async () => {
    const events = await captureSyncEvents(() => saveViaRoute());
    expectDocumentsChanged(events);
  });

  test("retitling an existing document publishes", async () => {
    await saveViaRoute();

    const events = await captureSyncEvents(() =>
      saveViaRoute({ title: "Renamed notes" }),
    );
    expectDocumentsChanged(events);
  });

  test("a content-only save publishes", async () => {
    // The save moves `updated_at` and the word count, which order and fill the
    // Library and the assets list on every other client. The saving client
    // suppresses its own echo, and the publish coalesces, so an autosave run
    // costs the others at most one broadcast per second.
    await saveViaRoute();

    const events = await captureSyncEvents(() =>
      saveViaRoute({ content: "hello world again", wordCount: 3 }),
    );
    expectDocumentsChanged(events);
  });

  test("the save carries the caller's client id so it can suppress its own echo", async () => {
    const events = await captureSyncEvents(() =>
      invoke("saveDocument", {
        body: {
          surfaceId: "doc-sync-origin",
          conversationId: CONVERSATION_ID,
          title: "Notes",
          content: "hello world",
          wordCount: 2,
        },
        headers: { "x-vellum-client-id": "client-abc" },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].message).toMatchObject({
      type: "sync_changed",
      tags: [SYNC_TAGS.documentsList],
      originClientId: "client-abc",
    });
  });

  test("linking a document to a conversation publishes", async () => {
    await saveViaRoute();

    const events = await captureSyncEvents(() =>
      linkViaRoute("doc-sync", OTHER_CONVERSATION_ID),
    );
    expectDocumentsChanged(events);
  });

  test("the link publishes without an origin so the caller is not suppressed", async () => {
    // `document-viewer-page` links, then navigates to the conversation whose
    // assets pill must now list the document, and invalidates nothing itself.
    await saveViaRoute();

    const events = await captureSyncEvents(() =>
      invoke("linkDocumentConversation", {
        pathParams: { id: "doc-sync" },
        body: { conversationId: OTHER_CONVERSATION_ID },
        headers: { "x-vellum-client-id": "client-abc" },
      }),
    );

    expect(events).toHaveLength(1);
    expect("originClientId" in events[0].message).toBe(false);
  });

  test("binding a workspace file publishes without an origin so the caller is not suppressed", async () => {
    // `viewer-store.loadWorkspaceFileDocument` creates the row and invalidates
    // nothing, so the client that opened the file is the one that most needs
    // the invalidation.
    writeFileSync(join(notesDir, "plan.md"), "# Plan");

    const events = await captureSyncEvents(() =>
      invoke("documentForWorkspaceFile", {
        body: { path: "sync-notes/plan.md", conversationId: CONVERSATION_ID },
        headers: { "x-vellum-client-id": "client-abc" },
      }),
    );

    expect(events).toHaveLength(1);
    expect("originClientId" in events[0].message).toBe(false);
  });

  test("binding a workspace file to a new document publishes", async () => {
    writeFileSync(join(notesDir, "plan.md"), "# Plan");

    const events = await captureSyncEvents(() =>
      openWorkspaceFile("sync-notes/plan.md"),
    );
    expectDocumentsChanged(events);
  });

  test("reopening the file from another conversation publishes the new link", async () => {
    writeFileSync(join(notesDir, "plan.md"), "# Plan");
    await openWorkspaceFile("sync-notes/plan.md");

    const events = await captureSyncEvents(() =>
      openWorkspaceFile("sync-notes/plan.md", OTHER_CONVERSATION_ID),
    );
    expectDocumentsChanged(events);
  });

  test("refreshing a document whose file changed on disk publishes", async () => {
    const filePath = join(notesDir, "plan.md");
    writeFileSync(filePath, "# Plan");
    await openWorkspaceFile("sync-notes/plan.md");
    writeFileSync(filePath, "# Plan\n\nedited outside the editor");

    const events = await captureSyncEvents(() =>
      openWorkspaceFile("sync-notes/plan.md"),
    );
    expectDocumentsChanged(events);
  });
});

describe("document routes that change nothing the list shows stay silent", () => {
  test("reopening an unchanged, already-linked file publishes nothing", async () => {
    writeFileSync(join(notesDir, "plan.md"), "# Plan");
    await openWorkspaceFile("sync-notes/plan.md");

    const events = await captureSyncEvents(() =>
      openWorkspaceFile("sync-notes/plan.md"),
    );
    expect(events).toEqual([]);
  });

  test("a save rejected by validation publishes nothing", async () => {
    const events = await captureSyncEvents(async () => {
      await expect(saveViaRoute({ title: undefined })).rejects.toThrow(
        /title is required/,
      );
    });
    expect(events).toEqual([]);
  });

  test("a save the store refuses publishes nothing", async () => {
    // The conversation row is absent, so the insert trips the foreign key and
    // the store reports failure instead of persisting.
    const events = await captureSyncEvents(async () => {
      await expect(
        saveViaRoute({ conversationId: MISSING_CONVERSATION_ID }),
      ).rejects.toThrow();
    });
    expect(events).toEqual([]);
  });

  test("a link to a document that does not exist publishes nothing", async () => {
    const events = await captureSyncEvents(async () => {
      await expect(
        linkViaRoute("doc-missing", OTHER_CONVERSATION_ID),
      ).rejects.toThrow(/Document not found/);
    });
    expect(events).toEqual([]);
  });

  test("listing documents publishes nothing", async () => {
    await saveViaRoute();

    const events = await captureSyncEvents(() => invoke("listDocuments", {}));
    expect(events).toEqual([]);
  });

  test("reading a single document publishes nothing", async () => {
    await saveViaRoute();

    const events = await captureSyncEvents(() =>
      invoke("getDocument", { pathParams: { id: "doc-sync" } }),
    );
    expect(events).toEqual([]);
  });
});

describe("documents-changed publishes coalesce", () => {
  test("a burst of writes collapses into a single broadcast", async () => {
    // The document-editor skill streams a document as many `document_update`
    // calls, each of which publishes. Without coalescing each one drains three
    // documentsGet queries on every connected client.
    const events = await captureSyncEvents(() => {
      for (let i = 0; i < 10; i++) {
        publishDocumentsChanged();
      }
    });

    expectDocumentsChanged(events);
  });

  test("a burst spanning two clients drops the origin so neither suppresses it", async () => {
    const events = await captureSyncEvents(() => {
      publishDocumentsChanged("client-a");
      publishDocumentsChanged("client-b");
    });

    expect(events).toHaveLength(1);
    expect("originClientId" in events[0].message).toBe(false);
  });

  test("a burst from one client keeps that client's origin", async () => {
    const events = await captureSyncEvents(() => {
      publishDocumentsChanged("client-a");
      publishDocumentsChanged("client-a");
    });

    expect(events).toHaveLength(1);
    expect(events[0].message).toMatchObject({ originClientId: "client-a" });
  });

  test("an unbroken run of writes still publishes before the turn ends", async () => {
    // A document streamed in sub-window chunks would otherwise keep pushing the
    // timer out and never refresh the list while it is being written.
    const events = await captureSyncEvents(async () => {
      const deadline = Date.now() + DOCUMENTS_CHANGED_MAX_DEFER_MS + 100;
      while (Date.now() < deadline) {
        publishDocumentsChanged();
        await new Promise((resolve) =>
          setTimeout(resolve, DOCUMENTS_CHANGED_COALESCE_MS / 3),
        );
      }
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
