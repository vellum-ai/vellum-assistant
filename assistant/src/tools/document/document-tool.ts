import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  addDocumentConversation,
  deleteDocument,
  findInDocument,
  findRecentEmptyDocumentByTitle,
  getDocumentById,
  getDocumentsForConversation,
  isDocumentAssociatedWithConversation,
  replaceInDocument,
  saveDocument,
  searchDocumentsByTitle,
  updateDocumentContent,
} from "../../documents/document-store.js";
import { canActOnPrivilegedDocuments } from "../../runtime/effective-capabilities.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function isPrivilegedDocumentActor(context: ToolContext): boolean {
  return canActOnPrivilegedDocuments(context);
}

export function documentNotFound(surfaceId: string): ToolExecutionResult {
  return {
    content: JSON.stringify({
      success: false,
      surface_id: surfaceId,
      error: "Document not found",
    }),
    isError: true,
  };
}

export function canAccessDocument(
  surfaceId: string,
  context: ToolContext,
): boolean {
  return (
    isPrivilegedDocumentActor(context) ||
    isDocumentAssociatedWithConversation(surfaceId, context.conversationId)
  );
}

function invalidInput(message: string): ToolExecutionResult {
  return {
    content: JSON.stringify({
      success: false,
      error: `Invalid input: ${message}`,
    }),
    isError: true,
  };
}

/**
 * Render a failed parse in the document family's JSON error shape. Every
 * schema field below carries a custom message that names the field, so the
 * joined issue list reads the same as the imperative checks it replaced.
 */
export function invalidInputFromZod(error: z.ZodError): ToolExecutionResult {
  return invalidInput(error.issues.map((issue) => issue.message).join("; "));
}

/**
 * `surface_id` for the tools that require one — a non-empty (after trim)
 * string, matching the check the executors have always applied.
 */
export const surfaceIdSchema = z
  .string({ message: "surface_id is required and must be a non-empty string" })
  .refine((s) => s.trim() !== "", {
    message: "surface_id is required and must be a non-empty string",
  });

/**
 * `activity` is status-only and never read by these executors, so a
 * malformed value degrades instead of failing the call.
 */
const activityField = z.string().optional().catch(undefined);

export const documentOpenInputSchema = z.looseObject({
  surface_id: surfaceIdSchema,
  activity: activityField,
});

export const documentCreateInputSchema = z.looseObject({
  title: z.string({ message: "title must be a string" }).nullish(),
  initial_content: z
    .string({ message: "initial_content must be a string" })
    .nullish(),
  activity: activityField,
});

/**
 * `surface_id` catches to `undefined` because document_update has always
 * treated a malformed value as absent and fallen back to the conversation's
 * most recent document (see {@link resolveUpdateSurfaceId}).
 */
export const documentUpdateInputSchema = z.looseObject({
  surface_id: z.string().nullish().catch(undefined),
  content: z.string({ message: "content is required and must be a string" }),
  mode: z
    .enum(["replace", "append"], {
      message: 'mode must be "replace" or "append"',
    })
    .nullish(),
  activity: activityField,
});

export const documentReadInputSchema = z.looseObject({
  surface_id: surfaceIdSchema,
  activity: activityField,
});

/**
 * `query` catches to `undefined` because document_list has always ignored a
 * malformed query and listed the conversation's documents instead.
 */
export const documentListInputSchema = z.looseObject({
  query: z.string().nullish().catch(undefined),
  activity: activityField,
});

export const documentDeleteInputSchema = z.looseObject({
  surface_id: surfaceIdSchema,
  activity: activityField,
});

export const documentFindInputSchema = z.looseObject({
  surface_id: surfaceIdSchema,
  query: z.string({ message: "query is required and must be a string" }),
  regex: z.boolean({ message: "regex must be a boolean" }).nullish(),
  case_sensitive: z
    .boolean({ message: "case_sensitive must be a boolean" })
    .nullish(),
  activity: activityField,
});

export const documentReplaceTextInputSchema = z.looseObject({
  surface_id: surfaceIdSchema,
  find: z.string({ message: "find is required and must be a string" }),
  replace: z.string({ message: "replace must be a string" }).nullish(),
  regex: z.boolean({ message: "regex must be a boolean" }).nullish(),
  case_sensitive: z
    .boolean({ message: "case_sensitive must be a boolean" })
    .nullish(),
  max_replacements: z
    .number({ message: "max_replacements must be a number" })
    .nullish(),
  activity: activityField,
});

// ── Exported execute functions ──────────────────────────────────────

export function executeDocumentOpen(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentOpenInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceId = parsed.data.surface_id;
  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const doc = getDocumentById(surfaceId);
  if (!doc) {
    return documentNotFound(surfaceId);
  }

  if (context.sendToClient) {
    context.sendToClient({
      type: "document_editor_show",
      conversationId: context.conversationId,
      surfaceId: doc.surfaceId,
      title: doc.title,
      initialContent: doc.content,
    });

    context.sendToClient({
      type: "ui_surface_show",
      conversationId: context.conversationId,
      surfaceId: `preview-${doc.surfaceId}`,
      surfaceType: "document_preview",
      display: "inline",
      title: doc.title,
      data: {
        title: doc.title,
        surfaceId: doc.surfaceId,
        subtitle: "Document",
      },
    });

    return {
      content: JSON.stringify({
        success: true,
        surface_id: doc.surfaceId,
        title: doc.title,
        word_count: doc.wordCount,
        message: "Document editor opened",
      }),
      isError: false,
    };
  }

  return {
    content: JSON.stringify({
      success: false,
      surface_id: surfaceId,
      error: "No client connected to open document editor",
    }),
    isError: true,
  };
}

const EMPTY_DOCUMENT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * If the model just created an empty same-title document in this conversation
 * and is now creating a second one with real content, reuse the first row
 * instead of producing a duplicate. Returns `null` when no dedupe applies.
 *
 * Only triggers when `initialContent` is non-empty — an empty incoming create
 * likely means the model intends a fresh blank doc.
 */
function maybeReuseEmptyDocument(
  title: string,
  initialContent: string,
  context: ToolContext,
): ToolExecutionResult | null {
  if (initialContent.length === 0) return null;
  const existing = findRecentEmptyDocumentByTitle(
    context.conversationId,
    title,
    EMPTY_DOCUMENT_DEDUPE_WINDOW_MS,
  );
  if (!existing) return null;

  const surfaceId = existing.surfaceId;
  const update = updateDocumentContent(surfaceId, initialContent, "replace");
  if (!update.success) return null;

  // Defensive idempotent insert (saveDocument from the create-new path already
  // ran addDocumentConversation; INSERT OR IGNORE makes this a safe no-op).
  addDocumentConversation(surfaceId, context.conversationId);

  if (context.sendToClient) {
    // Use document_editor_update — not document_editor_show — because the
    // empty draft is typically still OPEN on the macOS client. A *_show on an
    // open doc triggers DocumentManager.closeDocument() → async save() of the
    // OLD (empty) content, clobbering the initialContent we just persisted.
    context.sendToClient({
      type: "document_editor_update",
      conversationId: context.conversationId,
      surfaceId,
      markdown: initialContent,
      mode: "replace",
    });

    context.sendToClient({
      type: "ui_surface_show",
      conversationId: context.conversationId,
      surfaceId: `preview-${surfaceId}`,
      surfaceType: "document_preview",
      display: "inline",
      title,
      data: {
        title,
        surfaceId,
        subtitle: "Document",
      },
    });
  }

  return {
    content: JSON.stringify({
      surface_id: surfaceId,
      title,
      opened: context.sendToClient != null,
      reused: true,
      message: "Document editor reopened (deduped empty draft)",
    }),
    isError: false,
  };
}

export function executeDocumentCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentCreateInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const title = parsed.data.title || "Untitled Document";
  const initialContent = parsed.data.initial_content || "";

  const reused = maybeReuseEmptyDocument(title, initialContent, context);
  if (reused) return reused;

  const surfaceId = `doc-${randomUUID()}`;

  // Persist the document so any client (web or macOS) can fetch it via
  // GET /v1/documents/:id. The macOS client may later update the row
  // via document_save; ON CONFLICT DO UPDATE handles that.
  const wordCount = initialContent
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  saveDocument({
    surfaceId,
    conversationId: context.conversationId,
    title,
    content: initialContent,
    wordCount,
  });

  // Send document_editor_show message to open the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: "document_editor_show",
      conversationId: context.conversationId,
      surfaceId,
      title,
      initialContent,
    });

    context.sendToClient({
      type: "ui_surface_show",
      conversationId: context.conversationId,
      surfaceId: `preview-${surfaceId}`,
      surfaceType: "document_preview",
      display: "inline",
      title,
      data: {
        title,
        surfaceId,
        subtitle: "Document",
      },
    });

    return {
      content: JSON.stringify({
        surface_id: surfaceId,
        title,
        opened: true,
        message: "Document editor opened in Directory panel",
      }),
      isError: false,
    };
  }

  // Fallback if no client is connected
  return {
    content: JSON.stringify({
      surface_id: surfaceId,
      title,
      opened: false,
      error: "No client connected to open document editor",
    }),
    isError: false,
  };
}

/**
 * Resolve the target document for an update. An explicit `surface_id` is used
 * verbatim; when absent, the update targets the conversation's most recently
 * updated document (`getDocumentsForConversation` orders by `updated_at DESC`),
 * which is the document being streamed into. This lets a model stream chunks
 * with only `content` instead of threading the opaque `surface_id` back through
 * every call — a step weak models routinely drop, leaving the document stuck on
 * its first chunk.
 */
function resolveUpdateSurfaceId(
  surfaceId: string | null | undefined,
  context: ToolContext,
): ToolExecutionResult | string {
  if (typeof surfaceId === "string" && surfaceId.trim() !== "") {
    return surfaceId;
  }
  const docs = getDocumentsForConversation(context.conversationId);
  if (docs.length === 0) {
    return invalidInput(
      "surface_id is required: no document is open in this conversation. Call document_create first.",
    );
  }
  return docs[0].surfaceId;
}

export function executeDocumentUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  // `mode` is nullish in the schema to match validateInputAgainstSchema,
  // which treats null as "absent" for enum checks — { mode: null } must fall
  // through to the access check, not reject. The `?? "append"` below handles
  // null.
  const parsed = documentUpdateInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceIdOrError = resolveUpdateSurfaceId(
    parsed.data.surface_id,
    context,
  );
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
  const content = parsed.data.content;
  const mode = parsed.data.mode ?? "append";

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const result = updateDocumentContent(surfaceId, content, mode);
  if (!result.success) {
    return {
      content: JSON.stringify({
        success: false,
        surface_id: surfaceId,
        error: result.error,
      }),
      isError: true,
    };
  }

  // Send document_editor_update message to update the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: "document_editor_update",
      conversationId: context.conversationId,
      surfaceId,
      markdown: content,
      mode,
    });

    return {
      content: JSON.stringify({
        success: true,
        surface_id: surfaceId,
        mode,
        message: "Document content updated",
      }),
      isError: false,
    };
  }

  // Fallback if no client is connected
  return {
    content: JSON.stringify({
      success: false,
      error: "No client connected to update document",
    }),
    isError: true,
  };
}

export function executeDocumentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentReadInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceId = parsed.data.surface_id;
  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const doc = getDocumentById(surfaceId);
  if (!doc) {
    return documentNotFound(surfaceId);
  }
  return {
    content: JSON.stringify({
      success: true,
      surface_id: doc.surfaceId,
      title: doc.title,
      content: doc.content,
      word_count: doc.wordCount,
      updated_at: doc.updatedAt,
    }),
    isError: false,
  };
}

export function executeDocumentList(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentListInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const query = parsed.data.query?.trim() || undefined;
  const docs = query
    ? searchDocumentsByTitle(
        query,
        isPrivilegedDocumentActor(context)
          ? {}
          : { conversationId: context.conversationId },
      )
    : getDocumentsForConversation(context.conversationId);
  return {
    content: JSON.stringify({
      success: true,
      documents: docs.map((d) => ({
        surface_id: d.surfaceId,
        title: d.title,
        word_count: d.wordCount,
        created_at: d.createdAt,
        updated_at: d.updatedAt,
      })),
    }),
    isError: false,
  };
}

export function executeDocumentDelete(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentDeleteInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceId = parsed.data.surface_id;
  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const deleted = deleteDocument(surfaceId);
  if (!deleted) {
    return documentNotFound(surfaceId);
  }
  return {
    content: JSON.stringify({
      success: true,
      surface_id: surfaceId,
      message: "Document deleted",
    }),
    isError: false,
  };
}

export function executeDocumentFind(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentFindInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceId = parsed.data.surface_id;
  const query = parsed.data.query;
  const regex = parsed.data.regex ?? false;
  const caseSensitive = parsed.data.case_sensitive ?? false;

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  if (regex) {
    try {
      new RegExp(query);
    } catch (e) {
      return {
        content: JSON.stringify({
          success: false,
          surface_id: surfaceId,
          error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
        }),
        isError: true,
      };
    }
  }

  const result = findInDocument(surfaceId, query, { regex, caseSensitive });
  if (!result) {
    return documentNotFound(surfaceId);
  }

  return {
    content: JSON.stringify({
      success: true,
      surface_id: result.surfaceId,
      query,
      total_matches: result.totalMatches,
      matches: result.matches.map((m) => ({
        line_number: m.lineNumber,
        line_content: m.lineContent,
        match_start: m.matchStart,
        match_end: m.matchEnd,
        match_text: m.matchText,
      })),
    }),
    isError: false,
  };
}

export function executeDocumentReplaceText(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsed = documentReplaceTextInputSchema.safeParse(input);
  if (!parsed.success) return invalidInputFromZod(parsed.error);
  const surfaceId = parsed.data.surface_id;
  const find = parsed.data.find;
  const replace = parsed.data.replace ?? "";
  const regex = parsed.data.regex ?? false;
  const caseSensitive = parsed.data.case_sensitive ?? false;
  const maxReplacements = parsed.data.max_replacements ?? undefined;

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  if (regex) {
    try {
      new RegExp(find);
    } catch (err) {
      return {
        content: JSON.stringify({
          success: false,
          error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        }),
        isError: true,
      };
    }
  }

  const result = replaceInDocument(surfaceId, find, replace, {
    regex,
    caseSensitive,
    maxReplacements,
  });

  if (!result.success) {
    return {
      content: JSON.stringify({
        success: false,
        surface_id: surfaceId,
        error: result.error,
      }),
      isError: true,
    };
  }

  if (context.sendToClient && result.content_changed) {
    const doc = getDocumentById(surfaceId);
    if (doc) {
      context.sendToClient({
        type: "document_editor_update",
        conversationId: context.conversationId,
        surfaceId,
        markdown: doc.content,
        mode: "replace",
      });
    }
  }

  return {
    content: JSON.stringify({
      success: true,
      surface_id: surfaceId,
      replacements_made: result.replacements_made,
      content_changed: result.content_changed,
    }),
    isError: false,
  };
}
