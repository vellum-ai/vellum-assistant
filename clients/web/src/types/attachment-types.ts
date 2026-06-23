import type { AttachmentsByIdGetResponse } from "@/generated/daemon/types.gen";

/**
 * Server-canonical attachment metadata, sourced from the daemon's generated
 * attachment schema — the single source of truth for these field names/types.
 * Do not re-declare `id`/`filename`/`mimeType`/`sizeBytes` by hand; if a field
 * is wrong or missing, fix the route `responseBody` schema and regenerate.
 */
export type AttachmentMetadata = Pick<
  AttachmentsByIdGetResponse,
  "id" | "filename" | "mimeType" | "sizeBytes"
>;

/** Display metadata for a file attachment (user-uploaded or assistant-generated),
 *  used to render the chip inside a message bubble. For live sessions, populated
 *  from SSE event data via `toDisplayAttachments` (`utils/display-attachments.ts`). For
 *  history reload, populated from the daemon's structured attachment metadata
 *  (real UUIDs that resolve against the content endpoint) or, as a fallback,
 *  reverse-parsed from `[File attachment] …` summary lines in the message text. */
export interface DisplayAttachment extends AttachmentMetadata {
  /** Client-only blob URL for an in-flight/optimistic preview. */
  previewUrl: string | null;
}
