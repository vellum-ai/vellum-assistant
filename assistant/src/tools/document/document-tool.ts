import { randomUUID } from "node:crypto";

import type { ToolContext, ToolExecutionResult } from "../types.js";

// ── Exported execute functions ──────────────────────────────────────

export function executeDocumentCreate(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const title = (input.title as string | undefined) || "Untitled Document";
  const initialContent = (input.initial_content as string | undefined) || "";
  const surfaceId = `doc-${randomUUID()}`;

  // Send document_editor_show IPC message to open the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: "document_editor_show",
      sessionId: context.sessionId,
      surfaceId,
      title,
      initialContent,
    });

    context.sendToClient({
      type: "ui_surface_show",
      sessionId: context.sessionId,
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

  // Fallback if no IPC client is connected
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

  // Send document_editor_update IPC message to update the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: "document_editor_update",
      sessionId: context.sessionId,
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

  // Fallback if no IPC client is connected
  return {
    content: JSON.stringify({
      success: false,
      error: "No client connected to update document",
    }),
    isError: true,
  };
}
