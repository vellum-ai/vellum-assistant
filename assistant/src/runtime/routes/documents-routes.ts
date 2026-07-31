/**
 * Route handlers for document persistence operations.
 *
 * Exposes document CRUD over HTTP, sharing business logic with the
 * handlers in `daemon/handlers/documents.ts`.
 */
import { z } from "zod";

import {
  addDocumentConversation,
  getDocumentById,
  getDocumentsForConversation,
  saveDocument,
} from "../../documents/document-store.js";
import { rawAll } from "../../persistence/raw-query.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { renderMarkdownToPDF } from "./document-pdf-renderer.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { RouteResponse } from "./types.js";

const log = getLogger("documents-routes");

interface DocumentListRow {
  surface_id: string;
  conversation_id: string;
  title: string;
  word_count: number;
  created_at: number;
  updated_at: number;
}

function listAllDocuments(): Array<{
  surfaceId: string;
  conversationId: string;
  title: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
}> {
  try {
    const results = rawAll<DocumentListRow>(
      "documents:listAllDocuments",
      /*sql*/ `
      SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
      FROM documents
      ORDER BY updated_at DESC
      `,
    );

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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      documents: z.array(
        z.object({
          surfaceId: z.string(),
          conversationId: z.string(),
          title: z.string(),
          wordCount: z.number(),
          createdAt: z.number(),
          updatedAt: z.number(),
        }),
      ),
    }),
    handler: ({ queryParams }) => {
      const conversationId = queryParams?.conversationId ?? undefined;
      const documents = conversationId
        ? getDocumentsForConversation(conversationId)
        : listAllDocuments();
      return { documents };
    },
  },

  {
    operationId: "getDocument",
    endpoint: "documents/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      const doc = getDocumentById(pathParams!.id);
      if (!doc) {
        throw new NotFoundError("Document not found");
      }
      return { success: true, ...doc };
    },
  },

  {
    operationId: "saveDocument",
    endpoint: "documents",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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

  {
    operationId: "linkDocumentConversation",
    endpoint: "documents/:id/conversations",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Link a document to a conversation",
    description:
      "Associate a document with a conversation so the assistant sees it as context.",
    tags: ["documents"],
    requestBody: z.object({
      conversationId: z.string().describe("Conversation to link"),
    }),
    responseBody: z.object({ success: z.literal(true) }),
    handler: ({ pathParams, body }) => {
      const { conversationId } = (body ?? {}) as { conversationId?: string };
      if (!conversationId) {
        throw new BadRequestError("conversationId is required");
      }
      const doc = getDocumentById(pathParams!.id);
      if (!doc) {
        throw new NotFoundError("Document not found");
      }
      addDocumentConversation(pathParams!.id, conversationId);
      log.info(
        { surfaceId: pathParams!.id, conversationId },
        "Linked document to conversation",
      );
      return { success: true as const };
    },
  },

  {
    operationId: "exportDocumentPDF",
    endpoint: "documents/:id/pdf",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Export a document as PDF",
    description: "Render a document to PDF and return the binary content.",
    tags: ["documents"],
    responseBody: {
      contentType: "application/pdf",
      schema: { type: "string", format: "binary" },
    },
    handler: async ({ pathParams }) => {
      const doc = getDocumentById(pathParams!.id);
      if (!doc) {
        throw new NotFoundError("Document not found");
      }
      const pdfBuffer = await renderMarkdownToPDF(doc.title, doc.content);
      const filename =
        doc.title
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "document";
      return new RouteResponse(new Uint8Array(pdfBuffer), {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}.pdf"`,
        "Content-Length": String(pdfBuffer.length),
      });
    },
  },
];
