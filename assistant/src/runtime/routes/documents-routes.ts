/**
 * Route handlers for document persistence operations.
 *
 * Exposes document CRUD over HTTP, sharing business logic with the
 * handlers in `daemon/handlers/documents.ts`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { z } from "zod";

import {
  addDocumentConversation,
  createFileBackedDocument,
  getDocumentById,
  getDocumentByWorkspacePath,
  getDocumentsForConversation,
  isDocumentAssociatedWithConversation,
  refreshDocumentContentFromFile,
  saveDocument,
} from "../../documents/document-store.js";
import { rawAll } from "../../persistence/raw-query.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getOriginClientId,
  publishDocumentsChanged,
} from "../sync/resource-sync-events.js";
import { renderMarkdownToPDF } from "./document-pdf-renderer.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "./workspace-utils.js";

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
// File-backed documents
// ---------------------------------------------------------------------------

/** Extensions the document editor round-trips faithfully as markdown. */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/** The document payload shape shared by `GET documents/{id}` and its siblings. */
const documentPayloadSchema = z.object({
  success: z.boolean(),
  surfaceId: z.string(),
  conversationId: z.string(),
  title: z.string(),
  content: z.string(),
  wordCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  workspacePath: z
    .string()
    .nullable()
    .describe("Workspace-relative file this document is bound to, or null"),
});

/**
 * Resolve a client-supplied workspace path to the markdown file it names.
 *
 * Uses the same resolution as the workspace file routes, so a path that
 * escapes the workspace (traversal, absolute, symlinked out, dot-segment) is
 * rejected here exactly as it would be there.
 */
function resolveWorkspaceMarkdownFile(path: string): {
  absolutePath: string;
  relativePath: string;
} {
  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  if (!MARKDOWN_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    throw new UnprocessableEntityError(
      "Only markdown files (.md, .markdown) can back a document",
    );
  }

  return {
    absolutePath: resolved,
    relativePath: toWorkspaceRelativePath(resolved),
  };
}

/** Current text of a workspace file, or `null` when it is gone or not a file. */
function readWorkspaceFileText(absolutePath: string): string | null {
  try {
    if (!statSync(absolutePath).isFile()) {
      return null;
    }
    return readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

/** Load a document by surface ID for a response, or fail loudly if it vanished. */
function loadDocumentPayload(surfaceId: string): Record<string, unknown> {
  const doc = getDocumentById(surfaceId);
  if (!doc) {
    throw new InternalError("Document could not be loaded after persisting");
  }
  return { success: true, ...doc };
}

/**
 * Find or create the document bound to a workspace markdown file.
 *
 * The file is the source of truth at open time: when a bound document's stored
 * content has drifted from the bytes on disk (the file was edited outside the
 * editor), the row is refreshed from the file before it is returned. Writes go
 * the other way — the document store writes through to the file.
 *
 * The publishes here carry no origin client id on purpose. The only caller,
 * `viewer-store.loadWorkspaceFileDocument`, opens the file and never
 * invalidates its own document queries, so the client that creates the row is
 * the one that most needs to hear about it: suppressing its own echo would
 * leave its assets pill and Library without the document it just opened.
 */
function handleDocumentForWorkspaceFile({
  body,
}: RouteHandlerArgs): Record<string, unknown> {
  const { path, conversationId } = (body ?? {}) as {
    path?: string;
    conversationId?: string;
  };

  if (!path || typeof path !== "string") {
    throw new BadRequestError("path is required");
  }
  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }

  const { absolutePath, relativePath } = resolveWorkspaceMarkdownFile(path);
  const existing = getDocumentByWorkspacePath(relativePath);
  const fileText = readWorkspaceFileText(absolutePath);

  if (fileText === null) {
    // A bound document whose file is gone is reported distinctly: the client
    // needs to tell "this file was deleted" apart from "no such file", and the
    // document must never be used to resurrect the file.
    if (existing) {
      throw new NotFoundError(
        `The file backing this document no longer exists: ${relativePath}`,
      );
    }
    throw new NotFoundError("File not found");
  }

  if (existing) {
    // Opening the file from another conversation grants that conversation
    // access, the same association the link route writes.
    const alreadyLinked = isDocumentAssociatedWithConversation(
      existing.surfaceId,
      conversationId,
    );
    addDocumentConversation(existing.surfaceId, conversationId);

    let refreshed = false;
    if (existing.content !== fileText) {
      const refresh = refreshDocumentContentFromFile(
        existing.surfaceId,
        fileText,
      );
      if (!refresh.success) {
        throw new InternalError(refresh.error);
      }
      refreshed = true;
      log.info(
        { surfaceId: existing.surfaceId, workspacePath: relativePath },
        "Refreshed file-backed document from disk",
      );
    }

    // Reopening an unchanged, already-linked file writes nothing, so it must
    // not invalidate every client's document list on each open.
    if (!alreadyLinked || refreshed) {
      publishDocumentsChanged();
    }
    return loadDocumentPayload(existing.surfaceId);
  }

  const surfaceId = `doc-${randomUUID()}`;
  const created = createFileBackedDocument({
    surfaceId,
    conversationId,
    title: basename(relativePath),
    content: fileText,
    workspacePath: relativePath,
  });

  if (!created.success) {
    // A concurrent request may have won the unique index on workspace_path.
    const raced = getDocumentByWorkspacePath(relativePath);
    if (!raced) {
      throw new InternalError(created.error);
    }
    const racedAlreadyLinked = isDocumentAssociatedWithConversation(
      raced.surfaceId,
      conversationId,
    );
    addDocumentConversation(raced.surfaceId, conversationId);
    if (!racedAlreadyLinked) {
      publishDocumentsChanged();
    }
    return loadDocumentPayload(raced.surfaceId);
  }

  log.info(
    { surfaceId, workspacePath: relativePath, conversationId },
    "Bound workspace file to a new document",
  );
  publishDocumentsChanged();
  return loadDocumentPayload(surfaceId);
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
    handler: ({ body, headers }) => {
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
    operationId: "documentForWorkspaceFile",
    endpoint: "documents/for-workspace-file",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get or create the document for a workspace markdown file",
    description:
      "Return the document bound to a workspace markdown file, creating it on " +
      "first open. The file is the source of truth at open time: stored " +
      "content that has drifted from the file is refreshed from disk before " +
      "the document is returned.",
    tags: ["documents"],
    requestBody: z.object({
      path: z
        .string()
        .describe("Workspace-relative path to a .md/.markdown file"),
      conversationId: z
        .string()
        .describe("Conversation the document is opened from"),
    }),
    responseBody: documentPayloadSchema,
    additionalResponses: {
      "422": { description: "Path is not a markdown file" },
    },
    handler: handleDocumentForWorkspaceFile,
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
