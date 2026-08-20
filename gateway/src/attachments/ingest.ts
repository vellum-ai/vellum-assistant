/**
 * Downloads and uploads inbound attachments with channel-specific size,
 * concurrency, and transient-error policies. Webhook channels rethrow
 * transient failures so Telegram and WhatsApp can redeliver; push channels
 * skip failures because Slack Socket Mode and Discord Gateway do not redeliver
 * messages.
 */
import type { Logger } from "pino";

import type { GatewayConfig } from "../config.js";

export type IngestibleAttachment = {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
};

export type DownloadedAttachment = {
  filename: string;
  mimeType: string;
  data: string;
};

export type AttachmentIngestResult = {
  attachmentIds: string[];
  failedAttachmentNames: string[];
};

export async function ingestAttachments(
  config: GatewayConfig,
  channel: string,
  attachments: readonly IngestibleAttachment[],
  log: Logger,
  options: {
    download: (
      attachment: IngestibleAttachment,
    ) => Promise<DownloadedAttachment>;
    upload: (downloaded: DownloadedAttachment) => Promise<{ id: string }>;
    rethrowTransientErrors: boolean;
    isSkippableError?: (error: unknown) => boolean;
    logLabel?: string;
  },
): Promise<AttachmentIngestResult> {
  const attachmentIds: string[] = [];
  const failedAttachmentNames: string[] = [];
  const maxBytes =
    config.maxAttachmentBytes[channel] ?? config.maxAttachmentBytes.default;

  const eligible = attachments.filter((attachment) => {
    if (attachment.fileSize !== undefined && attachment.fileSize > maxBytes) {
      log.warn(
        {
          fileId: attachment.fileId,
          fileSize: attachment.fileSize,
          limit: maxBytes,
        },
        `Skipping oversized ${options.logLabel ?? channel} attachment`,
      );
      return false;
    }
    return true;
  });

  for (let i = 0; i < eligible.length; i += config.maxAttachmentConcurrency) {
    const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
    const results = await Promise.allSettled(
      batch.map(async (attachment) => {
        const downloaded = await options.download(attachment);
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
      if (
        !options.rethrowTransientErrors ||
        options.isSkippableError?.(result.reason) === true
      ) {
        failedAttachmentNames.push(attachment.fileName || attachment.fileId);
        log.warn(
          { err: result.reason, fileId: attachment.fileId },
          `Skipping ${options.logLabel ?? channel} attachment`,
        );
        continue;
      }

      throw result.reason;
    }
  }

  return { attachmentIds, failedAttachmentNames };
}

export function appendFailedAttachmentNotice(
  content: string,
  failedAttachmentNames: readonly string[],
): string {
  if (failedAttachmentNames.length === 0) {
    return content;
  }
  const nameList = failedAttachmentNames.map((name) => `"${name}"`).join(", ");
  const notice = `[The user attached file(s) that could not be retrieved: ${nameList}. Ask them to re-send if the content is important.]`;
  return content.length > 0 ? `${content}\n\n${notice}` : notice;
}
