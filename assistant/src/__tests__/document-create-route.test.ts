import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_DOCUMENT_TITLE,
  getDocumentsForConversation,
} from "../documents/document-store.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES as DOCUMENT_ROUTES } from "../runtime/routes/documents-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

const CONVERSATION_ID = "conv-doc-create";

async function create(body: Record<string, unknown>): Promise<unknown> {
  const route = DOCUMENT_ROUTES.find(
    (r: RouteDefinition) => r.operationId === "createDocument",
  )!;
  return await route.handler({ body });
}

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM document_conversations");
  db.run("DELETE FROM documents");
  db.run("DELETE FROM conversations");
  createConversation({ id: CONVERSATION_ID });
});

afterAll(() => {
  resetDbForTesting();
});

describe("createDocument route", () => {
  test("creates an empty document under a new surface ID and returns it", async () => {
    const result = await create({
      conversationId: CONVERSATION_ID,
      title: "Trip plan",
    });

    expect(result).toMatchObject({
      success: true,
      conversationId: CONVERSATION_ID,
      title: "Trip plan",
      content: "",
      wordCount: 0,
    });
    const { surfaceId } = result as { surfaceId: string };
    expect(surfaceId).toMatch(/^doc-[0-9a-f-]{36}$/);
    expect(
      getDocumentsForConversation(CONVERSATION_ID).map((d) => d.surfaceId),
    ).toEqual([surfaceId]);
  });

  test("a missing or blank title falls back to the default", async () => {
    await expect(
      create({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({ title: DEFAULT_DOCUMENT_TITLE });
    await expect(
      create({ conversationId: CONVERSATION_ID, title: "   " }),
    ).resolves.toMatchObject({ title: DEFAULT_DOCUMENT_TITLE });
  });

  test("each create mints a distinct document", async () => {
    const first = (await create({ conversationId: CONVERSATION_ID })) as {
      surfaceId: string;
    };
    const second = (await create({ conversationId: CONVERSATION_ID })) as {
      surfaceId: string;
    };

    expect(first.surfaceId).not.toBe(second.surfaceId);
    expect(getDocumentsForConversation(CONVERSATION_ID)).toHaveLength(2);
  });

  test("rejects a request without a conversation", async () => {
    await expect(create({})).rejects.toThrow(/conversationId is required/);
  });

  test("rejects a conversation that does not exist", async () => {
    await expect(create({ conversationId: "conv-missing" })).rejects.toThrow(
      /Conversation not found/,
    );
  });
});
