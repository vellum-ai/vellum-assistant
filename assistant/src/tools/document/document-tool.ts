import { randomUUID } from "node:crypto";

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
import type { ToolContext, ToolExecutionResult } from "../types.js";

function isPrivilegedDocumentActor(context: ToolContext): boolean {
  return (
    context.trustClass === "guardian" || context.executionChannel === "vellum"
  );
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

function validateSurfaceId(
  input: Record<string, unknown>,
): ToolExecutionResult | string {
  if (typeof input.surface_id !== "string" || input.surface_id.trim() === "") {
    return invalidInput(
      "surface_id is required and must be a non-empty string",
    );
  }
  return input.surface_id;
}

// ── Exported execute functions ──────────────────────────────────────

export function executeDocumentOpen(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
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
  const title = (input.title as string | undefined) || "Untitled Document";
  const initialContent = (input.initial_content as string | undefined) || "";

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

export function executeDocumentUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
  if (typeof input.content !== "string") {
    return invalidInput("content is required and must be a string");
  }
  // Loose `!= null` to match validateInputAgainstSchema, which treats null as
  // "absent" for enum checks — without this, { mode: null } passes the
  // factory validator but rejects here. The `?? "append"` below handles null.
  if (
    input.mode != null &&
    input.mode !== "replace" &&
    input.mode !== "append"
  ) {
    return invalidInput('mode must be "replace" or "append"');
  }
  const content = input.content;
  const mode = (input.mode as "replace" | "append" | undefined) ?? "append";

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
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
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
  const query =
    typeof input.query === "string" && input.query.trim().length > 0
      ? input.query.trim()
      : undefined;
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
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
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
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
  const query = input.query as string;
  const regex = (input.regex as boolean | undefined) ?? false;
  const caseSensitive = (input.case_sensitive as boolean | undefined) ?? false;

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
  const surfaceIdOrError = validateSurfaceId(input);
  if (typeof surfaceIdOrError !== "string") return surfaceIdOrError;
  const surfaceId = surfaceIdOrError;
  const find = input.find as string;
  const replace = (input.replace as string) ?? "";
  const regex = (input.regex as boolean | undefined) ?? false;
  const caseSensitive = (input.case_sensitive as boolean | undefined) ?? false;
  const maxReplacements = input.max_replacements as number | undefined;

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
