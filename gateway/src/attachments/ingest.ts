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

/**
 * The bytes exceeded the channel's cap. Carries the cap and, when the
 * provider or the response stated one, the file's size, so the notice can
 * name both. Absent when the stream simply ran past the cap.
 */
export class AttachmentTooLargeError extends Error {
  override name = "AttachmentTooLargeError";
  readonly limit: number;
  readonly fileSize: number | undefined;

  constructor(
    message: string,
    size: { limit: number; fileSize?: number | undefined },
  ) {
    super(message);
    this.limit = size.limit;
    this.fileSize = size.fileSize;
  }
}

/** A file larger than the channel's cap, whether the provider said so before the download or the bytes said so during it. */
export type OversizedAttachment = {
  name: string;
  /** Absent when only the stream's overflow is known, not the true size. */
  fileSize?: number;
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
      const name = attachment.fileName || attachment.fileId;

      // A provider that omitted or understated the size is caught by the
      // download layer instead. Too large is never transient, so it is
      // accounted for before the failure policy is consulted, under either
      // policy.
      if (result.reason instanceof AttachmentTooLargeError) {
        oversizedAttachments.push({
          name,
          ...(result.reason.fileSize !== undefined
            ? { fileSize: result.reason.fileSize }
            : {}),
          limit: result.reason.limit,
        });
        log.warn(
          {
            fileId: attachment.fileId,
            fileSize: result.reason.fileSize,
            limit: result.reason.limit,
          },
          `Skipping oversized ${channel} attachment`,
        );
        continue;
      }

      const shouldSkip =
        options.failurePolicy.mode === "skip" ||
        (options.failurePolicy.mode === "rethrow-unless-skippable" &&
          options.failurePolicy.isSkippableError(result.reason));
      if (shouldSkip) {
        failedAttachmentNames.push(name);
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

/**
 * The one line every channel's notice uses for files too large to receive,
 * so email's separate ingester says the same thing with the same numbers.
 * Undefined when there is nothing to say.
 */
export function oversizedAttachmentNotice(
  files: readonly OversizedAttachment[],
): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const fileList = files
    .map((file) => `"${file.name}" (${describeOversize(file)})`)
    .join(", ");
  return `[The user attached file(s) too large to receive: ${fileList}. Re-sending the same file will not help; if the content is important, ask for a smaller version or a link.]`;
}

/**
 * "60 MB, over the 20 MB limit", or "over the 20 MB limit" when only the
 * overflow is known. The size rounds up and the cap rounds to the nearest
 * tenth, so a file one byte over a whole-megabyte cap reads as larger than
 * the cap rather than equal to it; every cap is a whole number of megabytes
 * (`maxAttachmentBytes` in config.ts), so the cap never rounds away from
 * itself.
 */
function describeOversize(file: OversizedAttachment): string {
  const limit = `over the ${formatCap(file.limit)} limit`;
  return file.fileSize === undefined
    ? limit
    : `${formatSize(file.fileSize)}, ${limit}`;
}

/** A file's size in megabytes, rounded up to a tenth. */
function formatSize(bytes: number): string {
  return formatMegabytes(Math.ceil(tenthsOfMegabytes(bytes)));
}

/** A cap in megabytes, rounded to the nearest tenth. */
function formatCap(bytes: number): string {
  return formatMegabytes(Math.round(tenthsOfMegabytes(bytes)));
}

function tenthsOfMegabytes(bytes: number): number {
  return (bytes / (1024 * 1024)) * 10;
}

function formatMegabytes(tenths: number): string {
  const megabytes = tenths / 10;
  return `${Number.isInteger(megabytes) ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}
