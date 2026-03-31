import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  getAttachment,
  listAttachments,
} from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;
  const messageId = input.message_id as string;

  if (!action) return err("action is required.");
  if (!messageId) return err("message_id is required.");

  if (action === "list") {
    try {
      const connection = await resolveOAuthConnection("outlook", {
        account,
      });
      const response = await listAttachments(connection, messageId);
      const attachments = response.value ?? [];

      if (attachments.length === 0) {
        return ok("No attachments found on this message.");
      }

      const result = attachments.map((a) => ({
        attachmentId: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        isInline: a.isInline,
      }));

      return ok(JSON.stringify(result, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  if (action === "download") {
    const attachmentId = input.attachment_id as string;

    if (!attachmentId) return err("attachment_id is required for download.");

    try {
      const connection = await resolveOAuthConnection("outlook", {
        account,
      });
      const attachment = await getAttachment(
        connection,
        messageId,
        attachmentId,
      );

      // Outlook returns standard base64 in contentBytes
      const buffer = Buffer.from(attachment.contentBytes, "base64");

      const outputDir = context.workingDir ?? process.cwd();
      // Sanitize filename: strip path separators to prevent traversal attacks
      const safeName = basename(attachment.name).replace(/\.\./g, "_");
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
