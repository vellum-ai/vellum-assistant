import { randomUUID } from "node:crypto";

import {
  deleteDocument,
  getDocumentById,
  getDocumentsForConversation,
  isDocumentAssociatedWithConversation,
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

function documentNotFound(surfaceId: string): ToolExecutionResult {
  return {
    content: JSON.stringify({
      success: false,
      surface_id: surfaceId,
      error: "Document not found",
    }),
    isError: true,
  };
}

function canAccessDocument(surfaceId: string, context: ToolContext): boolean {
  return (
    isPrivilegedDocumentActor(context) ||
    isDocumentAssociatedWithConversation(surfaceId, context.conversationId)
  );
}

// ── Exported execute functions ──────────────────────────────────────

export function executeDocumentCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const title = (input.title as string | undefined) || "Untitled Document";
  const initialContent = (input.initial_content as string | undefined) || "";
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
  const surfaceId = input.surface_id as string;
  const content = input.content as string;
  const mode = (input.mode as string | undefined) || "append";

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
  const surfaceId = input.surface_id as string;
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
  const surfaceId = input.surface_id as string;
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
