/**
 * Route handlers for document persistence operations.
 *
 * Exposes document CRUD over HTTP, sharing business logic with the
 * handlers in `daemon/handlers/documents.ts`.
 */
import { z } from "zod";

import { rawAll, rawGet, rawRun } from "../../memory/raw-query.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

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
// Junction table helper
// ---------------------------------------------------------------------------

/** Insert a document–conversation association (idempotent via INSERT OR IGNORE). */
export function addDocumentConversation(
  surfaceId: string,
  conversationId: string,
): void {
  rawRun(
    /*sql*/ `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    surfaceId,
    conversationId,
    Date.now(),
  );
}

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

    // Best-effort: associate the document with the conversation.
    // Failures (e.g. migration not yet applied, table missing) must not
    // cause the save response to report failure — the document itself is
    // already persisted at this point.
    try {
      addDocumentConversation(params.surfaceId, params.conversationId);
    } catch (err) {
      log.warn(
        { err, surfaceId: params.surfaceId },
        "Failed to record document–conversation association",
      );
    }

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
    let results: DocumentListRow[];

    if (conversationId) {
      // Query via junction table so we return the *matched* conversation_id
      // (not the origin conversation_id from the documents table).
      results = rawAll<DocumentListRow>(
        /*sql*/ `
        SELECT d.surface_id, dc.conversation_id AS conversation_id,
               d.title, d.word_count, d.created_at, d.updated_at
        FROM documents d
        INNER JOIN document_conversations dc ON d.surface_id = dc.surface_id
        WHERE dc.conversation_id = ?
        ORDER BY d.updated_at DESC
        `,
        conversationId,
      );
    } else {
      results = rawAll<DocumentListRow>(/*sql*/ `
        SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
        FROM documents
        ORDER BY updated_at DESC
        `);
    }

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

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listDocuments",
    endpoint: "documents",
    method: "GET",
    policyKey: "documents",
    requirePolicyEnforcement: true,
    summary: "List documents",
    description: "Return all documents, optionally filtered by conversation.",
    tags: ["documents"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Filter by conversation ID",
      },
    ],
    responseBody: z.object({
      documents: z.array(z.unknown()).describe("Document summary objects"),
    }),
    handler: ({ queryParams }) => {
      const conversationId = queryParams?.conversationId ?? undefined;
      const documents = listDocuments(conversationId);
      return { documents };
    },
  },

  {
    operationId: "getDocument",
    endpoint: "documents/:id",
    method: "GET",
    policyKey: "documents",
    requirePolicyEnforcement: true,
    summary: "Get a document",
    description: "Return a single document by surface ID.",
    tags: ["documents"],
    responseBody: z.object({
      success: z.boolean(),
      surfaceId: z.string(),
      conversationId: z.string(),
      title: z.string(),
      content: z.string(),
      wordCount: z.number(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
    handler: ({ pathParams }) => {
      const result = loadDocument(pathParams!.id);
      if (!result.success) {
        throw new NotFoundError(result.error);
      }
      return result;
    },
  },

  {
    operationId: "saveDocument",
    endpoint: "documents",
    method: "POST",
    policyKey: "documents",
    requirePolicyEnforcement: true,
    summary: "Save a document",
    description: "Create or upsert a document (by surfaceId).",
    tags: ["documents"],
    requestBody: z.object({
      surfaceId: z.string().describe("Surface ID (unique key)"),
      conversationId: z.string().describe("Owning conversation"),
      title: z.string().describe("Document title"),
      content: z.string().describe("Document content"),
      wordCount: z.number().describe("Word count"),
    }),
    responseBody: z.object({
      success: z.literal(true),
      surfaceId: z.string(),
    }),
    handler: ({ body }) => {
      const { surfaceId, conversationId, title, content, wordCount } = (body ??
        {}) as {
        surfaceId?: string;
        conversationId?: string;
        title?: string;
        content?: string;
        wordCount?: number;
      };

      if (!surfaceId || typeof surfaceId !== "string") {
        throw new BadRequestError("surfaceId is required");
      }
      if (!conversationId || typeof conversationId !== "string") {
        throw new BadRequestError("conversationId is required");
      }
      if (!title || typeof title !== "string") {
        throw new BadRequestError("title is required");
      }
      if (typeof content !== "string") {
        throw new BadRequestError("content is required");
      }
      if (typeof wordCount !== "number") {
        throw new BadRequestError("wordCount is required");
      }

      const result = saveDocument({
        surfaceId,
        conversationId,
        title,
        content,
        wordCount,
      });

      if (!result.success) {
        throw new InternalError(result.error);
      }
      return result;
    },
  },
];
