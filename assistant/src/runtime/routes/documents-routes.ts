/**
 * Route handlers for document persistence operations.
 *
 * Exposes document CRUD over HTTP, sharing business logic with the
 * handlers in `daemon/handlers/documents.ts`.
 */
import { z } from "zod";

import {
  addDocumentConversation,
  createDocument,
  DEFAULT_DOCUMENT_TITLE,
  getDocumentById,
  getDocumentsForConversation,
  listAllDocuments,
  saveDocument,
} from "../../documents/document-store.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getOriginClientId,
  publishDocumentsChanged,
} from "../sync/resource-sync-events.js";
import { renderMarkdownToPDF } from "./document-pdf-renderer.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { RouteResponse } from "./types.js";

const log = getLogger("documents-routes");

/** The document payload shape returned by `GET documents/{id}`. */
const documentPayloadSchema = z.object({
  success: z.boolean(),
  surfaceId: z.string(),
  conversationId: z.string(),
  title: z.string(),
  content: z.string(),
  wordCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z
    .number()
    .optional()
    .describe(
      "Bumped by one on every write. Absent from assistants that predate document revisions.",
    ),
});

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
          revision: z
            .number()
            .optional()
            .describe(
              "Bumped by one on every write. Absent from assistants that predate document revisions.",
            ),
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
    responseBody: documentPayloadSchema,
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
    description:
      "Create or upsert a document (by surfaceId). With `baseRevision`, an existing document is only overwritten while its revision still equals `baseRevision`; otherwise the save is rejected with 409 CONFLICT and `error.details` carries the current `revision`, `title`, and `content`.",
    tags: ["documents"],
    requestBody: z.object({
      surfaceId: z.string().describe("Surface ID (unique key)"),
      conversationId: z.string().describe("Owning conversation"),
      title: z.string().describe("Document title"),
      content: z.string().describe("Document content"),
      wordCount: z.number().describe("Word count"),
      baseRevision: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "The revision this save was edited from. When set and the stored revision differs, nothing is written and the request fails with 409. Omit for an unconditional write.",
        ),
    }),
    responseBody: z.object({
      success: z.literal(true),
      surfaceId: z.string(),
      revision: z
        .number()
        .optional()
        .describe(
          "The document's revision after the save. Absent from assistants that predate document revisions.",
        ),
    }),
    handler: ({ body, headers }) => {
      const {
        surfaceId,
        conversationId,
        title,
        content,
        wordCount,
        baseRevision,
      } = (body ?? {}) as {
        surfaceId?: string;
        conversationId?: string;
        title?: string;
        content?: string;
        wordCount?: number;
        baseRevision?: number | null;
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
      if (
        baseRevision != null &&
        (!Number.isInteger(baseRevision) || baseRevision < 0)
      ) {
        throw new BadRequestError(
          "baseRevision must be a non-negative integer",
        );
      }

      const result = saveDocument({
        surfaceId,
        conversationId,
        title,
        content,
        wordCount,
        baseRevision: baseRevision ?? undefined,
      });

      if (!result.success) {
        if (result.conflict) {
          throw new ConflictError(result.error, result.conflict);
        }
        throw new InternalError(result.error);
      }
      // Every save moves `updated_at`, which both document lists order by and
      // the Library renders next to the word count, so a content-only save
      // changes what the list surfaces show. The publish coalesces, which
      // bounds the web editor's per-keystroke autosave to one broadcast per
      // second, and the saving client suppresses its own echo by origin id.
      publishDocumentsChanged(getOriginClientId(headers));
      return result;
    },
  },

  {
    operationId: "createDocument",
    endpoint: "documents/create",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a document",
    description:
      "Create an empty document owned by a conversation and return it with its new surface ID.",
    tags: ["documents"],
    requestBody: z.object({
      conversationId: z.string().describe("Owning conversation"),
      title: z
        .string()
        .optional()
        .describe(`Document title. Defaults to "${DEFAULT_DOCUMENT_TITLE}".`),
    }),
    responseBody: documentPayloadSchema,
    handler: ({ body, headers }) => {
      const { conversationId, title } = (body ?? {}) as {
        conversationId?: string;
        title?: string;
      };
      if (!conversationId || typeof conversationId !== "string") {
        throw new BadRequestError("conversationId is required");
      }
      if (title !== undefined && typeof title !== "string") {
        throw new BadRequestError("title must be a string");
      }
      if (!getConversation(conversationId)) {
        throw new NotFoundError("Conversation not found");
      }

      const result = createDocument({ conversationId, title: title?.trim() });
      if (!result.success) {
        throw new InternalError(result.error);
      }
      const doc = getDocumentById(result.surfaceId);
      if (!doc) {
        throw new InternalError("Created document could not be read back");
      }
      publishDocumentsChanged(getOriginClientId(headers));
      return { success: true, ...doc };
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
      // No origin client id: the only caller, `document-viewer-page`, links the
      // document and then navigates to the conversation whose assets pill must
      // now list it, without invalidating anything itself. Suppressing its own
      // echo would land it on a conversation whose pill is missing the document
      // it just linked.
      publishDocumentsChanged();
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
