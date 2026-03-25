import {
  createDraftRaw,
  getAttachment,
  getMessage,
} from "../../../../messaging/providers/gmail/client.js";
import { buildMultipartMime } from "../../../../messaging/providers/gmail/mime-builder.js";
import type { GmailMessagePart } from "../../../../messaging/providers/gmail/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function extractHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function extractPlainTextBody(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(
      part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractPlainTextBody(child);
      if (text) return text;
    }
  }
  return "";
}

interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
}

function collectAttachmentRefs(
  parts: GmailMessagePart[] | undefined,
): AttachmentRef[] {
  if (!parts) return [];
  const result: AttachmentRef[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      result.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
      });
    }
    if (part.parts) result.push(...collectAttachmentRefs(part.parts));
  }
  return result;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const messageId = input.message_id as string;
  const forwardTo = input.to as string;
  const additionalText = input.text as string | undefined;

  if (!messageId) return err("message_id is required.");
  if (!forwardTo) return err("to is required.");

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });
    const message = await getMessage(connection, messageId, "full");
    const headers = message.payload?.headers ?? [];
    const originalFrom = extractHeader(headers, "From");
    const originalDate = extractHeader(headers, "Date");
    const originalSubject = extractHeader(headers, "Subject");
    const originalBody = extractPlainTextBody(message.payload);

    const forwardHeader = [
      additionalText ? `${additionalText}\n\n` : "",
      "---------- Forwarded message ----------",
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `Subject: ${originalSubject}`,
      "",
      originalBody,
    ].join("\n");

    const subject = originalSubject.startsWith("Fwd:")
      ? originalSubject
      : `Fwd: ${originalSubject}`;

    // Collect and download attachments from the original message
    const attachmentRefs = collectAttachmentRefs(message.payload?.parts);
    const attachments = await Promise.all(
      attachmentRefs.map(async (ref) => {
        const att = await getAttachment(
          connection,
          messageId,
          ref.attachmentId,
        );
        const data = Buffer.from(
          att.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
        );
        return { filename: ref.filename, mimeType: ref.mimeType, data };
      }),
    );

    if (attachments.length > 0) {
      const raw = buildMultipartMime({
        to: forwardTo,
        subject,
        body: forwardHeader,
        attachments,
      });
      const draft = await createDraftRaw(connection, raw);
      return ok(
        `Forward draft created to ${forwardTo} with ${attachments.length} attachment(s) (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
      );
    }

    const raw = buildMultipartMime({
      to: forwardTo,
      subject,
      body: forwardHeader,
      attachments: [],
    });
    const draft = await createDraftRaw(connection, raw);
    return ok(
      `Forward draft created to ${forwardTo} (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
