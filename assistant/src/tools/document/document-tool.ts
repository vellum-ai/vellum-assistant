import { randomUUID } from "node:crypto";

import {
  saveDocument,
  updateDocumentContent,
} from "../../documents/document-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

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

  updateDocumentContent(surfaceId, content, mode);

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
