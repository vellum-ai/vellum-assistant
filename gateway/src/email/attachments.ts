import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import {
  AttachmentValidationError,
  uploadAttachment,
} from "../runtime/client.js";
import type { EmailAttachment } from "./normalize.js";
import {
  type AttachmentIngestResult,
  type OversizedAttachment,
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
 * Attachments larger than the email per-file cap are reported as oversized.
 * Validation failures (unsupported MIME type, dangerous extension) are
 * skipped so a single bad attachment never drops the user's email; transient failures
 * (upload 5xx, network) are propagated so the caller can surface an error and
 * let the upstream retry the delivery.
 */
export async function ingestEmailAttachments(
  config: GatewayConfig,
  attachments: EmailAttachment[] | undefined,
  log: Logger,
): Promise<EmailAttachmentIngestResult> {
  const attachmentIds: string[] = [];
  const failedAttachmentNames: string[] = [];
  const oversizedAttachments: OversizedAttachment[] = [];

  if (!attachments || attachments.length === 0) {
    return { attachmentIds, failedAttachmentNames, oversizedAttachments };
  }

  const maxBytes =
    config.maxAttachmentBytes.email ?? config.maxAttachmentBytes.default;

  const eligible = attachments.filter((att) => {
    const bytes = att.size ?? estimateBase64Bytes(att.content);
    if (bytes > maxBytes) {
      log.warn(
        { filename: att.filename, bytes, limit: maxBytes },
        "Skipping oversized email attachment",
      );
      oversizedAttachments.push({
        name: att.filename,
        fileSize: bytes,
        limit: maxBytes,
      });
      return false;
    }
    return true;
  });

  // Bounded concurrency mirrors the other channel webhooks so a message with
  // many attachments does not open an unbounded number of upstream requests.
  for (let i = 0; i < eligible.length; i += config.maxAttachmentConcurrency) {
    const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
    const results = await Promise.allSettled(
      batch.map((att) =>
        uploadAttachment(config, {
          filename: att.filename,
          mimeType: att.contentType,
          data: att.content,
        }),
      ),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        attachmentIds.push(result.value.id);
      } else if (result.reason instanceof AttachmentValidationError) {
        log.warn(
          { err: result.reason, filename: batch[j].filename },
          "Skipping email attachment with validation error",
        );
        failedAttachmentNames.push(batch[j].filename);
      } else {
        // Transient failure — propagate so the caller returns an error and the
        // upstream retries the whole delivery rather than silently dropping.
        throw result.reason;
      }
    }
  }

  return { attachmentIds, failedAttachmentNames, oversizedAttachments };
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
