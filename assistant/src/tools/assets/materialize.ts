/**
 * asset_materialize — write a stored attachment to a sandbox file path.
 *
 * Accepts an attachment ID (from asset_search) and a destination path
 * within the sandbox working directory. Decodes the base64 content and
 * writes it to disk so scripts and other tools can consume it as a
 * regular file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { eq } from "drizzle-orm";

import {
  type AttachmentContext,
  isAttachmentVisible,
} from "../../daemon/media-visibility-policy.js";
import { getConversationType } from "../../memory/conversation-crud.js";
import { getDb } from "../../memory/db.js";
import { attachments } from "../../memory/schema.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { getAttachmentSourceConversations } from "./search.js";

// ---------------------------------------------------------------------------
// Size limit — prevent materializing excessively large attachments
// ---------------------------------------------------------------------------

/** 50 MB ceiling for materialized files. */
export const MAX_MATERIALIZE_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Load an attachment row (including base64 data) by its primary key.
 *
 * Not scoped by assistantId because attachment access is enforced by
 * conversation visibility checks in execute().
 */
function loadAttachmentById(attachmentId: string): {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
} | null {
  const db = getDb();
  const row = db
    .select({
      id: attachments.id,
      originalFilename: attachments.originalFilename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      dataBase64: attachments.dataBase64,
    })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const definition: ToolDefinition = {
  name: "asset_materialize",
  description:
    "Copy a stored attachment to a file on disk inside the sandbox directory. " +
    "Use attachment IDs from asset_search results. The file can then be used " +
    "as input to scripts, tools, or other processing.",
  input_schema: {
    type: "object",
    properties: {
      attachment_id: {
        type: "string",
        description:
          "The ID of the attachment to materialize (from asset_search results).",
      },
      destination_path: {
        type: "string",
        description:
          "Path where the file should be written, relative to (or inside) the sandbox working directory.",
      },
    },
    required: ["attachment_id", "destination_path"],
  },
};

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

class AssetMaterializeTool implements Tool {
  name = "asset_materialize";
  description = definition.description;
  category = "assets";
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const attachmentId = input.attachment_id as string | undefined;
    const destinationPath = input.destination_path as string | undefined;

    // --- Input validation ---------------------------------------------------

    if (!attachmentId || typeof attachmentId !== "string") {
      return {
        content: "Error: attachment_id is required and must be a string.",
        isError: true,
      };
    }

    if (!destinationPath || typeof destinationPath !== "string") {
      return {
        content: "Error: destination_path is required and must be a string.",
        isError: true,
      };
    }

    // --- Sandbox path enforcement -------------------------------------------

    const pathCheck = sandboxPolicy(destinationPath, context.workingDir, {
      mustExist: false,
    });
    if (!pathCheck.ok) {
      return {
        content: `Error: ${pathCheck.error}`,
        isError: true,
      };
    }

    const resolvedPath = pathCheck.resolved;

    // --- Load attachment ----------------------------------------------------

    const attachment = loadAttachmentById(attachmentId);
    if (!attachment) {
      return {
        content: `Error: Attachment "${attachmentId}" not found.`,
        isError: true,
      };
    }

    // --- Visibility check ---------------------------------------------------
    // Reject materialization of attachments from private conversations the caller
    // does not belong to. This prevents cross-conversation data leakage.

    const currentConversationType = getConversationType(context.conversationId);
    const currentContext: AttachmentContext = {
      conversationId: context.conversationId,
      isPrivate: currentConversationType === "private",
    };

    const sources = getAttachmentSourceConversations(attachmentId);
    if (sources.length > 0) {
      const hasStandard = sources.some((s) => s.conversationType !== "private");
      if (!hasStandard) {
        // All sources are private — check if the caller is in any of those conversations
        const callerInSourceConversation = sources.some((s) =>
          isAttachmentVisible(
            { conversationId: s.conversationId, isPrivate: true },
            currentContext,
          ),
        );
        if (!callerInSourceConversation) {
          return {
            content:
              `Error: Attachment "${attachment.originalFilename}" is from a private conversation ` +
              `and cannot be accessed from this context. You can only access this ` +
              `attachment from within the private conversation where it was shared.`,
            isError: true,
          };
        }
      }
    }

    // --- Size check ---------------------------------------------------------

    if (attachment.sizeBytes > MAX_MATERIALIZE_BYTES) {
      return {
        content:
          `Error: Attachment "${attachment.originalFilename}" is ${formatBytes(attachment.sizeBytes)}, ` +
          `which exceeds the ${formatBytes(MAX_MATERIALIZE_BYTES)} materialization limit.`,
        isError: true,
      };
    }

    // --- Decode and write ---------------------------------------------------

    try {
      const buffer = Buffer.from(attachment.dataBase64, "base64");

      // Ensure parent directories exist
      mkdirSync(dirname(resolvedPath), { recursive: true });

      writeFileSync(resolvedPath, buffer);

      return {
        content:
          `Materialized "${attachment.originalFilename}" (${attachment.mimeType}, ` +
          `${formatBytes(attachment.sizeBytes)}) to ${resolvedPath}`,
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${msg}`, isError: true };
    }
  }
}

export const assetMaterializeTool = new AssetMaterializeTool();

registerTool(assetMaterializeTool);
