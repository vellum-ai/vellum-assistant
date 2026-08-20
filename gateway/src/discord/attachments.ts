/**
 * Normalizes Discord attachments and retains only entries with usable
 * downloadable references.
 */
import type { DiscordMessageCreate } from "./message-schemas.js";
import type { GatewayInboundAttachment } from "../channels/inbound-event.js";

type DiscordAttachment = NonNullable<
  DiscordMessageCreate["attachments"]
>[number];

export type DiscordAttachmentReference = DiscordAttachment & { url: string };

export type DiscordCanonicalAttachment = Omit<
  GatewayInboundAttachment,
  "type"
> & {
  type: Exclude<GatewayInboundAttachment["type"], "photo" | "sticker">;
};

function downloadableAttachments(
  attachments: DiscordAttachment[] | undefined,
): DiscordAttachmentReference[] {
  return (attachments ?? []).filter(
    (attachment): attachment is DiscordAttachmentReference =>
      attachment.id.length > 0 &&
      typeof attachment.url === "string" &&
      attachment.url.length > 0,
  );
}

function attachmentType(
  contentType: string | undefined,
): DiscordCanonicalAttachment["type"] {
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (contentType?.startsWith("video/")) {
    return "video";
  }
  if (contentType?.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

export function extractDiscordAttachments(
  attachments: DiscordAttachment[] | undefined,
): DiscordCanonicalAttachment[] {
  return downloadableAttachments(attachments).map((attachment) => ({
    type: attachmentType(attachment.content_type),
    fileId: attachment.id,
    ...(attachment.filename !== undefined
      ? { fileName: attachment.filename }
      : {}),
    ...(attachment.content_type !== undefined
      ? { mimeType: attachment.content_type }
      : {}),
    ...(attachment.size !== undefined ? { fileSize: attachment.size } : {}),
  }));
}

export function extractDiscordAttachmentMap(
  attachments: DiscordAttachment[] | undefined,
): Map<string, DiscordAttachmentReference> | undefined {
  const downloadable = downloadableAttachments(attachments);
  return downloadable.length > 0
    ? new Map(downloadable.map((attachment) => [attachment.id, attachment]))
    : undefined;
}
