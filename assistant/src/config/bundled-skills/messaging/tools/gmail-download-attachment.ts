import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { getAttachment } from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;
  const attachmentId = input.attachment_id as string;
  const filename = input.filename as string;

  if (!messageId) return err("message_id is required.");
  if (!attachmentId) return err("attachment_id is required.");
  if (!filename) return err("filename is required.");

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const attachment = await getAttachment(token, messageId, attachmentId);

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
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
