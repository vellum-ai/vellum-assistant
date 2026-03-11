import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { createDraftRaw } from "../../../../messaging/providers/gmail/client.js";
import { buildMultipartMime } from "../../../../messaging/providers/gmail/mime-builder.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
};

function guessMimeType(filePath: string): string {
  return (
    MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const attachmentPaths = input.attachment_paths as string[];
  const inReplyTo = input.in_reply_to as string | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!to) return err("to is required.");
  if (!subject) return err("subject is required.");
  if (!body) return err("body is required.");
  if (!attachmentPaths?.length)
    return err("attachment_paths is required and must not be empty.");

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const attachments = await Promise.all(
        attachmentPaths.map(async (filePath) => {
          const data = await readFile(filePath);
          const filename = basename(filePath);
          const mimeType = guessMimeType(filePath);
          return { filename, mimeType, data };
        }),
      );

      const raw = buildMultipartMime({
        to,
        subject,
        body,
        inReplyTo,
        attachments,
      });
      const draft = await createDraftRaw(token, raw, threadId);

      const filenames = attachments.map((a) => a.filename).join(", ");
      return ok(
        `Gmail draft created with ${attachments.length} attachment(s): ${filenames} (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
      );
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
