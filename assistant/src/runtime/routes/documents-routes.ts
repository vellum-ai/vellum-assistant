/**
 * Route handlers for document persistence operations.
 *
 * Exposes document CRUD over HTTP, sharing business logic with the
 * handlers in `daemon/handlers/documents.ts`.
 */
import { rawAll, rawGet, rawRun } from "../../memory/db.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("documents-routes");

interface DocumentRow {
  surface_id: string;
  conversation_id: string;
  title: string;
  content: string;
  word_count: number;
  created_at: number;
  updated_at: number;
}

type DocumentListRow = Omit<DocumentRow, "content">;

// ---------------------------------------------------------------------------
// Shared business logic (used by both message handlers and HTTP routes)
// ---------------------------------------------------------------------------

function saveDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
}): { success: true; surfaceId: string } | { success: false; error: string } {
  try {
    const now = Date.now();
    rawRun(
      `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at`,
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.wordCount,
      now,
      now,
    );
    log.info(
      { surfaceId: params.surfaceId, title: params.title },
      "Saved document",
    );
    return { success: true, surfaceId: params.surfaceId };
  } catch (error) {
    log.error({ err: error, surfaceId: params.surfaceId }, "Save error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function loadDocument(surfaceId: string):
  | {
      success: true;
      surfaceId: string;
      conversationId: string;
      title: string;
      content: string;
      wordCount: number;
      createdAt: number;
      updatedAt: number;
    }
  | { success: false; error: string } {
  try {
    const result = rawGet<DocumentRow>(
      /*sql*/ `
      SELECT surface_id, conversation_id, title, content, word_count, created_at, updated_at
      FROM documents
      WHERE surface_id = ?
    `,
      surfaceId,
    );

    if (result) {
      log.info({ surfaceId }, "Loaded document");
      return {
        success: true,
        surfaceId: result.surface_id,
        conversationId: result.conversation_id,
        title: result.title,
        content: result.content,
        wordCount: result.word_count,
        createdAt: result.created_at,
        updatedAt: result.updated_at,
      };
    }
    log.info({ surfaceId }, "Document not found");
    return { success: false, error: "Document not found" };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Load error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function listDocuments(conversationId?: string): Array<{
  surfaceId: string;
  conversationId: string;
  title: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
}> {
  try {
    let query = /*sql*/ `
      SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
      FROM documents
    `;
    const params: string[] = [];

    if (conversationId) {
      query += " WHERE conversation_id = ?";
      params.push(conversationId);
    }

    query += " ORDER BY updated_at DESC";

    const results = rawAll<DocumentListRow>(query, ...params);

    log.info({ count: results.length }, "Listed documents");
    return results.map((row) => ({
      surfaceId: row.surface_id,
      conversationId: row.conversation_id,
      title: row.title,
      wordCount: row.word_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    log.error({ err: error }, "List error");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function documentRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "documents",
      method: "GET",
      policyKey: "documents",
      handler: ({ url }) => {
        const conversationId =
          url.searchParams.get("conversationId") ?? undefined;
        const documents = listDocuments(conversationId);
        return Response.json({ documents });
      },
    },
    {
      endpoint: "documents/:id",
      method: "GET",
      policyKey: "documents",
      handler: ({ params }) => {
        const result = loadDocument(params.id);
        if (!result.success) {
          return httpError("NOT_FOUND", result.error, 404);
        }
        return Response.json(result);
      },
    },
    {
      endpoint: "documents",
      method: "POST",
      policyKey: "documents",
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          surfaceId?: string;
          conversationId?: string;
          title?: string;
          content?: string;
          wordCount?: number;
        };

        if (!body.surfaceId || typeof body.surfaceId !== "string") {
          return httpError("BAD_REQUEST", "surfaceId is required", 400);
        }
        if (!body.conversationId || typeof body.conversationId !== "string") {
          return httpError("BAD_REQUEST", "conversationId is required", 400);
        }
        if (!body.title || typeof body.title !== "string") {
          return httpError("BAD_REQUEST", "title is required", 400);
        }
        if (typeof body.content !== "string") {
          return httpError("BAD_REQUEST", "content is required", 400);
        }
        if (typeof body.wordCount !== "number") {
          return httpError("BAD_REQUEST", "wordCount is required", 400);
        }

        const result = saveDocument({
          surfaceId: body.surfaceId,
          conversationId: body.conversationId,
          title: body.title,
          content: body.content,
          wordCount: body.wordCount,
        });

        if (!result.success) {
          return httpError("INTERNAL_ERROR", result.error, 500);
        }
        return Response.json(result);
      },
    },
  ];
}
