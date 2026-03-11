import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  getAttachment,
  getMessage,
} from "../../../../messaging/providers/gmail/client.js";
import type { GmailMessagePart } from "../../../../messaging/providers/gmail/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** Recursively walk the MIME parts tree to find attachments. */
function collectAttachments(
  parts: GmailMessagePart[] | undefined,
): AttachmentInfo[] {
  if (!parts) return [];
  const result: AttachmentInfo[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      result.push({
        partId: part.partId ?? "",
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      result.push(...collectAttachments(part.parts));
    }
  }
  return result;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;
  const messageId = input.message_id as string;

  if (!action) return err("action is required.");
  if (!messageId) return err("message_id is required.");

  if (action === "list") {
    try {
      const connection = resolveOAuthConnection("integration:gmail");
      const message = await getMessage(connection, messageId, "full");
      const attachments = collectAttachments(message.payload?.parts);

      if (attachments.length === 0) {
        return ok("No attachments found on this message.");
      }

      return ok(JSON.stringify(attachments, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  if (action === "download") {
    const attachmentId = input.attachment_id as string;
    const filename = input.filename as string;

    if (!attachmentId) return err("attachment_id is required for download.");
    if (!filename) return err("filename is required for download.");

    try {
      const connection = resolveOAuthConnection("integration:gmail");
      const attachment = await getAttachment(
        connection,
        messageId,
        attachmentId,
      );

      // Gmail returns base64url; convert to standard base64 then to Buffer
      const base64 = attachment.data.replace(/-/g, "+").replace(/_/g, "/");
      const buffer = Buffer.from(base64, "base64");

      const outputDir = context.workingDir ?? process.cwd();
      // Sanitize filename: strip path separators to prevent traversal attacks from crafted MIME filenames
      const safeName = basename(filename).replace(/\.\./g, "_");
      const outputPath = resolve(outputDir, safeName);
      if (!outputPath.startsWith(outputDir))
        return err("Invalid filename: path traversal detected.");
      await writeFile(outputPath, buffer);

      return ok(`Attachment saved to ${outputPath} (${buffer.length} bytes).`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  return err(`Unknown action: ${action}. Expected "list" or "download".`);
}
