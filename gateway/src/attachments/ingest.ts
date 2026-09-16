/**
 * Downloads and uploads inbound attachments with channel-specific size,
 * concurrency, and transient-error policies. Webhook channels rethrow
 * transient failures so Telegram and WhatsApp can redeliver; push channels
 * skip failures because Slack Socket Mode and Discord Gateway do not redeliver
 * messages.
 *
 * Every attachment the message carried is accounted for in the result: as an
 * uploaded id, as a name that could not be retrieved, or as a file too large
 * to receive. A file the person sent and the assistant never got is told to
 * both of them through the notice, never dropped in silence.
 */
import type { Logger } from "pino";

import type { GatewayInboundAttachment } from "../channels/inbound-event.js";
import type { AttachmentByteChannel, GatewayConfig } from "../config.js";
import type { UploadAttachmentInput } from "../runtime/client.js";

export type IngestibleAttachment = Omit<GatewayInboundAttachment, "type">;

export type DownloadedAttachment = Omit<UploadAttachmentInput, "trustedSource">;

export class AttachmentTooLargeError extends Error {
  override name = "AttachmentTooLargeError";
}

/** A file the platform reported as larger than the channel's cap. */
export type OversizedAttachment = {
  name: string;
  fileSize: number;
  limit: number;
};

export type AttachmentIngestResult = {
  attachmentIds: string[];
  failedAttachmentNames: string[];
  oversizedAttachments: OversizedAttachment[];
};

export async function ingestAttachments(
  config: GatewayConfig,
  channel: AttachmentByteChannel,
  attachments: readonly IngestibleAttachment[],
  log: Logger,
  options: {
    download: (
      attachment: IngestibleAttachment,
      maxBytes: number,
    ) => Promise<DownloadedAttachment>;
    upload: (downloaded: DownloadedAttachment) => Promise<{ id: string }>;
    failurePolicy:
      | { mode: "skip" }
      | {
          mode: "rethrow-unless-skippable";
          isSkippableError: (error: unknown) => boolean;
        };
  },
): Promise<AttachmentIngestResult> {
  const attachmentIds: string[] = [];
  const failedAttachmentNames: string[] = [];
  const oversizedAttachments: OversizedAttachment[] = [];
  const maxBytes =
    config.maxAttachmentBytes[channel] ?? config.maxAttachmentBytes.default;

  const eligible = attachments.filter((attachment) => {
    if (attachment.fileSize !== undefined && attachment.fileSize > maxBytes) {
      oversizedAttachments.push({
        name: attachment.fileName || attachment.fileId,
        fileSize: attachment.fileSize,
        limit: maxBytes,
      });
      log.warn(
        {
          fileId: attachment.fileId,
          fileSize: attachment.fileSize,
          limit: maxBytes,
        },
        `Skipping oversized ${channel} attachment`,
      );
      return false;
    }
    return true;
  });

  for (let i = 0; i < eligible.length; i += config.maxAttachmentConcurrency) {
    const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
    const results = await Promise.allSettled(
      batch.map(async (attachment) => {
        const downloaded = await options.download(attachment, maxBytes);
        return options.upload(downloaded);
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        attachmentIds.push(result.value.id);
        continue;
      }

      const attachment = batch[j];
      const shouldSkip =
        options.failurePolicy.mode === "skip" ||
        (options.failurePolicy.mode === "rethrow-unless-skippable" &&
          options.failurePolicy.isSkippableError(result.reason));
      if (shouldSkip) {
        failedAttachmentNames.push(attachment.fileName || attachment.fileId);
        log.warn(
          { err: result.reason, fileId: attachment.fileId },
          `Skipping ${channel} attachment`,
        );
        continue;
      }

      throw result.reason;
    }
  }

  return { attachmentIds, failedAttachmentNames, oversizedAttachments };
}

/**
 * Append the notices for every attachment the assistant did not receive to
 * the message content, so the model and the transcript both learn the file
 * existed. A retrieval failure asks for a re-send; an oversized file says so
 * with the cap, because re-sending the same file cannot help.
 */
export function appendFailedAttachmentNotice(
  content: string,
  result: Pick<
    AttachmentIngestResult,
    "failedAttachmentNames" | "oversizedAttachments"
  >,
): string {
  const notices: string[] = [];
  if (result.failedAttachmentNames.length > 0) {
    const nameList = result.failedAttachmentNames
      .map((name) => `"${name}"`)
      .join(", ");
    notices.push(
      `[The user attached file(s) that could not be retrieved: ${nameList}. Ask them to re-send if the content is important.]`,
    );
  }
  if (result.oversizedAttachments.length > 0) {
    const fileList = result.oversizedAttachments
      .map(
        (file) =>
          `"${file.name}" (${formatMegabytes(file.fileSize)}, over the ${formatMegabytes(file.limit)} limit)`,
      )
      .join(", ");
    notices.push(
      `[The user attached file(s) too large to receive: ${fileList}. Re-sending the same file will not help; if the content is important, ask for a smaller version or a link.]`,
    );
  }
  if (notices.length === 0) {
    return content;
  }
  const notice = notices.join("\n");
  return content.length > 0 ? `${content}\n\n${notice}` : notice;
}

/** Bytes as megabytes with at most one decimal, the unit every cap is set in. */
function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  const rounded = Math.round(megabytes * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}
