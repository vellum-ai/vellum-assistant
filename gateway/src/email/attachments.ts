import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import {
  AttachmentValidationError,
  uploadAttachment,
} from "../runtime/client.js";
import type { EmailAttachment } from "./normalize.js";
import {
  type AttachmentIngestResult,
  type IngestibleAttachment,
  ingestAttachments,
  oversizedAttachmentNotice,
} from "../attachments/ingest.js";

/** The same accounting as the other channels' ingest: uploaded, rejected, or too large. */
export type EmailAttachmentIngestResult = AttachmentIngestResult;

/**
 * Estimate the decoded byte size of a base64 string without allocating the
 * decoded buffer. Every 4 base64 chars encode 3 bytes; trailing `=` padding
 * shortens the final group.
 */
function estimateBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Upload inline base64 email attachments to the assistant's attachment store
 * and return the resulting ids for forwarding to the runtime, which stores
 * them in the conversation workspace.
 *
 * Email is the one channel whose bytes arrive inline rather than behind a
 * URL, so its "download" is a lookup; everything else (the per-channel cap,
 * the bounded concurrency, the three-outcome accounting, and which failures
 * are skipped versus propagated so the upstream retries the delivery) is the
 * shared ingest, so a fix there is a fix here.
 */
export async function ingestEmailAttachments(
  config: GatewayConfig,
  attachments: EmailAttachment[] | undefined,
  log: Logger,
): Promise<EmailAttachmentIngestResult> {
  if (!attachments || attachments.length === 0) {
    return {
      attachmentIds: [],
      failedAttachmentNames: [],
      oversizedAttachments: [],
    };
  }

  const source = new Map<IngestibleAttachment, EmailAttachment>();
  const references = attachments.map((att, index) => {
    const reference: IngestibleAttachment = {
      fileId: att.contentId ?? `${index}:${att.filename}`,
      fileName: att.filename,
      mimeType: att.contentType,
      fileSize: att.size ?? estimateBase64Bytes(att.content),
    };
    source.set(reference, att);
    return reference;
  });

  return ingestAttachments(config, "email", references, log, {
    download: async (reference) => {
      const att = source.get(reference);
      if (!att) {
        throw new Error(`Email attachment ${reference.fileId} has no source`);
      }
      return {
        filename: att.filename,
        mimeType: att.contentType,
        data: att.content,
      };
    },
    upload: (downloaded) => uploadAttachment(config, downloaded),
    failurePolicy: {
      mode: "rethrow-unless-skippable",
      // A rejected type or extension skips that one attachment; anything else
      // (upload 5xx, network) propagates so the upstream retries the delivery.
      isSkippableError: (error) => error instanceof AttachmentValidationError,
    },
  });
}

/**
 * Append the notices for attachments the assistant did not receive. A
 * rejected attachment asks for a re-send; an oversized one names its size
 * and the cap in the same words every other channel uses, since re-sending
 * the same file cannot help. Returns the content unchanged when everything
 * arrived.
 */
export function appendFailedEmailAttachmentNotice(
  content: string,
  result: Pick<
    EmailAttachmentIngestResult,
    "failedAttachmentNames" | "oversizedAttachments"
  >,
): string {
  const notices: string[] = [];
  if (result.failedAttachmentNames.length > 0) {
    const nameList = result.failedAttachmentNames
      .map((n) => `"${n}"`)
      .join(", ");
    notices.push(
      `[The user attached file(s) that could not be processed: ${nameList}. Ask them to re-send if the content is important.]`,
    );
  }
  const oversized = oversizedAttachmentNotice(result.oversizedAttachments);
  if (oversized !== undefined) {
    notices.push(oversized);
  }
  if (notices.length === 0) {
    return content;
  }
  const notice = notices.join("\n");
  return content.length > 0 ? `${content}\n\n${notice}` : notice;
}
