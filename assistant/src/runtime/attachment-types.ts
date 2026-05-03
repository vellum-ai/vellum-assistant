/**
 * Attachment metadata types shared across runtime and messaging providers.
 *
 * Extracted as a leaf module so messaging providers (slack, telegram, whatsapp)
 * can reference RuntimeAttachmentMetadata without importing from http-types.ts,
 * which imports daemon/conversation.ts and pulls the full daemon graph into
 * the messaging provider cycle chain.
 */

export interface RuntimeAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  data?: string;
  thumbnailData?: string;
  fileBacked?: boolean;
}
