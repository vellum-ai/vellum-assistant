import { getMessage } from "../../../../messaging/providers/gmail/client.js";
import type { GmailMessagePart } from "../../../../messaging/providers/gmail/types.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
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
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;

  if (!messageId) {
    return err("message_id is required.");
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const message = await getMessage(token, messageId, "full");
      const attachments = collectAttachments(message.payload?.parts);

      if (attachments.length === 0) {
        return ok("No attachments found on this message.");
      }

      return ok(JSON.stringify(attachments, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
